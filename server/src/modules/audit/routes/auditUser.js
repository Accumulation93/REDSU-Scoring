const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/routes/auditUser');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const { safeString, generateId } = require('../../../utils/helpers');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pool = require('../../../config/db');
const hrInfoModel = require('../../../core/models/hrInfo');
const flowTemplateModel = require('../models/auditFlowTemplate');

const flowTemplateStepModel = require('../models/auditFlowTemplateStep');
const flowTemplateStepConditionModel = require('../models/auditFlowTemplateStepCondition');
const submissionModel = require('../models/auditSubmission');
const submissionStepModel = require('../models/auditSubmissionStep');
const submissionFileModel = require('../models/auditSubmissionFile');
const submissionSignatureModel = require('../models/auditSubmissionSignature');
const auditEventModel = require('../models/auditEvent');
const signingEvidenceModel = require('../models/signingEvidence');
const { prepareEvidence } = require('../services/approvalSigningEvidence');
const { SigningProtocolError } = require('../utils/signingProtocol');
const signingCopy = require('../../../locales/zh-CN/auditSigningEvidence');
const stampAssignmentModel = require('../models/identityStampAssignment');
const { hashFile } = require('../utils/hashChain');
const { attachUploadedFiles } = require('../utils/fileSecurity');
const { overlaySignaturesOnBuffer } = require('../utils/signatureOverlay');
const {
  AUDIT_APPROVAL_INTEGRITY_CODES,
  AuditApprovalIntegrityError,
  resolveApprovalMaterials,
  groupApprovalMaterialsByFile,
  loadApprovalFileFacts,
  createDigitalSignatureMaterial,
  buildSignatureChainRecords
} = require('../services/auditApprovalIntegrity');
const {
  AuditFileCommitError,
  createAuditFileCommit
} = require('../services/auditFileCommitCoordinator');
const { createNotification } = require('../utils/notificationHelper');
const requestDeduplication = require('../../../utils/requestDeduplication');
const { resolveCurrentActor } = require('../../../core/services/currentActor');
const unifiedIdentityModel = require('../../../core/models/unifiedIdentity');
const {
  assignmentSnapshot,
  listActiveAssignments,
  resolveActorAssignment,
  resolveActorAssignmentForUpdate,
  getSubmissionSubmitterAssignments,
  groupEligibleCandidates,
  parseSnapshot
} = require('../services/auditAssignmentContext');
const {
  validateBindings,
  resolveAndValidateBindings
} = require('../services/auditPersonAssignmentCondition');
const {
  eventMatchesAssignment,
  submissionMatchesSubmitterAssignment,
  assignmentSqlExpression
} = require('../services/auditHistoryScope');
const {
  validateConditionShape,
  validateStepShape,
  isValidResubmitMode,
  stripDesignationOverrides,
  applyDesignationOverride,
  effectiveConditionsForAuthorization
} = require('../services/auditWorkflowPolicy');

const { matchesAnyCondition } = submissionStepModel;

/**
 * Helper: check if a value exists in a comma-separated list.
 * Both inputs are coerced to strings for robust comparison.
 */
function inCsv(csv, value) {
  if (csv == null || value == null) return false;
  let csvStr = String(csv).trim();
  let valStr = String(value).trim();
  if (!csvStr || !valStr) return false;
  return csvStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean).includes(valStr);
}

function normalizeStepOverrides(rawOverrides) {
  const raw = Array.isArray(rawOverrides) ? rawOverrides : [];
  const legacyZeroBased = raw.some(function(item) {
    return Number(item && item.stepIndex) === 0;
  });
  return raw.map(function(item) {
    const override = Object.assign({}, item);
    const rawIndex = Number(override.stepIndex);
    override.stepIndex = legacyZeroBased && Number.isInteger(rawIndex) ? rawIndex + 1 : rawIndex;
    override.personHrIds = Array.isArray(override.personHrIds)
      ? [...new Set(override.personHrIds.map(function(id) { return safeString(id); }).filter(Boolean))]
      : [];
    override.assignmentIds = Array.isArray(override.assignmentIds)
      ? [...new Set(override.assignmentIds.map(function(id) { return safeString(id); }).filter(Boolean))]
      : [];
    return override;
  });
}

async function narrowTemplateStepConditions(conditions, personHrIds, assignmentIds, submitterInfo, orgId, db) {
  const requestedIds = [...new Set((Array.isArray(personHrIds) ? personHrIds : [])
    .map(function(id) { return safeString(id); }).filter(Boolean))];
  const requestedAssignmentIds = [...new Set((Array.isArray(assignmentIds) ? assignmentIds : [])
    .map(function(id) { return safeString(id); }).filter(Boolean))];
  if (!requestedIds.length && !requestedAssignmentIds.length) return conditions;
  if (!requestedIds.length || !requestedAssignmentIds.length) {
    const missingBindingError = new Error(localeCopy.copy_db47f6c08b);
    missingBindingError.code = 'assignment_binding_required';
    throw missingBindingError;
  }

  const originalConditions = stripDesignationOverrides(conditions);
  if (!originalConditions.length) {
    const missingConditionsError = new Error(localeCopy.copy_e6048310d4);
    missingConditionsError.code = 'AUDIT_STEP_CONDITIONS_REQUIRED';
    throw missingConditionsError;
  }

  const assignments = await listActiveAssignments(orgId, { hrIds: requestedIds }, db);
  const binding = validateBindings({
    personHrIds: requestedIds,
    assignmentIds: requestedAssignmentIds
  }, assignments);
  if (!binding.ok) {
    const invalidBindingError = new Error(localeCopy.copy_db47f6c08b);
    invalidBindingError.code = binding.reason;
    throw invalidBindingError;
  }

  const selectedAssignmentSet = new Set(requestedAssignmentIds);
  const selectedAssignments = assignments.filter(function(assignment) {
    return selectedAssignmentSet.has(safeString(assignment.assignment_id));
  });
  const eligibleAssignments = selectedAssignments.filter(function(assignment) {
    return matchesAnyCondition(originalConditions, assignment, submitterInfo);
  });
  if (eligibleAssignments.length !== requestedAssignmentIds.length) {
    throw new Error(localeCopy.copy_db47f6c08b);
  }

  const assignmentsByHrId = new Map();
  eligibleAssignments.forEach(function(assignment) {
    const hrId = safeString(assignment.hr_id);
    if (!assignmentsByHrId.has(hrId)) assignmentsByHrId.set(hrId, []);
    assignmentsByHrId.get(hrId).push(safeString(assignment.assignment_id));
  });

  const narrowedConditions = [];
  for (let i = 0; i < requestedIds.length; i++) {
    const selectedPersonAssignments = assignmentsByHrId.get(requestedIds[i]) || [];
    if (!selectedPersonAssignments.length) throw new Error(localeCopy.copy_db47f6c08b);
    narrowedConditions.push({
      conditionType: 'person',
      personHrIds: requestedIds[i],
      assignmentIds: selectedPersonAssignments.join(','),
      departmentScope: null,
      specificDepartmentId: null,
      workGroupScope: null,
      specificWorkGroupId: null,
      identityScope: null,
      specificIdentityId: null
    });
  }
  return applyDesignationOverride(originalConditions, narrowedConditions);
}

function buildTemplateConditionMap(allConditions) {
  const map = {};
  (Array.isArray(allConditions) ? allConditions : []).forEach(function(condition) {
    const stepId = condition.template_step_id;
    if (!map[stepId]) map[stepId] = [];
    map[stepId].push({
      conditionType: condition.condition_type,
      personHrIds: condition.person_hr_ids,
      assignmentIds: condition.assignment_ids,
      departmentScope: condition.department_scope,
      specificDepartmentId: condition.specific_department_id,
      workGroupScope: condition.work_group_scope,
      specificWorkGroupId: condition.specific_work_group_id,
      identityScope: condition.identity_scope,
      specificIdentityId: condition.specific_identity_id
    });
  });
  return map;
}

function parseConditionsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function assertValidWorkflowStep(step) {
  const result = validateStepShape(step);
  if (result.ok) return;
  const error = new Error(
    result.reason === 'step_action_invalid'
      ? localeCopy.approvalActionInvalid
      : localeCopy.copy_e6048310d4
  );
  error.code = result.reason === 'step_action_invalid'
    ? 'approval_action_invalid'
    : 'AUDIT_STEP_CONDITIONS_REQUIRED';
  throw error;
}

async function normalizePersonConditionsForPersistence(conditions, orgId, db) {
  const normalized = [];
  for (const condition of Array.isArray(conditions) ? conditions : []) {
    if (!condition || condition.conditionType !== 'person') {
      normalized.push(Object.assign({}, condition));
      continue;
    }
    const binding = await resolveAndValidateBindings(condition, orgId, db);
    if (!binding.ok) {
      const error = new Error(localeCopy.copy_db47f6c08b);
      error.code = binding.reason;
      throw error;
    }
    const assignmentIds = new Set(safeString(binding.condition.assignmentIds).split(',').filter(Boolean));
    const assignments = await listActiveAssignments(orgId, {
      hrIds: safeString(binding.condition.personHrIds).split(',').filter(Boolean)
    }, db);
    await unifiedIdentityModel.lockActiveBusinessSubjects(db, assignments
      .filter((assignment) => assignmentIds.has(safeString(assignment.assignment_id)))
      .map((assignment) => ({
        personId: safeString(assignment.person_id),
        legacyHrId: safeString(assignment.hr_id),
        organizationId: orgId,
        assignmentId: safeString(assignment.assignment_id)
      })));
    normalized.push(Object.assign({}, condition, {
      personHrIds: binding.condition.personHrIds,
      assignmentIds: binding.condition.assignmentIds
    }));
  }
  return normalized;
}

async function lockAuditActor(connection, assignment, organizationId) {
  await unifiedIdentityModel.lockActiveBusinessSubjects(connection, [{
    personId: safeString(assignment && assignment.person_id),
    legacyHrId: safeString(assignment && assignment.hr_id),
    organizationId,
    assignmentId: safeString(assignment && assignment.assignment_id)
  }]);
}

async function lockAuditAssignmentIds(connection, assignmentIds, organizationId) {
  const ids = [...new Set((Array.isArray(assignmentIds) ? assignmentIds : [])
    .map(function(id) { return safeString(id); }).filter(Boolean))];
  if (!ids.length) return;
  await unifiedIdentityModel.lockActiveBusinessSubjects(connection, ids.map(function(assignmentId) {
    return { organizationId, assignmentId };
  }));
}

function buildAuditOperatorContext(req, assignment) {
  const context = req.authContext || {};
  return {
    operatorPersonId: safeString(assignment && assignment.person_id) || safeString(context.personId),
    operatorAssignmentId: safeString(assignment && assignment.assignment_id) || safeString(context.assignmentId),
    operatorAdminGrantId: safeString(context.adminGrantId),
    operatorContextSnapshot: assignment
      ? assignmentSnapshot(assignment, context)
      : (context.contextId ? {
        contextId: safeString(context.contextId),
        organizationId: safeString(context.organizationId),
        role: safeString(context.role),
        adminGrantId: safeString(context.adminGrantId),
        adminLevel: safeString(context.adminLevel)
      } : null)
  };
}

async function resolveAuditAssignmentActor(req, db) {
  const actorResult = await resolveCurrentActor(req);
  if (!actorResult.ok || actorResult.actor.type !== 'user') {
    return { ok: false, actorResult };
  }
  const orgId = await getCurrentOrgId();
  const assignment = await resolveActorAssignment(actorResult.actor, orgId, db);
  if (!assignment) return { ok: false, actorResult };
  return { ok: true, actor: actorResult.actor, assignment, orgId };
}

async function lockAndRefreshAuditActor(connection, actorContext) {
  await lockAuditActor(connection, actorContext.assignment, actorContext.orgId);
  return resolveActorAssignmentForUpdate(
    actorContext.actor,
    actorContext.orgId,
    connection
  );
}

function matchesStarter(template, starterConditions, assignment) {
  if (starterConditions.length) {
    return matchesAnyCondition(starterConditions, assignment, assignment);
  }
  if (template.starter_type === 'identity' && template.starter_identity_id) {
    return inCsv(template.starter_identity_id, assignment.identity_id);
  }
  if (template.starter_type === 'specific_person' && template.starter_hr_id) {
    return false;
  }
  return template.starter_type === 'self' || !safeString(template.starter_type);
}

// ═══════════════════════════════════════════════════
// My Submissions
// ═══════════════════════════════════════════════════

// listMySubmissions
router.post('/listMySubmissions', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const hrId = actorContext.assignment.hr_id;

    const filters = {
      submittedBy: hrId,
      submittedAssignmentId: actorContext.assignment.assignment_id,
      status: safeString(req.body.status) || null,
      limit: Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 50)),
      offset: Math.max(0, parseInt(req.body.offset, 10) || 0)
    };

    const submissions = await submissionModel.getAll(filters);
    const submissionIds = submissions.map(s => s.id);
    const orgId = await getCurrentOrgId();

    // Get read cursors
    let cursorMap = {};
    if (submissionIds.length) {
      const [cursors] = await pool.query(
        'SELECT submission_id, last_read_status, last_read_step_index FROM audit_read_cursors WHERE org_id = ? AND hr_id = ? AND submission_id IN (?)',
        [orgId, hrId, submissionIds]
      );
      cursors.forEach(c => { cursorMap[c.submission_id] = c; });
    }

    const result = submissions.map((s) => {
      const c = cursorMap[s.id];
      const isUnread = !c || c.last_read_status !== s.status || c.last_read_step_index !== s.current_step_index;
      return {
        id: safeString(s.id),
        submissionNumber: safeString(s.submission_number),
        title: safeString(s.title),
        description: safeString(s.description),
        type: safeString(s.type),
        status: safeString(s.status),
        currentStepIndex: s.current_step_index,
        resubmitMode: safeString(s.resubmit_mode),
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        isUnread
      };
    });

    res.json({ status: 'success', submissions: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// checkPendingCount — Lightweight poll: returns count + latest timestamp only
// Used by the mini-program for periodic background refresh without loading full list
router.post('/checkPendingCount', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const steps = await submissionStepModel.getPendingByApprover(actorContext.actor, actorContext.assignment);
    const count = steps.length;
    const latestAt = count > 0 ? steps[0].created_at : null; // Already sorted DESC in model

    res.json({ status: 'success', count, latestAt });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// listPendingApprovals — Submissions waiting for the current user to approve
router.post('/listPendingApprovals', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const steps = await submissionStepModel.getPendingByApprover(actorContext.actor, actorContext.assignment);

    // Load submitter names
    const submitterIds = [...new Set(steps.map((s) => s.submitted_by))];
    const hrMap = {};
    if (submitterIds.length) {
      const hrRows = await hrInfoModel.getByIds(submitterIds);
      for (const hr of hrRows) hrMap[hr.id] = safeString(hr.name);
    }

    const result = steps.map((s) => ({
      id: safeString(s.id),
      submissionId: safeString(s.submission_id),
      submissionNumber: safeString(s.submission_number),
      title: safeString(s.title),
      submittedBy: safeString(s.submitted_by),
      submitterName: hrMap[s.submitted_by] || localeCopy.copy_8d3451355b,
      sortOrder: s.sort_order,
      approverType: safeString(s.approver_type),
      approverIdentityId: safeString(s.approver_identity_id),
      scopeType: safeString(s.scope_type),
      actionType: safeString(s.action_type),
      round: s.round,
      createdAt: s.created_at,
      stepConditionsJson: s.step_conditions_json || null
    }));

    res.json({ status: 'success', pending: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Start Submission
// ═══════════════════════════════════════════════════

// startAuditSubmission — Create a new submission from a template
router.post('/startAuditSubmission', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const openid = req.openid;
    const actorContext = await resolveAuditAssignmentActor(req, conn);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    let submitterFull = actorContext.assignment;
    const hrId = submitterFull.hr_id;
    const orgId = await getCurrentOrgId();
    if (orgId !== actorContext.orgId) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_4e84385ce1 });
    }

    const templateId = safeString(req.body.templateId);
    const title = safeString(req.body.title);
    const description = safeString(req.body.description);
    const uploadedFiles = Array.isArray(req.body.files) ? req.body.files : [];
    const stepOverrides = normalizeStepOverrides(req.body.stepOverrides);

    if (!templateId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_0172f60994 });
    }
    if (!title) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_625e93775b });
    }
    if (!uploadedFiles.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_e472aa139d });
    }

    // Load template
    let template = await flowTemplateModel.getById(templateId);
    if (!template) {
      return res.json({ status: 'not_found', message: localeCopy.copy_bb180253a4 });
    }
    if (!template.is_active) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_479f3dbce7 });
    }
    if (!isValidResubmitMode(safeString(template.resubmit_mode))) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_f428da1450 });
    }

    // Parse starter conditions
    let starterConditions = [];
    if (template.starter_conditions_json) {
      try { starterConditions = JSON.parse(template.starter_conditions_json); } catch (_) {}
    }
    if (!Array.isArray(starterConditions)) starterConditions = [];

    if (!matchesStarter(template, starterConditions, submitterFull)) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_bc75efaa89 });
    }

    let templateSteps = await flowTemplateStepModel.getByTemplateId(templateId);
    if (!templateSteps.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_f428da1450 });
    }

    const requestedOverrides = stepOverrides.filter(function(o) {
      return o.personHrIds.length > 0 || o.assignmentIds.length > 0;
    });
    if (requestedOverrides.some(function(o) {
      return !o.personHrIds.length || !o.assignmentIds.length;
    })) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_db47f6c08b });
    }
    if (requestedOverrides.some(function(o) { return Number(o.stepIndex) !== 1; })) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_2f878cb2da });
    }
    if (requestedOverrides.length > 1) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_addeccf69a });
    }
    if (requestedOverrides.length && Number(templateSteps[0].allow_approver_designation) !== 1) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_670f4a48f1 });
    }

    await conn.beginTransaction();
    submitterFull = await lockAndRefreshAuditActor(conn, actorContext);
    template = await flowTemplateModel.getByIdForUpdate(templateId, conn);
    starterConditions = [];
    if (template && template.starter_conditions_json) {
      try { starterConditions = JSON.parse(template.starter_conditions_json); } catch (_) { starterConditions = []; }
    }
    if (!Array.isArray(starterConditions)) starterConditions = [];
    templateSteps = template ? await flowTemplateStepModel.getByTemplateId(templateId, conn) : [];
    if (!submitterFull || !template || !template.is_active
      || !isValidResubmitMode(safeString(template.resubmit_mode))
      || !templateSteps.length
      || !matchesStarter(template, starterConditions, submitterFull)) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_bc75efaa89 });
    }
    if (requestedOverrides.length && Number(templateSteps[0].allow_approver_designation) !== 1) {
      await conn.rollback();
      return res.json({ status: 'invalid_params', message: localeCopy.copy_670f4a48f1 });
    }
    await lockAuditAssignmentIds(conn, requestedOverrides.flatMap(function(item) {
      return item.assignmentIds;
    }), orgId);

    // Create submission
    const submissionId = generateId();
    const dedupClaim = await requestDeduplication.claim(conn, {
      orgId,
      actorKey: 'user:' + hrId,
      operationType: 'start_audit',
      clientRequestId: req.body.clientRequestId,
      resourceId: submissionId
    });
    if (!dedupClaim.claimed) {
      await conn.commit();
      return res.json(dedupClaim.response || {
        status: 'success', id: dedupClaim.resourceId, message: localeCopy.copy_16580ff4c7, idempotent: true
      });
    }
    const submissionNumber = await submissionModel.generateSubmissionNumber(conn);
    await submissionModel.create(submissionId, {
      submissionNumber,
      submittedBy: hrId,
      submittedPersonId: submitterFull.person_id,
      submittedAssignmentId: submitterFull.assignment_id,
      submittedContextSnapshot: assignmentSnapshot(submitterFull, req.authContext),
      type: 'template',
      templateId,
      title,
      description,
      status: 'in_progress',
      currentStepIndex: 1,
      resubmitMode: template.resubmit_mode
    }, conn);

    await attachUploadedFiles({ uploadedFiles, submissionId, openid, conn });

    // Load conditions for all template steps from the same locked template snapshot.
    const allConditions = await flowTemplateStepConditionModel.getByTemplateId(templateId, conn);

    const stepConditionMap = {};
    for (const c of allConditions) {
      const sid = c.template_step_id;
      if (!stepConditionMap[sid]) stepConditionMap[sid] = [];
      stepConditionMap[sid].push({
        id: c.id,
        sortOrder: c.sort_order,
        conditionType: c.condition_type,
        personHrIds: c.person_hr_ids,
        assignmentIds: c.assignment_ids,
        departmentScope: c.department_scope,
        specificDepartmentId: c.specific_department_id,
        workGroupScope: c.work_group_scope,
        specificWorkGroupId: c.specific_work_group_id,
        identityScope: c.identity_scope,
        specificIdentityId: c.specific_identity_id
      });
    }

    // Create submission steps from template steps
    for (let i = 0; i < templateSteps.length; i++) {
      const ts = templateSteps[i];
      const stepId = generateId();

      // Build resolved conditions JSON from template step conditions
      let conditions = (stepConditionMap[ts.id] || []).map(function(condition) {
        return Object.assign({}, condition);
      });

      // Apply person overrides from submitter (specific person selection).
      // NARROW the scope: only designated persons can approve this step,
      // but they must be eligible under the original conditions (can't expand).
      const stepOverride = stepOverrides.find(function(o) {
        return i === 0 && Number(ts.allow_approver_designation) === 1 && Number(o.stepIndex) === 1;
      });
      if (stepOverride && stepOverride.personHrIds && stepOverride.personHrIds.length) {
        const narrowed = await narrowTemplateStepConditions(
          conditions,
          stepOverride.personHrIds,
          stepOverride.assignmentIds,
          submitterFull,
          orgId,
          conn
        );
        conditions.length = 0;
        narrowed.forEach(function(condition) { conditions.push(condition); });
      }

      assertValidWorkflowStep({ actionType: ts.action_type, conditions });

      conditions = await normalizePersonConditionsForPersistence(conditions, orgId, conn);

      if (!conditions.length && ts.approver_type === 'specific_person') {
        throw new Error(localeCopy.copy_db47f6c08b);
      }

      let stepConditionsJson = null;
      if (conditions.length > 0) {
        stepConditionsJson = JSON.stringify(conditions);
      }
      if (!conditions.length && !ts.approver_hr_id && !ts.approver_identity_id) {
        const configError = new Error(localeCopy.copy_e6048310d4);
        configError.code = 'AUDIT_STEP_CONDITIONS_REQUIRED';
        throw configError;
      }
      // Legacy: resolve approver_hr_id for specific_person type
      let approverHrId = null;
      if (ts.approver_type === 'specific_person' && ts.approver_hr_id) {
        approverHrId = ts.approver_hr_id;
      }

      await submissionStepModel.create(stepId, {
        submissionId,
        templateStepId: ts.id,
        sortOrder: i + 1,
        approverType: ts.approver_type,
        approverHrId,
        approverIdentityId: ts.approver_identity_id,
        actionType: ts.action_type,
        allowApproverDesignation: Number(ts.allow_approver_designation) === 1,
        stepName: ts.name || '',
        round: 1,
        stepConditionsJson
      }, conn);
    }

    // Insert submit event
    const submitterName = submitterFull.name;
    await auditEventModel.create(generateId(), {
      ...buildAuditOperatorContext(req, submitterFull),
      submissionId,
      eventType: 'submit',
      stepIndex: null,
      round: 1,
      operatorHrId: hrId,
      operatorName: submitterName,
      comment: null
    }, conn);

    const response = {
      status: 'success',
      id: submissionId,
      submissionNumber,
      message: localeCopy.copy_5a31c906d7
    };
    await requestDeduplication.complete(conn, {
      ...dedupClaim,
      resourceId: submissionId,
      orgId,
      actorKey: 'user:' + hrId,
      operationType: 'start_audit'
    }, response);
    await conn.commit();
    res.json(response);
  } catch (e) {
    await conn.rollback();
    if (e && e.code === 'AUDIT_STEP_CONDITIONS_REQUIRED') {
      return res.json({ status: 'invalid_params', message: e.message });
    }
    if (e && e.code === 'INVALID_CLIENT_REQUEST_ID') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_9713c4ccf5 });
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// startAdHocAudit — Start an ad-hoc (temporary) approval flow
router.post('/startAdHocAudit', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const openid = req.openid;
    const actorContext = await resolveAuditAssignmentActor(req, conn);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    let submitterAssignment = actorContext.assignment;
    const hrId = submitterAssignment.hr_id;
    const orgId = actorContext.orgId;

    const title = safeString(req.body.title);
    const description = safeString(req.body.description);
    const resubmitMode = safeString(req.body.resubmitMode) || 'fresh';
    const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
    const uploadedFiles = Array.isArray(req.body.files) ? req.body.files : [];

    if (!title) return res.json({ status: 'invalid_params', message: localeCopy.copy_625e93775b });
    if (!steps.length) return res.json({ status: 'invalid_params', message: localeCopy.copy_72870ab41e });
    if (!uploadedFiles.length) return res.json({ status: 'invalid_params', message: localeCopy.copy_e472aa139d });
    if (!isValidResubmitMode(resubmitMode)) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_d537fa2510 });
    }

    await conn.beginTransaction();
    submitterAssignment = await lockAndRefreshAuditActor(conn, actorContext);
    if (!submitterAssignment) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_4e84385ce1 });
    }
    await lockAuditAssignmentIds(conn, steps.flatMap(function(step) {
      const conditions = Array.isArray(step && step.conditions) ? step.conditions : [];
      return conditions.flatMap(function(condition) {
        const ids = condition && (condition.assignmentIds || condition.assignment_ids);
        return Array.isArray(ids) ? ids : safeString(ids).split(',');
      });
    }), orgId);

    const submissionId = generateId();
    const dedupClaim = await requestDeduplication.claim(conn, {
      orgId,
      actorKey: 'user:' + hrId,
      operationType: 'start_ad_hoc_audit',
      clientRequestId: req.body.clientRequestId,
      resourceId: submissionId
    });
    if (!dedupClaim.claimed) {
      await conn.commit();
      return res.json(dedupClaim.response || {
        status: 'success', id: dedupClaim.resourceId, message: localeCopy.copy_828cc5bcd7, idempotent: true
      });
    }
    const submissionNumber = await submissionModel.generateSubmissionNumber(conn);
    await submissionModel.create(submissionId, {
      submissionNumber,
      submittedBy: hrId,
      submittedPersonId: submitterAssignment.person_id,
      submittedAssignmentId: submitterAssignment.assignment_id,
      submittedContextSnapshot: assignmentSnapshot(submitterAssignment, req.authContext),
      type: 'ad_hoc',
      templateId: null,
      title,
      description,
      status: 'in_progress',
      currentStepIndex: 1,
      resubmitMode
    }, conn);

    await attachUploadedFiles({ uploadedFiles, submissionId, openid, conn });

    // Create user-specified steps
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepId = generateId();

      // Serialize conditions if provided
      let conditions = Array.isArray(s.conditions) ? s.conditions : [];

      // Convert legacy scope fields to conditions format (frontend compatibility)
      if (conditions.length === 0) {
        const scopeType = safeString(s.scopeType) || 'all';
        const approverIdentId = safeString(s.approverIdentityId);
        if (approverIdentId) {
          const cond = {
            conditionType: 'identity_scope',
            identityScope: 'specific',
            specificIdentityId: approverIdentId,
            departmentScope: 'all',
            workGroupScope: 'all'
          };
          if (scopeType === 'same_department') {
            cond.departmentScope = 'own';
          } else if (scopeType === 'same_work_group') {
            cond.workGroupScope = 'own';
          } else if (scopeType === 'specific_department') {
            cond.departmentScope = 'specific';
            cond.specificDepartmentId = safeString(s.scopeDepartmentId) || null;
          } else if (scopeType === 'specific_work_group') {
            cond.departmentScope = 'specific';
            cond.specificDepartmentId = safeString(s.scopeDepartmentId) || null;
            cond.workGroupScope = 'specific';
            cond.specificWorkGroupId = safeString(s.scopeWorkGroupId) || null;
          }
          conditions.push(cond);
        }
      }

      assertValidWorkflowStep({ actionType: s.actionType, conditions });

      conditions = await normalizePersonConditionsForPersistence(conditions, orgId, conn);

      if (!conditions.length && safeString(s.approverHrId)) {
        throw new Error(localeCopy.copy_db47f6c08b);
      }

      let stepConditionsJson = null;
      if (conditions.length > 0) {
        stepConditionsJson = JSON.stringify(conditions);
      }
      if (!conditions.length && !safeString(s.approverHrId) && !safeString(s.approverIdentityId)) {
        const configError = new Error(localeCopy.copy_e6048310d4);
        configError.code = 'AUDIT_STEP_CONDITIONS_REQUIRED';
        throw configError;
      }

      await submissionStepModel.create(stepId, {
        submissionId,
        templateStepId: null,
        sortOrder: i + 1,
        approverType: safeString(s.approverType) || null,
        approverHrId: safeString(s.approverHrId) || null,
        approverIdentityId: safeString(s.approverIdentityId) || null,
        actionType: safeString(s.actionType) || 'sign',
        allowApproverDesignation: false,
        stepName: safeString(s.name) || '',
        round: 1,
        stepConditionsJson
      }, conn);
    }

    // Insert submit event for ad-hoc audit
    await auditEventModel.create(generateId(), {
      ...buildAuditOperatorContext(req, submitterAssignment),
      submissionId,
      eventType: 'submit',
      stepIndex: null,
      round: 1,
      operatorHrId: hrId,
      operatorName: submitterAssignment.name,
      comment: null
    }, conn);

    const response = { status: 'success', id: submissionId, submissionNumber, message: localeCopy.copy_828cc5bcd7 };
    await requestDeduplication.complete(conn, {
      ...dedupClaim,
      resourceId: submissionId,
      orgId,
      actorKey: 'user:' + hrId,
      operationType: 'start_ad_hoc_audit'
    }, response);
    await conn.commit();
    res.json(response);
  } catch (e) {
    await conn.rollback();
    if (e && e.code === 'AUDIT_STEP_CONDITIONS_REQUIRED') {
      return res.json({ status: 'invalid_params', message: e.message });
    }
    if (e && e.code === 'INVALID_CLIENT_REQUEST_ID') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_9713c4ccf5 });
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// ═══════════════════════════════════════════════════
// Get Submission Detail
// ═══════════════════════════════════════════════════

/**
 * Resolve comma-separated IDs to names, joined with 、
 * @param {string|null} rawIds - Comma-separated ID string
 * @param {object} map - id→name lookup
 * @returns {string} resolved names or empty string
 */
function resolveMultiNames(rawIds, map) {
  if (!rawIds) return '';
  const ids = String(rawIds).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return '';
  return ids.map(function(id) { return map[id] || id; }).filter(Boolean).join('、');
}

/**
 * Build human-readable display strings from step conditions JSON.
 * Resolves all IDs to names using provided lookup maps.
 * @param {string|null} conditionsJson - Raw step_conditions_json
 * @param {object} maps - { hrMap, identityMap, deptMap, wgMap }
 * @returns {object} { displayParts, approverDesc }
 */
function buildStepConditionsDisplay(conditionsJson, maps) {
  const { hrMap, identityMap, deptMap, wgMap } = maps;
  let displayParts = [];
  let approverDesc = '';

  if (!conditionsJson) return { displayParts, approverDesc };

  let conditions;
  try {
    conditions = typeof conditionsJson === 'string' ? JSON.parse(conditionsJson) : conditionsJson;
  } catch (_) { return { displayParts, approverDesc }; }

  if (!Array.isArray(conditions) || !conditions.length) return { displayParts, approverDesc };
  conditions = effectiveConditionsForAuthorization(conditions);

  for (const cond of conditions) {
    let part = '';
    if (cond.conditionType === 'person') {
      const ids = (cond.personHrIds || '').split(',').map(s => s.trim()).filter(Boolean);
      const names = ids.map(id => hrMap[id] || id).filter(Boolean);
      part = names.length ? '由 ' + names.join('、') + localeCopy.copy_7abed5378f : '由指定人员审批';
    } else {
      // identity_scope
      const scopeParts = [];
      if (cond.departmentScope === 'own') scopeParts.push('同部门');
      else if (cond.departmentScope === 'specific') {
        if (cond.specificDepartmentId) {
          const deptIds = cond.specificDepartmentId.split(',').map(s => s.trim()).filter(Boolean);
          const deptNames = deptIds.map(id => deptMap[id] || id).filter(Boolean);
          if (deptNames.length) scopeParts.push(deptNames.join('、'));
        }
        // else: specific without ID → malformed condition, silently skip department part
      }

      if (cond.workGroupScope === 'own') scopeParts.push('同职能组');
      else if (cond.workGroupScope === 'specific') {
        if (cond.specificWorkGroupId) {
          const wgIds = cond.specificWorkGroupId.split(',').map(s => s.trim()).filter(Boolean);
          const wgNames = wgIds.map(id => wgMap[id] || id).filter(Boolean);
          if (wgNames.length) scopeParts.push(wgNames.join('、'));
        }
        // else: specific without ID → malformed condition, silently skip wg part
      }

      if (cond.identityScope === 'own') scopeParts.push('同身份');
      else if (cond.identityScope === 'specific') {
        if (cond.specificIdentityId) {
          const identIds = cond.specificIdentityId.split(',').map(s => s.trim()).filter(Boolean);
          const identNames = identIds.map(id => identityMap[id] || id).filter(Boolean);
          if (identNames.length) scopeParts.push(identNames.join('、'));
        }
        // else: specific without ID → malformed condition, silently skip identity part
      }

      const scopeStr = scopeParts.length ? scopeParts.join(' · ') + ' ' : '';

      if (cond.identityScope === 'all' && cond.departmentScope === 'all' && cond.workGroupScope === 'all') {
        part = '由全体成员审批';
      } else {
        part = '由 ' + scopeStr + localeCopy.copy_c9695bb971;
      }
    }
    if (part) displayParts.push(part);
  }

  approverDesc = displayParts.join(' 或 ');
  return { displayParts, approverDesc };
}

// getSubmissionDetail
router.post('/getSubmissionDetail', async (req, res) => {
  try {
    const detailActorResult = await resolveCurrentActor(req);
    if (!detailActorResult.ok) {
      return res.json({ status: detailActorResult.status || 'forbidden', message: detailActorResult.message || localeCopy.copy_c22a252e97 });
    }
    const currentActor = detailActorResult.actor;
    const detailActor = currentActor.type === 'user'
      ? currentActor
      : null;
    const hrId = detailActor ? detailActor.id : null;
    const admin = currentActor.type === 'admin' ? currentActor.profile : null;
    const orgId = await getCurrentOrgId();
    const detailAssignment = detailActor
      ? await resolveActorAssignment(detailActor, orgId)
      : null;
    if ((!hrId || !detailAssignment) && !admin) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_c22a252e97 });
    }

    const submissionId = safeString(req.body.submissionId);
    if (!submissionId) return res.json({ status: 'invalid_params', message: localeCopy.copy_fa1dcca5ac });

    const submission = await submissionModel.getById(submissionId);
    if (!submission) return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });

    const steps = await submissionStepModel.getBySubmissionId(submissionId);
    // 审批历史入口的访问依据是实际审批事件，而不是当前待处理步骤。
    // 身份条件审批可能没有把当前人写进 approver_hr_id，且记录打开时当前步骤已经推进，
    // 只检查 pending step 会把本人已经处理过的记录错误拦截为“没有查看权限”。
    const events = await auditEventModel.getBySubmissionId(submissionId);
    const hasHistoricalApprovalEvent = events.some(function(event) {
      return event.event_type === 'approve' || event.event_type === 'reject'
        ? eventMatchesAssignment(event, steps, detailAssignment && detailAssignment.assignment_id)
        : false;
    });

    // Check access: submitter, approver in any step, or admin
    const isSubmitter = Boolean(detailAssignment) && submissionMatchesSubmitterAssignment(
      submission,
      detailAssignment.assignment_id
    );
    let isApprover = hasHistoricalApprovalEvent;

    // Check identity-based matching — always run so submitter-as-approver is detected
    // Also runs for admins so they get properly identified as approvers when their identity matches
    if (!isApprover && detailAssignment) {
      const approverInfo = detailAssignment;
      const submitterInfo = await getSubmissionSubmitterAssignments(submission, orgId);
      // Only check CURRENT pending steps (at current_step_index).
      // Don't match against already-approved or future steps — the user
      // must match the step that is actually waiting for approval.
      for (const s of submitterInfo.length ? steps : []) {
        if (s.status !== 'pending') continue;
        if (s.sort_order !== submission.current_step_index) continue;
        if (!s.step_conditions_json) continue;
        try {
          const conds = JSON.parse(s.step_conditions_json);
          if (matchesAnyCondition(conds, approverInfo, submitterInfo)) {
            isApprover = true; break;
          }
        } catch (_) {
          // 历史步骤只使用不可变快照；缺失或损坏时失败关闭。
        }
      }
    }

    if (!isSubmitter && !isApprover && !admin) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_534ae184dc });
    }

    const files = await submissionFileModel.getBySubmissionId(submissionId);
    const currentFileIds = new Set(files.map(function(file) { return safeString(file.id); }));
    const signatures = (await submissionSignatureModel.getBySubmissionId(submissionId))
      .filter(function(signature) { return currentFileIds.has(safeString(signature.file_id)); });
    // Load HR names
    const allHrIds = new Set();
    allHrIds.add(submission.submitted_by);
    steps.forEach(function(s) { if (s.approver_hr_id) addCsvToSet(s.approver_hr_id, allHrIds); });
    signatures.forEach((s) => allHrIds.add(s.signer_hr_id));
    events.forEach((e) => { if (e.operator_hr_id) allHrIds.add(e.operator_hr_id); });
    const hrMap = {};
    if (allHrIds.size) {
      const hrRows = await hrInfoModel.getByIds([...allHrIds]);
      for (const hr of hrRows) {
        hrMap[hr.id] = safeString(hr.name);
      }
    }

    // Load template name if applicable
    let templateName = '';
    if (submission.template_id) {
      const template = await flowTemplateModel.getById(submission.template_id);
      templateName = template ? safeString(template.name) : '';
    }

    // Helper: add comma-separated IDs to a Set
    function addCsvToSet(csv, targetSet) {
      if (!csv) return;
      String(csv).split(',').forEach(function(id) {
        let tid = id.trim();
        if (tid) targetSet.add(tid);
      });
    }

    // Load identity names — split comma-separated IDs
    const identityIds = new Set();
    steps.forEach(function(s) { addCsvToSet(s.approver_identity_id, identityIds); });
    const deptIdSet = new Set();
    steps.forEach(function(s) { addCsvToSet(s.scope_department_id, deptIdSet); });
    const wgIdSet = new Set();
    steps.forEach(function(s) { addCsvToSet(s.scope_work_group_id, wgIdSet); });
    const hrIdSet = new Set();
    // Also collect from step_conditions_json
    for (const s of steps) {
      if (s.step_conditions_json) {
        try {
          const conds = JSON.parse(s.step_conditions_json);
          if (Array.isArray(conds)) {
            for (const c of conds) {
              if (c.conditionType === 'person' && c.personHrIds) {
                addCsvToSet(c.personHrIds, hrIdSet);
              } else {
                // identity_scope or unknown type — treat as identity_scope
                addCsvToSet(c.specificIdentityId, identityIds);
                addCsvToSet(c.specificDepartmentId, deptIdSet);
                addCsvToSet(c.specificWorkGroupId, wgIdSet);
              }
            }
          }
        } catch (_) { }
      }
    }
    const identityMap = {};
    if (identityIds.size) {
      const [identRows] = await pool.query(
        'SELECT id, name FROM identities WHERE id IN (?) AND org_id = ?',
        [[...identityIds], orgId]
      );
      for (const ident of identRows) identityMap[ident.id] = safeString(ident.name);
    }

    const deptMap = {}, wgMap = {};
    if (deptIdSet.size) {
      const [deptRows] = await pool.query(
        'SELECT id, name FROM departments WHERE id IN (?) AND org_id = ?',
        [[...deptIdSet], orgId]
      );
      for (const d of deptRows) deptMap[d.id] = safeString(d.name);
    }
    if (wgIdSet.size) {
      const [wgRows] = await pool.query(
        'SELECT id, name FROM work_groups WHERE id IN (?) AND org_id = ?',
        [[...wgIdSet], orgId]
      );
      for (const w of wgRows) wgMap[w.id] = safeString(w.name);
    }
    if (hrIdSet.size) {
      const hrCondRows = await hrInfoModel.getByIds([...hrIdSet]);
      for (const hr of hrCondRows) {
        if (!hrMap[hr.id]) hrMap[hr.id] = safeString(hr.name);
      }
    }

    res.json({
      status: 'success',
      userIsSubmitter: isSubmitter,
      userIsApprover: isApprover,
      userIsAdmin: !!admin,
      events: events.map((e) => ({
        id: safeString(e.id),
        eventType: safeString(e.event_type),
        stepIndex: e.step_index,
        round: e.round || 1,
        operatorName: e.operator_name || hrMap[e.operator_hr_id] || '',
        operatorPersonId: safeString(e.operator_person_id),
        operatorAssignmentId: safeString(e.operator_assignment_id),
        operatorContextSnapshot: parseSnapshot(e.operator_context_snapshot),
        comment: safeString(e.comment),
        createdAt: e.created_at
      })),
      submission: {
        id: safeString(submission.id),
        submissionNumber: safeString(submission.submission_number),
        title: safeString(submission.title),
        description: safeString(submission.description),
        type: safeString(submission.type),
        templateId: safeString(submission.template_id),
        templateName,
        status: safeString(submission.status),
        submittedBy: safeString(submission.submitted_by),
        submittedPersonId: safeString(submission.submitted_person_id),
        submittedAssignmentId: safeString(submission.submitted_assignment_id),
        submittedContextSnapshot: parseSnapshot(submission.submitted_context_snapshot),
        submitterName: hrMap[submission.submitted_by] || localeCopy.copy_8d3451355b,
        currentStepIndex: submission.current_step_index,
        resubmitMode: safeString(submission.resubmit_mode),
        previousRejectStepIndex: submission.previous_reject_step_index,
        createdAt: submission.created_at,
        updatedAt: submission.updated_at
      },
      steps: steps.map((s) => {
        // Build condition display strings from step_conditions_json
        const condDisplay = buildStepConditionsDisplay(
          s.step_conditions_json,
          { hrMap, identityMap, deptMap, wgMap }
        );

        // Build legacy approverDesc as fallback
        let legacyApproverDesc = '';
        // Resolve legacy identity field — may contain comma-separated IDs (multi-select)
        const rawIdentId = (s.approver_identity_id || '').trim();
        let identName = '';
        if (rawIdentId) {
          const identIds = rawIdentId.split(',').map(function(id) { return id.trim(); }).filter(Boolean);
          const identNames = identIds.map(function(id) { return identityMap[id] || id; }).filter(Boolean);
          identName = identNames.join('、');
        }
        const scopeType = (s.scope_type || '').trim();
        if (s.approver_type === 'specific_person') {
          const rawHrId = (s.approver_hr_id || '').trim();
          let personNames = '';
          if (rawHrId) {
            const hrIds = rawHrId.split(',').map(function(id) { return id.trim(); }).filter(Boolean);
            const names = hrIds.map(function(id) { return hrMap[id] || id; }).filter(Boolean);
            personNames = names.join('、');
          }
          legacyApproverDesc = localeCopy.copy_d3028048b3 + (personNames || localeCopy.copy_86bbf0d28e) + localeCopy.copy_7abed5378f;
        } else if (identName || scopeType) {
          // Always build from scope + identity, using fallback labels when names are missing
          const identLabel = identName || localeCopy.copy_5a83091c13;
          if (!scopeType || scopeType === 'all') {
            legacyApproverDesc = localeCopy.copy_9b774f950c + identLabel + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'same_department') {
            legacyApproverDesc = localeCopy.copy_fc98ff863c + identLabel + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'same_work_group') {
            legacyApproverDesc = localeCopy.copy_d0348010eb + identLabel + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'specific_department') {
            const dn = resolveMultiNames(s.scope_department_id, deptMap);
            if (dn) {
              legacyApproverDesc = localeCopy.copy_d3028048b3 + dn + ' ' + identLabel + localeCopy.copy_7abed5378f;
            } else {
              legacyApproverDesc = localeCopy.copy_d3028048b3 + identLabel + localeCopy.copy_7abed5378f;
            }
          } else if (scopeType === 'specific_work_group') {
            const dn = resolveMultiNames(s.scope_department_id, deptMap);
            const wn = resolveMultiNames(s.scope_work_group_id, wgMap);
            const loc = [dn, wn].filter(Boolean).join('·');
            if (loc) {
              legacyApproverDesc = localeCopy.copy_d3028048b3 + loc + ' ' + identLabel + localeCopy.copy_7abed5378f;
            } else {
              legacyApproverDesc = localeCopy.copy_d3028048b3 + identLabel + localeCopy.copy_7abed5378f;
            }
          } else {
            legacyApproverDesc = localeCopy.copy_d3028048b3 + identLabel + localeCopy.copy_7abed5378f;
          }
        }

        // Resolve multi-select names for legacy flat fields
        let approverNameDisplay = localeCopy.copy_86bbf0d28e;
        let rawHrId2 = (s.approver_hr_id || '').trim();
        if (rawHrId2) {
          let hrIds2 = rawHrId2.split(',').map(function(id) { return id.trim(); }).filter(Boolean);
          let hrNames2 = hrIds2.map(function(id) { return hrMap[id] || id; }).filter(Boolean);
          approverNameDisplay = hrNames2.join('、');
        }
        let approverIdentityNameDisplay = '';
        let rawIdentId2 = (s.approver_identity_id || '').trim();
        if (rawIdentId2) {
          let identIds2 = rawIdentId2.split(',').map(function(id) { return id.trim(); }).filter(Boolean);
          let identNames2 = identIds2.map(function(id) { return identityMap[id] || id; }).filter(Boolean);
          approverIdentityNameDisplay = identNames2.join('、');
        }

        return {
        id: safeString(s.id),
        sortOrder: s.sort_order,
        stepName: safeString(s.step_name || s.name || ''),
        approverType: safeString(s.approver_type),
        approverHrId: safeString(s.approver_hr_id),
        approverName: approverNameDisplay,
        approverIdentityId: safeString(s.approver_identity_id),
        approverIdentityName: approverIdentityNameDisplay,
        scopeType: safeString(s.scope_type),
        scopeDepartmentId: safeString(s.scope_department_id),
        scopeDepartmentName: resolveMultiNames(s.scope_department_id, deptMap),
        scopeWorkGroupId: safeString(s.scope_work_group_id),
        scopeWorkGroupName: resolveMultiNames(s.scope_work_group_id, wgMap),
        actionType: safeString(s.action_type),
        allowApproverDesignation: Number(s.allow_approver_designation) === 1,
        status: safeString(s.status),
        comment: safeString(s.comment),
        rejectionReason: safeString(s.rejection_reason),
        round: s.round,
        processedAt: s.processed_at,
        processedPersonId: safeString(s.processed_person_id),
        processedAssignmentId: safeString(s.processed_assignment_id),
        processedContextSnapshot: parseSnapshot(s.processed_context_snapshot),
        stepConditionsJson: s.step_conditions_json || null,
        stepConditionsDisplay: condDisplay.displayParts,
        approverDesc: condDisplay.approverDesc || legacyApproverDesc || localeCopy.copy_ae42f47cf6
      };
    }),
      files: files.map((f) => ({
        id: safeString(f.id),
        fileName: safeString(f.file_name),
        mimeType: safeString(f.mime_type),
        fileSize: f.file_size,
        fileHash: safeString(f.file_hash),
        sortOrder: f.sort_order
      })),
      signatures: signatures.map((sig) => ({
        id: safeString(sig.id),
        stepId: safeString(sig.step_id),
        fileId: safeString(sig.file_id),
        signatureType: safeString(sig.signature_type),
        positionX: parseFloat(sig.position_x) || 0,
        positionY: parseFloat(sig.position_y) || 0,
        size: parseFloat(sig.signature_size) || 1,
        rotation: parseFloat(sig.rotation_degrees) || 0,
        page: sig.page || 1,
        signerHrId: safeString(sig.signer_hr_id),
        signerName: hrMap[sig.signer_hr_id] || localeCopy.copy_8d3451355b,
        round: sig.round,
        signedAt: sig.signed_at
      }))
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Approval Actions
// ═══════════════════════════════════════════════════

/**
 * Shared authorization check for approve/reject step actions.
 * Historical authorization uses only the immutable step_conditions_json snapshot.
 * A missing or corrupt snapshot fails closed and is reported distinctly so that
 * operations can be repaired by a controlled migration instead of current templates.
 * @returns {{ authorized: boolean, snapshotValid: boolean }}
 */
async function checkStepAuthorization(step, submission, approverAssignment, db) {
  const orgId = await getCurrentOrgId();
  if (!approverAssignment) return { authorized: false, snapshotValid: true };
  const currentApprover = approverAssignment;
  const submitters = await getSubmissionSubmitterAssignments(submission, orgId, db);
  if (!Array.isArray(submitters) || !submitters.length) {
    return { authorized: false, snapshotValid: false };
  }
  if (!step.step_conditions_json) return { authorized: false, snapshotValid: false };
  try {
    const conditions = JSON.parse(step.step_conditions_json);
    if (!Array.isArray(conditions) || !conditions.length
      || conditions.some(function(condition) { return !validateConditionShape(condition).ok; })) {
      return { authorized: false, snapshotValid: false };
    }
    return {
      authorized: matchesAnyCondition(conditions, currentApprover, submitters),
      snapshotValid: true
    };
  } catch (_) {
    return { authorized: false, snapshotValid: false };
  }
}

// approveStep — 按步骤动作类型强制校验签字、授权印章或纯通过材料
async function validateStepForAction(step, submission, submissionId, conn) {
  if (step.submission_id !== submissionId) {
    return { ok: false, status: 'invalid_params', message: localeCopy.copy_f4c0b882f5 };
  }
  if (submission.status !== 'in_progress') {
    return { ok: false, status: 'invalid_state', message: localeCopy.copy_64b86dfa6b };
  }
  if (step.status !== 'pending') {
    return { ok: false, status: 'invalid_state', message: localeCopy.copy_0114ea3d7b };
  }
  if (step.sort_order !== submission.current_step_index) {
    return { ok: false, status: 'invalid_state', message: localeCopy.copy_cb3bc3dcb5 };
  }
  const maxRound = await submissionStepModel.getMaxRound(submission.id, step.sort_order, conn);
  if ((step.round || 1) !== maxRound) {
    return { ok: false, status: 'invalid_state', message: localeCopy.copy_64b86dfa6b };
  }
  return { ok: true };
}

function approvalIntegrityFailure(error) {
  const messages = {
    approval_action_invalid: localeCopy.approvalActionInvalid,
    approval_material_invalid: localeCopy.approvalMaterialInvalid,
    approval_material_file_invalid: localeCopy.approvalMaterialFileInvalid,
    approval_material_not_allowed: localeCopy.approvalMaterialNotAllowed,
    approval_signature_required: localeCopy.approvalSignatureRequired,
    approval_signature_invalid: localeCopy.approvalSignatureInvalid,
    approval_stamp_required: localeCopy.approvalStampRequired,
    approval_stamp_not_authorized: localeCopy.approvalStampNotAuthorized,
    approval_both_required: localeCopy.approvalBothRequired,
    approval_final_pdf_unavailable: localeCopy.approvalFinalPdfUnavailable
  };
  return {
    status: error.code || 'approval_material_invalid',
    message: messages[error.code] || localeCopy.approvalMaterialInvalid
  };
}

router.post('/approveStep', async (req, res) => {
  const conn = await pool.getConnection();
  let transactionStarted = false;
  let transactionCommitted = false;
  let commitAttempted = false;
  let fileCommit = null;
  try {
    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok || actorResult.actor.type !== 'user') {
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const actor = actorResult.actor;
    const orgId = await getCurrentOrgId();

    const submissionId = safeString(req.body.submissionId);
    const stepId = safeString(req.body.stepId);
    const comment = safeString(req.body.comment);
    const signatures = Array.isArray(req.body.signatures) ? req.body.signatures : [];
    const designatedNextPersonIds = Array.isArray(req.body.designatedNextPersonIds)
      ? [...new Set(req.body.designatedNextPersonIds.map(function(id) { return safeString(id); }).filter(Boolean))]
      : [];
    const designatedNextAssignmentIds = Array.isArray(req.body.designatedNextAssignmentIds)
      ? [...new Set(req.body.designatedNextAssignmentIds.map(function(id) { return safeString(id); }).filter(Boolean))]
      : [];

    if (!submissionId || !stepId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_a21fccedd7 });
    }

    await conn.beginTransaction();
    transactionStarted = true;
    await lockAuditActor(conn, {
      person_id: actor.personId,
      hr_id: actor.id,
      assignment_id: actor.assignmentId
    }, orgId);
    const approverAssignment = await resolveActorAssignmentForUpdate(actor, orgId, conn);
    if (!approverAssignment) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'forbidden', message: localeCopy.copy_4e84385ce1 });
    }
    const hrId = approverAssignment.hr_id;
    await lockAuditAssignmentIds(conn, designatedNextAssignmentIds, orgId);
    const submission = await submissionModel.getByIdForUpdate(submissionId, conn);
    if (!submission) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }

    const step = await submissionStepModel.getByIdForUpdate(stepId, conn);
    if (!step) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_7913354ccb });
    }
    if (submission.status !== 'in_progress' || step.status !== 'pending') {
      const isOwnReplay = await auditEventModel.hasStepActionByActor({
        submissionId,
        stepIndex: step.sort_order,
        round: step.round,
        eventType: 'approve',
        assignmentId: approverAssignment.assignment_id,
        hrId
      }, conn);
      await conn.rollback();
      if (isOwnReplay) {
        return res.json({
          status: 'success',
          message: submission.status !== 'in_progress' ? localeCopy.copy_a530b3e599 : localeCopy.copy_786e39e479,
          submissionStatus: submission.status,
          stepStatus: step.status,
          idempotent: true
        });
      }
      return res.json({ status: 'forbidden', message: localeCopy.copy_511125fe12 });
    }

    // Check authorization — shared helper
    const stepState = await validateStepForAction(step, submission, submissionId, conn);
    if (!stepState.ok) {
      await conn.rollback();
      return res.json({ status: stepState.status, message: stepState.message });
    }

    const authorization = await checkStepAuthorization(step, submission, approverAssignment, conn);
    if (!authorization.authorized) {
      await conn.rollback();
      if (!authorization.snapshotValid) {
        return res.json({
          status: 'historical_snapshot_missing',
          message: localeCopy.historicalApprovalSnapshotMissing
        });
      }
      return res.json({ status: 'forbidden', message: localeCopy.copy_511125fe12 });
    }

    const now = new Date();
    const currentRound = step.round;
    const allSteps = await submissionStepModel.getBySubmissionId(submissionId, conn);
    const currentSteps = allSteps
      .filter((s) => s.round === currentRound)
      .sort((a, b) => a.sort_order - b.sort_order);
    const nextStep = currentSteps.find((s) => s.sort_order === step.sort_order + 1);
    const hasNextDesignation = designatedNextPersonIds.length > 0 || designatedNextAssignmentIds.length > 0;
    if (hasNextDesignation && (!designatedNextPersonIds.length || !designatedNextAssignmentIds.length)) {
      await conn.rollback();
      return res.json({ status: 'invalid_params', message: localeCopy.copy_93c41f359c });
    }
    if (hasNextDesignation && (!nextStep || Number(nextStep.allow_approver_designation) !== 1)) {
      await conn.rollback();
      return res.json({ status: 'invalid_params', message: nextStep ? localeCopy.copy_97d569974c : localeCopy.copy_f75a962ed9 });
    }

    const lockedFiles = await submissionFileModel.getCurrentBySubmissionIdForUpdate(submissionId, conn);
    const currentFiles = await loadApprovalFileFacts(lockedFiles, {
      materials: signatures,
      finalStep: !nextStep,
      requireAll: true
    });
    let normalizedMaterials;
    try {
      normalizedMaterials = await resolveApprovalMaterials({
        actionType: step.action_type,
        materials: signatures,
        currentFiles,
        approverAssignment,
        db: conn,
        generateId
      });
    } catch (error) {
      if (!(error instanceof AuditApprovalIntegrityError)) throw error;
      await conn.rollback();
      return res.json(approvalIntegrityFailure(error));
    }
    const signaturesByFile = groupApprovalMaterialsByFile(normalizedMaterials);
    const filesToProcess = currentFiles;
    const approvalEventId = generateId();

    const signerContextSnapshot = assignmentSnapshot(approverAssignment, req.authContext);

    // 所有材料、当前岗位和授权都在同一事务中锁定并重读后，才允许改变步骤状态。
    await submissionStepModel.updateStatus(stepId, {
      status: 'approved',
      comment,
      processedAt: now,
      processedPersonId: approverAssignment.person_id,
      processedAssignmentId: approverAssignment.assignment_id,
      processedContextSnapshot: signerContextSnapshot
    }, conn);

    const preparedFiles = [];
    const preparedEvidence = [];
    const pendingSignatureRecords = [];
    for (const file of filesToProcess) {
      const fileId = safeString(file.id);
      const fileSignatures = signaturesByFile.get(fileId) || [];
      if (!file.file_path || !Buffer.isBuffer(file.approval_source_buffer)) {
        throw new AuditApprovalIntegrityError(
          !nextStep && file.mime_type === 'application/pdf'
            ? AUDIT_APPROVAL_INTEGRITY_CODES.FINAL_PDF_UNAVAILABLE
            : AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID
        );
      }

      let overlayResult = null;
      let finalBuffer = file.approval_source_buffer;
      let finalMimeType = file.mime_type;
      if (fileSignatures.length) {
        overlayResult = await overlaySignaturesOnBuffer(file, finalBuffer, fileSignatures);
        if (!overlayResult) {
          throw new AuditApprovalIntegrityError(AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
        }
        finalBuffer = overlayResult.buffer;
        finalMimeType = overlayResult.mimeType;
      }

      const previousSignature = await submissionSignatureModel.getLastSignature(fileId, currentRound, conn);

      // 最后一步必须覆盖所有当前 PDF；即使本步只是“通过”且没有新增可见图层，
      // 也要对最终字节执行 PKCS#7 签名。非 PDF 文件只保留原有图层合成行为。
      const latestPlacement = fileSignatures[fileSignatures.length - 1] || null;
      const evidence = await prepareEvidence({
        db: conn, organizationId: orgId, organizationName: safeString(req.authContext && req.authContext.organizationName),
        actor: { ...approverAssignment, contextId: safeString(req.authContext && req.authContext.contextId) },
        assignmentLabel: signerContextSnapshot.assignmentLabel, submissionId, stepId, eventId: approvalEventId,
        fileId, round: currentRound, step: step.sort_order, action: step.action_type || 'approve', time: now.toISOString(),
        inputDigest: hashFile(file.approval_source_buffer), inputPath: file.file_path,
        buffer: finalBuffer, finalPdf: !nextStep && finalMimeType === 'application/pdf',
        materials: fileSignatures.map(material => ({ type: material.signatureType, digest: material.materialImageHash,
          x: material.positionX, y: material.positionY, page: material.page })),
        signaturePosition: latestPlacement ? { x: latestPlacement.positionX, y: latestPlacement.positionY, page: latestPlacement.page || 1 } : null
      });
      finalBuffer = evidence.buffer;
      preparedEvidence.push(evidence);

      const documentHash = hashFile(finalBuffer);
      preparedFiles.push({
        fileId,
        orgId,
        oldPath: file.file_path,
        buffer: finalBuffer,
        mimeType: finalMimeType,
        fileHash: documentHash
      });

      const chainMaterials = fileSignatures.slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (!nextStep && finalMimeType === 'application/pdf') {
        const latestPlacement = chainMaterials[chainMaterials.length - 1] || null;
        chainMaterials.push(createDigitalSignatureMaterial({
          generateId,
          fileId,
          signaturePosition: latestPlacement ? {
            x: latestPlacement.positionX,
            y: latestPlacement.positionY,
            page: latestPlacement.page
          } : null
        }));
      }
      const chainRecords = buildSignatureChainRecords({
        materials: chainMaterials,
        previousSignatureHash: previousSignature ? previousSignature.signature_data_hash : null,
        stepId,
        signerHrId: hrId,
        signerAssignmentId: approverAssignment.assignment_id,
        signerContextSnapshot,
        round: currentRound,
        documentHash,
        signedAt: now.toISOString()
      });
      chainRecords.forEach((record) => {
        pendingSignatureRecords.push({
          fileId,
          record
        });
      });
    }

    fileCommit = createAuditFileCommit(preparedFiles);
    fileCommit.stage();
    for (const preparedFile of preparedFiles) {
      const metadata = fileCommit.metadataFor(preparedFile.fileId);
      if (!metadata) {
        throw new AuditApprovalIntegrityError(AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
      }
      await submissionFileModel.updateMetadata(preparedFile.fileId, metadata, conn);
    }
    for (const evidence of preparedEvidence) {
      const metadata = fileCommit.metadataFor(evidence.context.fileId);
      await signingEvidenceModel.create(evidence.receipt, { ...evidence.context, outputPath: metadata.filePath }, conn);
    }
    for (const pending of pendingSignatureRecords) {
      const sigData = pending.record.material;
      await submissionSignatureModel.create(sigData.id, {
        submissionId,
        stepId,
        fileId: pending.fileId,
        signatureType: sigData.signatureType,
        imageData: sigData.imageData,
        positionX: sigData.positionX,
        positionY: sigData.positionY,
        size: sigData.size,
        rotation: sigData.rotation,
        page: sigData.page,
        signerHrId: hrId,
        round: currentRound,
        previousSignatureHash: pending.record.previousSignatureHash,
        documentHashAtSigning: preparedFiles.find((item) => item.fileId === pending.fileId).fileHash,
        signatureDataHash: pending.record.signatureDataHash,
        signedAt: now,
        materialImageHash: pending.record.materialImageHash,
        stampId: pending.record.stampId,
        signerAssignmentId: pending.record.signerAssignmentId,
        signerContextSnapshot: pending.record.signerContextSnapshot,
        hashVersion: pending.record.hashVersion
      }, conn);
    }

    // Check if there are more steps
    if (nextStep) {
      // If the approver designated specific people for the next step,
      // NARROW the scope: only designated persons can approve, BUT they
      // must also be eligible under the original step conditions (can't expand scope).
      if (hasNextDesignation) {
        let originalConds = [];
        if (nextStep.step_conditions_json) {
          try {
            originalConds = JSON.parse(nextStep.step_conditions_json);
            if (!Array.isArray(originalConds)) throw new Error();
          } catch (_) {
            throw new Error(localeCopy.copy_93c41f359c);
          }
        }
        if (!originalConds.length) {
          throw new Error(localeCopy.historicalApprovalSnapshotMissing);
        }

        const submitterAssignments = await getSubmissionSubmitterAssignments(submission, orgId, conn);
        const newConds = await narrowTemplateStepConditions(
          originalConds,
          designatedNextPersonIds,
          designatedNextAssignmentIds,
          submitterAssignments,
          orgId,
          conn
        );

        if (newConds.length > 0) {
          const newCondsJson = JSON.stringify(newConds);
          await conn.query(
            'UPDATE audit_submission_steps SET step_conditions_json = ? WHERE id = ? AND org_id = ?',
            [newCondsJson, nextStep.id, orgId]
          );
        }
      }
      // Move to next step
      await submissionModel.update(submissionId, { currentStepIndex: nextStep.sort_order }, conn);
    } else {
      // All steps approved — submission complete
      await submissionModel.update(submissionId, { status: 'approved' }, conn);
    }

    // 凭证与事件共用预先分配的事件标识，在同一事务内提交。
    await auditEventModel.create(approvalEventId, {
      ...buildAuditOperatorContext(req, approverAssignment),
      submissionId,
      eventType: 'approve',
      stepIndex: step.sort_order,
      round: currentRound,
      operatorHrId: hrId,
      operatorName: approverAssignment.name,
      comment: comment || null
    }, conn);

    // 业务状态与通知 Outbox 在同一事务提交。
    if (!nextStep) {
      // Final step approved → notify submitter
      await createNotification({
        hrId: submission.submitted_by,
        type: 'submission_approved',
        title: localeCopy.copy_32f1119845,
        description: localeCopy.copy_dd6dd4b694 + (submission.title || submission.submission_number) + localeCopy.copy_071cea6fa1,
        category: 'audit',
        targetType: 'submission',
        targetId: submissionId,
        eventKey: ['audit', submissionId, currentRound, step.sort_order, 'approved'].join(':'),
        targetUrl: '/subpackages/audit/pages/submissionDetail/submissionDetail?id=' + submissionId
      }, conn);
    } else {
      // Advanced to next step → notify submitter of progress
      await createNotification({
        hrId: submission.submitted_by,
        type: 'submission_progress',
        title: localeCopy.copy_a5bbfb41e9,
        description: localeCopy.copy_dd6dd4b694 + (submission.title || submission.submission_number) + localeCopy.copy_4dc0ac16b8 + step.sort_order + localeCopy.copy_b08a9cb173 + nextStep.sort_order + localeCopy.copy_493a127a99,
        category: 'audit',
        targetType: 'submission',
        targetId: submissionId,
        eventKey: ['audit', submissionId, currentRound, step.sort_order, 'progress'].join(':'),
        targetUrl: '/subpackages/audit/pages/submissionDetail/submissionDetail?id=' + submissionId
      }, conn);
    }
    commitAttempted = true;
    await conn.commit();
    transactionCommitted = true;
    transactionStarted = false;
    fileCommit.finalize();
    res.json({ status: 'success', message: localeCopy.copy_126a0e1f4c + (nextStep ? localeCopy.copy_1d9affae0d : localeCopy.copy_e34c2ce1d6) });
  } catch (e) {
    if (transactionStarted && !transactionCommitted) {
      try { await conn.rollback(); } catch (_) {}
      transactionStarted = false;
    }
    // commit() 抛错时提交结果可能不确定，此时保留账本给启动恢复任务核对数据库；
    // 只有确认尚未尝试提交时，才可以立即删除未被数据库引用的新版本。
    if (fileCommit && !transactionCommitted && !commitAttempted) {
      fileCommit.rollback();
    }
    if (e instanceof AuditApprovalIntegrityError) {
      return res.json(approvalIntegrityFailure(e));
    }
    if (e instanceof SigningProtocolError) {
      return res.json({ status: 'signing_unavailable', message: signingCopy.signingUnavailable });
    }
    if (e instanceof AuditFileCommitError) {
      return res.json(approvalIntegrityFailure(
        new AuditApprovalIntegrityError(AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID)
      ));
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// rejectStep — Reject current step
router.post('/rejectStep', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const actorContext = await resolveAuditAssignmentActor(req, conn);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    let rejecterAssignment = actorContext.assignment;
    const hrId = rejecterAssignment.hr_id;
    const orgId = actorContext.orgId;

    const submissionId = safeString(req.body.submissionId);
    const stepId = safeString(req.body.stepId);
    const rejectionReason = safeString(req.body.rejectionReason);

    if (!submissionId || !stepId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_a21fccedd7 });
    }
    if (!rejectionReason) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_3764af0483 });
    }

    await conn.beginTransaction();
    rejecterAssignment = await lockAndRefreshAuditActor(conn, actorContext);
    if (!rejecterAssignment) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_4e84385ce1 });
    }
    const submission = await submissionModel.getByIdForUpdate(submissionId, conn);
    if (!submission) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }

    const step = await submissionStepModel.getByIdForUpdate(stepId, conn);
    if (!step) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_7913354ccb });
    }
    if (step.status !== 'pending') {
      const isOwnReplay = await auditEventModel.hasStepActionByActor({
        submissionId,
        stepIndex: step.sort_order,
        round: step.round,
        eventType: 'reject',
        assignmentId: rejecterAssignment.assignment_id,
        hrId
      }, conn);
      await conn.rollback();
      if (isOwnReplay) {
        return res.json({ status: 'success', message: localeCopy.copy_786e39e479, stepStatus: step.status, idempotent: true });
      }
      return res.json({ status: 'forbidden', message: localeCopy.copy_511125fe12 });
    }

    // Check authorization — shared helper
    const stepState = await validateStepForAction(step, submission, submissionId, conn);
    if (!stepState.ok) {
      await conn.rollback();
      return res.json({ status: stepState.status, message: stepState.message });
    }

    const authorization = await checkStepAuthorization(step, submission, rejecterAssignment, conn);
    if (!authorization.authorized) {
      await conn.rollback();
      if (!authorization.snapshotValid) {
        return res.json({
          status: 'historical_snapshot_missing',
          message: localeCopy.historicalApprovalSnapshotMissing
        });
      }
      return res.json({ status: 'forbidden', message: localeCopy.copy_511125fe12 });
    }

    const processedAt = new Date();
    const rejectionEventId = generateId();
    const rejectionFiles = await loadApprovalFileFacts(
      await submissionFileModel.getCurrentBySubmissionIdForUpdate(submissionId, conn), { requireAll: true }
    );
    for (const file of rejectionFiles) {
      const evidence = await prepareEvidence({ db: conn, organizationId: orgId,
        organizationName: safeString(req.authContext && req.authContext.organizationName),
        actor: { ...rejecterAssignment, contextId: safeString(req.authContext && req.authContext.contextId) },
        assignmentLabel: rejecterAssignment.assignment_label, submissionId, stepId, eventId: rejectionEventId,
        fileId: file.id, round: step.round, step: step.sort_order, action: 'reject', time: processedAt.toISOString(),
        inputDigest: hashFile(file.approval_source_buffer), inputPath: file.file_path,
        buffer: file.approval_source_buffer, finalPdf: false, materials: [] });
      await signingEvidenceModel.create(evidence.receipt, { ...evidence.context, outputPath: file.file_path }, conn);
    }

    // Update step to rejected
    await submissionStepModel.updateStatus(stepId, {
      status: 'rejected',
      rejectionReason,
      processedAt,
      processedPersonId: rejecterAssignment.person_id,
      processedAssignmentId: rejecterAssignment.assignment_id,
      processedContextSnapshot: assignmentSnapshot(rejecterAssignment, req.authContext)
    }, conn);

    // Set submission to rejected, record which step rejected
    await submissionModel.update(submissionId, {
      status: 'rejected',
      previousRejectStepIndex: step.sort_order
    }, conn);

    // 驳回同样保存独立签署凭证，并绑定此事件。
    await auditEventModel.create(rejectionEventId, {
      ...buildAuditOperatorContext(req, rejecterAssignment),
      submissionId,
      eventType: 'reject',
      stepIndex: step.sort_order,
      round: step.round,
      operatorHrId: hrId,
      operatorName: rejecterAssignment.name,
      comment: rejectionReason || null
    }, conn);

    await createNotification({
      hrId: submission.submitted_by,
      type: 'submission_rejected',
      title: localeCopy.copy_d402fe10f9,
      description: localeCopy.copy_dd6dd4b694 + (submission.title || submission.submission_number) + localeCopy.copy_3848dc7753 + step.sort_order + localeCopy.copy_39bf6116f7 + (rejectionReason ? '：' + rejectionReason : ''),
      category: 'audit',
      targetType: 'submission',
      targetId: submissionId,
      eventKey: ['audit', submissionId, step.round || 1, step.sort_order, 'rejected'].join(':'),
      targetUrl: '/subpackages/audit/pages/submissionDetail/submissionDetail?id=' + submissionId
    }, conn);
    await conn.commit();
    res.json({ status: 'success', message: localeCopy.copy_cd48632f3f });
  } catch (e) {
    await conn.rollback();
    if (e instanceof SigningProtocolError) return res.json({ status: 'signing_unavailable', message: signingCopy.signingUnavailable });
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// updateAuditSubmission — Edit submission metadata, steps, and files when in editable status
router.post('/updateAuditSubmission', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const openid = req.openid;
    const actorContext = await resolveAuditAssignmentActor(req, conn);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    let editorAssignment = actorContext.assignment;
    const hrId = editorAssignment.hr_id;
    const orgId = actorContext.orgId;

    const submissionId = safeString(req.body.submissionId);
    if (!submissionId) return res.json({ status: 'invalid_params', message: localeCopy.copy_fa1dcca5ac });

    let submission = await submissionModel.getById(submissionId);
    if (!submission) return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    if (submission.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
      submission,
      editorAssignment.assignment_id
    )) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_3c5d3583a9 });
    }

    const editableStatuses = ['draft', 'pending', 'rejected', 'withdrawn'];
    if (!editableStatuses.includes(submission.status)) {
      return res.json({ status: 'invalid_state', message: localeCopy.copy_62614a6df0 });
    }

    const title = safeString(req.body.title);
    const description = safeString(req.body.description);
    const newType = safeString(req.body.type) || submission.type;
    const newTemplateId = safeString(req.body.templateId) || null;
    let newResubmitMode = safeString(req.body.resubmitMode) || submission.resubmit_mode;
    const newSteps = Array.isArray(req.body.steps) ? req.body.steps : null;
    const uploadedFiles = Array.isArray(req.body.files) ? req.body.files : null;
    const retainedFileIds = Array.isArray(req.body.retainedFileIds)
      ? Array.from(new Set(req.body.retainedFileIds.map(safeString).filter(Boolean)))
      : null;
    const stepOverrides = normalizeStepOverrides(req.body.stepOverrides);

    if (!title) return res.json({ status: 'invalid_params', message: localeCopy.copy_b99e01d38c });
    if (!['template', 'ad_hoc'].includes(newType) || !isValidResubmitMode(newResubmitMode)) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_d537fa2510 });
    }

    const requestedOverrides = stepOverrides.filter(function(item) {
      return item.personHrIds.length > 0 || item.assignmentIds.length > 0;
    });
    if (requestedOverrides.some(function(item) {
      return !item.personHrIds.length || !item.assignmentIds.length;
    })) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_db47f6c08b });
    }
    if (newType !== 'template' && requestedOverrides.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_5835a49f03 });
    }
    if (requestedOverrides.some(function(item) { return item.stepIndex !== 1; }) || requestedOverrides.length > 1) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_935d2dc973 });
    }

    let templateStepsForEdit = [];
    let templateConditionsForEdit = {};
    let submitterForEdit = null;
    let templateForEdit = null;
    if (newType === 'template') {
      if (!newTemplateId) return res.json({ status: 'invalid_params', message: localeCopy.copy_85cf825c00 });
      templateForEdit = await flowTemplateModel.getById(newTemplateId);
      if (!templateForEdit || !templateForEdit.is_active) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_479f3dbce7 });
      }
      let starterConditionsForEdit = [];
      if (templateForEdit.starter_conditions_json) {
        try { starterConditionsForEdit = JSON.parse(templateForEdit.starter_conditions_json); } catch (_) { starterConditionsForEdit = []; }
      }
      if (!Array.isArray(starterConditionsForEdit)
        || !matchesStarter(templateForEdit, starterConditionsForEdit, editorAssignment)) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_bc75efaa89 });
      }
      if (!isValidResubmitMode(safeString(templateForEdit.resubmit_mode))) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_f428da1450 });
      }
      newResubmitMode = templateForEdit.resubmit_mode;
      templateStepsForEdit = await flowTemplateStepModel.getByTemplateId(newTemplateId);
      if (!templateStepsForEdit.length) return res.json({ status: 'invalid_params', message: localeCopy.copy_f9f6b991ba });
      templateConditionsForEdit = buildTemplateConditionMap(
        await flowTemplateStepConditionModel.getByTemplateId(newTemplateId)
      );
      if (requestedOverrides.length && Number(templateStepsForEdit[0].allow_approver_designation) !== 1) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_670f4a48f1 });
      }
      submitterForEdit = editorAssignment;
    }

    await conn.beginTransaction();
    editorAssignment = await lockAndRefreshAuditActor(conn, actorContext);
    if (!editorAssignment) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_3c5d3583a9 });
    }
    if (newType === 'template') {
      templateForEdit = await flowTemplateModel.getByIdForUpdate(newTemplateId, conn);
      let starterConditionsForEdit = [];
      if (templateForEdit && templateForEdit.starter_conditions_json) {
        try { starterConditionsForEdit = JSON.parse(templateForEdit.starter_conditions_json); } catch (_) { starterConditionsForEdit = []; }
      }
      if (!templateForEdit || !templateForEdit.is_active
        || !isValidResubmitMode(safeString(templateForEdit.resubmit_mode))
        || !Array.isArray(starterConditionsForEdit)
        || !matchesStarter(templateForEdit, starterConditionsForEdit, editorAssignment)) {
        await conn.rollback();
        return res.json({ status: 'forbidden', message: localeCopy.copy_bc75efaa89 });
      }
      newResubmitMode = templateForEdit.resubmit_mode;
      templateStepsForEdit = await flowTemplateStepModel.getByTemplateId(newTemplateId, conn);
      if (!templateStepsForEdit.length) {
        await conn.rollback();
        return res.json({ status: 'invalid_params', message: localeCopy.copy_f9f6b991ba });
      }
      templateConditionsForEdit = buildTemplateConditionMap(
        await flowTemplateStepConditionModel.getByTemplateId(newTemplateId, conn)
      );
      if (requestedOverrides.length && Number(templateStepsForEdit[0].allow_approver_designation) !== 1) {
        await conn.rollback();
        return res.json({ status: 'invalid_params', message: localeCopy.copy_670f4a48f1 });
      }
      submitterForEdit = editorAssignment;
    }
    await lockAuditAssignmentIds(conn, requestedOverrides.flatMap(function(item) {
      return item.assignmentIds;
    }), orgId);

    const lockedSubmission = await submissionModel.getByIdForUpdate(submissionId, conn);
    if (!lockedSubmission) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }
    if (lockedSubmission.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
      lockedSubmission,
      editorAssignment.assignment_id
    )) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_3c5d3583a9 });
    }
    if (!editableStatuses.includes(lockedSubmission.status)) {
      await conn.rollback();
      return res.json({ status: 'invalid_state', message: localeCopy.copy_62614a6df0 });
    }
    if (safeString(lockedSubmission.status) !== safeString(submission.status)
      || safeString(lockedSubmission.type) !== safeString(submission.type)
      || safeString(lockedSubmission.template_id) !== safeString(submission.template_id)) {
      await conn.rollback();
      return res.json({ status: 'state_changed', message: localeCopy.concurrentStateChanged });
    }
    submission = lockedSubmission;

    // Update submission metadata
    await submissionModel.update(submissionId, {
      title,
      description,
      type: newType,
      templateId: newType === 'template' ? newTemplateId : null,
      resubmitMode: newResubmitMode
    }, conn);

    // 历史步骤必须与申请行在同一事务内锁定，避免审批动作与编辑并发改写证据。
    const oldSteps = await submissionStepModel.getBySubmissionIdForUpdate(submissionId, conn);
    let editEventRound = 1;
    for (let osi = 0; osi < oldSteps.length; osi++) {
      if (Number(oldSteps[osi].round) > 0) {
        editEventRound = Math.max(editEventRound, Number(oldSteps[osi].round));
      }
    }
    const preserveHistoricalEvidence = submission.status === 'rejected' || submission.status === 'withdrawn';
    const editedRound = preserveHistoricalEvidence ? 0 : 1;

    if (preserveHistoricalEvidence) {
      // 编辑只保存 round=0/status=draft 的待重提配置，不创建正式审批轮次，
      // 也不改写旧轮次的待办、处理结果、签名或岗位快照。
      await conn.query(
        `DELETE FROM audit_submission_steps
          WHERE submission_id = ? AND round = 0 AND status = 'draft' AND org_id = ?`,
        [submissionId, orgId]
      );
    } else {
      // draft/pending 尚未形成审批证据，可替换其未启用流程。
      await submissionStepModel.removeBySubmissionId(submissionId, conn);
    }

    let stepsToCreate = [];
    if (newType === 'template' && newTemplateId) {
      // Load template steps
      stepsToCreate = templateStepsForEdit.map((ts, idx) => ({
        templateStepId: ts.id,
        sortOrder: idx + 1,
        actionType: ts.action_type || 'sign',
        allowApproverDesignation: Number(ts.allow_approver_designation) === 1,
        name: ts.name || '',
        conditions: templateConditionsForEdit[ts.id] || []
      }));
      const firstOverride = requestedOverrides[0];
      if (firstOverride) {
        stepsToCreate[0].conditions = await narrowTemplateStepConditions(
          stepsToCreate[0].conditions,
          firstOverride.personHrIds,
          firstOverride.assignmentIds,
          submitterForEdit,
          orgId,
          conn
        );
      }
    } else if (newSteps && newSteps.length) {
      // Ad-hoc: use user-provided steps
      stepsToCreate = newSteps.map((s, idx) => {
        let conditions = Array.isArray(s.conditions) ? s.conditions : [];
        if (conditions.length === 0) {
          const scopeType = safeString(s.scopeType) || 'all';
          const approverIdentId = safeString(s.approverIdentityId);
          if (approverIdentId) {
            const cond = {
              conditionType: 'identity_scope',
              identityScope: 'specific',
              specificIdentityId: approverIdentId,
              departmentScope: 'all',
              workGroupScope: 'all'
            };
            if (scopeType === 'same_department') cond.departmentScope = 'own';
            else if (scopeType === 'same_work_group') cond.workGroupScope = 'own';
            else if (scopeType === 'specific_department') {
              cond.departmentScope = 'specific';
              cond.specificDepartmentId = safeString(s.scopeDepartmentId) || null;
            } else if (scopeType === 'specific_work_group') {
              cond.departmentScope = 'specific';
              cond.specificDepartmentId = safeString(s.scopeDepartmentId) || null;
              cond.workGroupScope = 'specific';
              cond.specificWorkGroupId = safeString(s.scopeWorkGroupId) || null;
            }
            conditions.push(cond);
          }
        }
        return {
          templateStepId: null,
          sortOrder: idx + 1,
          approverType: safeString(s.approverType) || null,
          approverHrId: safeString(s.approverHrId) || null,
          approverIdentityId: safeString(s.approverIdentityId) || null,
          actionType: safeString(s.actionType) || 'sign',
          allowApproverDesignation: false,
          name: safeString(s.name) || '',
          conditions
        };
      });
    }

    if (!stepsToCreate.length) {
      throw new Error(localeCopy.auditStepsRequired);
    }
    if (stepsToCreate.length > 0) {
      for (let i = 0; i < stepsToCreate.length; i++) {
        const s = stepsToCreate[i];
        const stepId = generateId();
        assertValidWorkflowStep({ actionType: s.actionType, conditions: s.conditions });
        const normalizedConditions = await normalizePersonConditionsForPersistence(
          s.conditions,
          orgId,
          conn
        );
        if (!normalizedConditions.length && safeString(s.approverHrId)) {
          throw new Error(localeCopy.copy_db47f6c08b);
        }
        let stepConditionsJson = normalizedConditions.length > 0 ? JSON.stringify(normalizedConditions) : null;
        await submissionStepModel.create(stepId, {
          submissionId,
          templateStepId: s.templateStepId || null,
          sortOrder: s.sortOrder,
          approverType: s.approverType || null,
          approverHrId: s.approverHrId || null,
          approverIdentityId: s.approverIdentityId || null,
          actionType: s.actionType || 'sign',
          allowApproverDesignation: s.allowApproverDesignation === true,
          stepName: s.name || s.stepName || '',
          round: editedRound,
          status: preserveHistoricalEvidence ? 'draft' : 'pending',
          stepConditionsJson
        }, conn);
      }
    }

    if (!preserveHistoricalEvidence) {
      // 尚未形成审批历史的草稿可以直接重置为第一步。
      await submissionModel.update(submissionId, { currentStepIndex: 1, previousRejectStepIndex: null }, conn);
    }

    // 编辑端提交“保留的旧附件 ID + 新上传附件”的完整目标集合。被移除的旧附件只退出
    // 当前集合，仍保留在历史中供签名链和验签读取；保留项不得由客户端跨申请伪造。
    // 兼容旧客户端：旧版本会固定提交 files: [] 表示“附件不变”，只有存在
    // 新附件时才沿用其“整组替换”语义；新客户端则通过 retainedFileIds
    // 明确提交完整目标集合。
    if (retainedFileIds !== null || (uploadedFiles && uploadedFiles.length)) {
      const allFiles = await submissionFileModel.getAllBySubmissionId(submissionId, conn, true);
      const currentFiles = allFiles.filter(function(file) { return Number(file.is_current) === 1; });
      const currentIds = new Set(currentFiles.map(function(file) { return safeString(file.id); }));
      if ((retainedFileIds || []).some(function(fileId) { return !currentIds.has(fileId); })) {
        const invalidFileError = new Error(localeCopy.submissionFileInvalid);
        invalidFileError.status = 'invalid_params';
        throw invalidFileError;
      }
      const desiredCount = (retainedFileIds || []).length + (uploadedFiles || []).length;
      if (desiredCount < 1) {
        const missingFileError = new Error(localeCopy.copy_e472aa139d);
        missingFileError.status = 'invalid_params';
        throw missingFileError;
      }
      if (desiredCount > 20) {
        const fileLimitError = new Error(localeCopy.submissionFileLimitExceeded);
        fileLimitError.status = 'invalid_params';
        throw fileLimitError;
      }
      const retentionChanged = currentFiles.length !== (retainedFileIds || []).length;
      if (retentionChanged || (uploadedFiles || []).length) {
        await submissionFileModel.markUnretainedCurrentAsHistorical(
          submissionId,
          retainedFileIds || [],
          conn
        );
        if ((uploadedFiles || []).length) {
          await attachUploadedFiles({
            uploadedFiles,
            submissionId,
            openid,
            conn,
            sortOrderOffset: (retainedFileIds || []).length
          });
        }
      }
      await submissionFileModel.setCurrentRevisionRound(
        submissionId,
        preserveHistoricalEvidence ? 0 : 1,
        conn
      );
    }

    // Insert edit event
    await auditEventModel.create(generateId(), {
      ...buildAuditOperatorContext(req, editorAssignment),
      submissionId,
      eventType: 'edit',
      stepIndex: null,
      round: editEventRound,
      operatorHrId: hrId,
      operatorName: editorAssignment.name,
      comment: null
    }, conn);

    await conn.commit();
    res.json({ status: 'success', message: localeCopy.copy_8e809d8090 });
  } catch (e) {
    await conn.rollback();
    res.json({ status: safeString(e.status) || 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// resubmitAudit — Resubmit after rejection
router.post('/resubmitAudit', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const openid = req.openid;
    const actorContext = await resolveAuditAssignmentActor(req, conn);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    let resubmitterAssignment = actorContext.assignment;
    const hrId = resubmitterAssignment.hr_id;
    const orgId = actorContext.orgId;

    const submissionId = safeString(req.body.submissionId);
    if (!submissionId) return res.json({ status: 'invalid_params', message: localeCopy.copy_fa1dcca5ac });

    let submission = await submissionModel.getById(submissionId);
    if (!submission) return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    if (submission.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
      submission,
      resubmitterAssignment.assignment_id
    )) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_568eb6a072 });
    }
    if (submission.status !== 'rejected' && submission.status !== 'withdrawn' && submission.status !== 'pending') {
      return res.json({ status: 'invalid_state', message: localeCopy.copy_debdfa4054 });
    }

    const stepOverrides = normalizeStepOverrides(req.body.stepOverrides);
    const requestedOverrides = stepOverrides.filter(function(item) {
      return item.personHrIds.length > 0 || item.assignmentIds.length > 0;
    });
    if (requestedOverrides.some(function(item) {
      return !item.personHrIds.length || !item.assignmentIds.length;
    })) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_db47f6c08b });
    }
    if (submission.type !== 'template' && requestedOverrides.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_5835a49f03 });
    }
    if (requestedOverrides.some(function(item) { return item.stepIndex !== 1; }) || requestedOverrides.length > 1) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_935d2dc973 });
    }

    await conn.beginTransaction();
    resubmitterAssignment = await lockAndRefreshAuditActor(conn, actorContext);
    if (!resubmitterAssignment) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_568eb6a072 });
    }
    await lockAuditAssignmentIds(conn, requestedOverrides.flatMap(function(item) {
      return item.assignmentIds;
    }), orgId);

    const lockedSubmission = await submissionModel.getByIdForUpdate(submissionId, conn);
    if (!lockedSubmission) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }
    if (lockedSubmission.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
      lockedSubmission,
      resubmitterAssignment.assignment_id
    )) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_568eb6a072 });
    }
    if (lockedSubmission.status !== 'rejected'
      && lockedSubmission.status !== 'withdrawn'
      && lockedSubmission.status !== 'pending') {
      await conn.rollback();
      return res.json({ status: 'invalid_state', message: localeCopy.copy_debdfa4054 });
    }
    if (safeString(lockedSubmission.status) !== safeString(submission.status)
      || safeString(lockedSubmission.type) !== safeString(submission.type)
      || safeString(lockedSubmission.template_id) !== safeString(submission.template_id)) {
      await conn.rollback();
      return res.json({ status: 'state_changed', message: localeCopy.concurrentStateChanged });
    }
    submission = lockedSubmission;

    // Optional updates during resubmission
    const newTitle = safeString(req.body.title);
    const newDescription = safeString(req.body.description);
    if (newTitle || newDescription) {
      const updateData = {};
      if (newTitle) updateData.title = newTitle;
      if (newDescription) updateData.description = newDescription;
      await submissionModel.update(submissionId, updateData, conn);
    }

    const isWithdrawn = submission.status === 'withdrawn';
    const isPending = submission.status === 'pending';

    const allSteps = await submissionStepModel.getBySubmissionIdForUpdate(submissionId, conn);
    if (!allSteps.length) {
      throw new Error(localeCopy.copy_f428da1450);
    }

    // Clean up: mark all old-round pending steps as 'superseded' so they
    // don't pollute authorization queries that should only see the latest round.
    await conn.query(
      `UPDATE audit_submission_steps
       SET status = 'superseded'
       WHERE submission_id = ? AND status = 'pending' AND org_id = ?`,
      [submissionId, orgId]
    );

    // pending 也必须创建独立新轮次；禁止把旧步骤全部 superseded 后直接置为进行中。
    const resubmitMode = (isWithdrawn || isPending) ? 'fresh' : submission.resubmit_mode;
    const rejectStepIndex = (isWithdrawn || isPending) ? 1 : (submission.previous_reject_step_index || 1);
    if (!isValidResubmitMode(resubmitMode)) {
      throw new Error(localeCopy.copy_f428da1450);
    }
    if (requestedOverrides.length && resubmitMode === 'from_rejector' && Number(rejectStepIndex) !== 1) {
      throw new Error(localeCopy.copy_670f4a48f1);
    }
    // Use MAX round across ALL steps (not just the first one) to ensure
    // round numbers only ever increase, never decrease or repeat.
    let maxExistingRound = 1;
    for (let ri = 0; ri < allSteps.length; ri++) {
      if (Number(allSteps[ri].round) > 0) {
        maxExistingRound = Math.max(maxExistingRound, Number(allSteps[ri].round));
      }
    }
    const newRound = maxExistingRound + 1;
    const draftSteps = allSteps.filter(function(step) {
      return Number(step.round) === 0 && safeString(step.status) === 'draft';
    });
    const latestStepBySortOrder = {};
    const sourceSteps = draftSteps.length
      ? draftSteps
      : allSteps.filter(function(step) { return Number(step.round) > 0; });
    sourceSteps
      .slice()
      .sort(function(a, b) {
        if ((a.round || 1) !== (b.round || 1)) return (a.round || 1) - (b.round || 1);
        return String(a.id).localeCompare(String(b.id));
      })
      .forEach(function(s) {
        latestStepBySortOrder[s.sort_order] = s;
      });
    const canonicalSteps = Object.keys(latestStepBySortOrder)
      .map(function(k) { return latestStepBySortOrder[k]; })
      .sort(function(a, b) { return a.sort_order - b.sort_order; });
    if (!canonicalSteps.length) {
      throw new Error(localeCopy.copy_f428da1450);
    }
    if (requestedOverrides.length && Number(canonicalSteps[0].allow_approver_designation) !== 1) {
      throw new Error(localeCopy.copy_670f4a48f1);
    }

    if (!isWithdrawn && resubmitMode === 'from_rejector') {
      // Create new round entries for all steps from reject step onwards.
      // Recreating only the reject step would leave subsequent steps stranded
      // in the old round, causing the flow to terminate prematurely.
      const remainingSteps = canonicalSteps
        .filter(function(s) { return s.sort_order >= rejectStepIndex; })
        .sort(function(a, b) { return a.sort_order - b.sort_order; });
      for (let rsi = 0; rsi < remainingSteps.length; rsi++) {
        let rs = remainingSteps[rsi];
        let stepId = generateId();
        let conditions = stripDesignationOverrides(parseConditionsJson(rs.step_conditions_json));
        if (!conditions.length) throw new Error(localeCopy.historicalApprovalSnapshotMissing);
        if (requestedOverrides.length && Number(rs.sort_order) === 1) {
          conditions = await narrowTemplateStepConditions(
            conditions,
            requestedOverrides[0].personHrIds,
            requestedOverrides[0].assignmentIds,
            resubmitterAssignment,
            orgId,
            conn
          );
        }
        assertValidWorkflowStep({ actionType: rs.action_type, conditions });
        conditions = await normalizePersonConditionsForPersistence(conditions, orgId, conn);
        await submissionStepModel.create(stepId, {
          submissionId,
          templateStepId: safeString(rs.template_step_id),
          sortOrder: rs.sort_order,
          approverType: rs.approver_type,
          approverHrId: rs.approver_hr_id,
          approverIdentityId: rs.approver_identity_id,
          actionType: rs.action_type,
          allowApproverDesignation: Number(rs.allow_approver_designation) === 1,
          stepName: rs.step_name || rs.name || '',
          round: newRound,
          stepConditionsJson: conditions.length ? JSON.stringify(conditions) : null
        }, conn);
      }
    } else {
      // Fresh mode: create new round entries for ALL steps
      const templateSteps = canonicalSteps;
      for (const ts of templateSteps) {
        const stepId = generateId();
        let conditions = stripDesignationOverrides(parseConditionsJson(ts.step_conditions_json));
        if (!conditions.length) throw new Error(localeCopy.historicalApprovalSnapshotMissing);
        if (requestedOverrides.length && Number(ts.sort_order) === 1) {
          conditions = await narrowTemplateStepConditions(
            conditions,
            requestedOverrides[0].personHrIds,
            requestedOverrides[0].assignmentIds,
            resubmitterAssignment,
            orgId,
            conn
          );
        }
        assertValidWorkflowStep({ actionType: ts.action_type, conditions });
        conditions = await normalizePersonConditionsForPersistence(conditions, orgId, conn);
        await submissionStepModel.create(stepId, {
          submissionId,
          templateStepId: safeString(ts.template_step_id),
          sortOrder: ts.sort_order,
          approverType: ts.approver_type,
          approverHrId: ts.approver_hr_id,
          approverIdentityId: ts.approver_identity_id,
          actionType: ts.action_type,
          allowApproverDesignation: Number(ts.allow_approver_designation) === 1,
          stepName: ts.step_name || ts.name || '',
          round: newRound,
          stepConditionsJson: conditions.length ? JSON.stringify(conditions) : null
        }, conn);
      }
    }

    // 草稿步骤只保存编辑配置；正式新轮次创建成功后在同一事务内清除。
    if (draftSteps.length) {
      await conn.query(
        `DELETE FROM audit_submission_steps
          WHERE submission_id = ? AND round = 0 AND status = 'draft' AND org_id = ?`,
        [submissionId, orgId]
      );
    }

    // 当前附件与正式步骤在同一事务内绑定到完全一致的新轮次。
    await submissionFileModel.getAllBySubmissionId(submissionId, conn, true);
    await submissionFileModel.setCurrentRevisionRound(submissionId, newRound, conn);
    const [fileRoundRows] = await conn.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN revision_round <> ? THEN 1 ELSE 0 END) AS mismatched
         FROM audit_submission_files
        WHERE submission_id = ? AND is_current = 1 AND org_id = ?`,
      [newRound, submissionId, orgId]
    );
    if (Number(fileRoundRows[0] && fileRoundRows[0].total) < 1
      || Number(fileRoundRows[0] && fileRoundRows[0].mismatched) !== 0) {
      throw new Error(localeCopy.resubmitFileRoundInvalid);
    }

    const startStepIndex = resubmitMode === 'from_rejector' ? rejectStepIndex : 1;
    const [newFirstStepRows] = await conn.query(
      `SELECT COUNT(*) AS total
         FROM audit_submission_steps
        WHERE submission_id = ? AND round = ? AND sort_order = ?
          AND status = 'pending' AND org_id = ?`,
      [submissionId, newRound, startStepIndex, orgId]
    );
    if (Number(newFirstStepRows[0] && newFirstStepRows[0].total) !== 1) {
      throw new Error(localeCopy.resubmitFirstStepInvalid);
    }

    // Reset submission status
    await submissionModel.update(submissionId, {
      status: 'in_progress',
      currentStepIndex: startStepIndex,
      submittedPersonId: resubmitterAssignment.person_id,
      submittedAssignmentId: resubmitterAssignment.assignment_id,
      submittedContextSnapshot: assignmentSnapshot(resubmitterAssignment, req.authContext)
    }, conn);

    // Insert resubmit event
    await auditEventModel.create(generateId(), {
      ...buildAuditOperatorContext(req, resubmitterAssignment),
      submissionId,
      eventType: 'resubmit',
      stepIndex: null,
      round: newRound,
      operatorHrId: hrId,
      operatorName: resubmitterAssignment.name,
      comment: null
    }, conn);

    await conn.commit();
    // Notify approvers at the start step (fire-and-forget)
    res.json({
      status: 'success',
      message: isWithdrawn
        ? localeCopy.resubmittedFromStart
        : (resubmitMode === 'from_rejector'
          ? localeCopy.resubmittedFromRejector
          : localeCopy.resubmittedFromStart)
    });
  } catch (e) {
    await conn.rollback();
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// withdrawSubmission — Withdraw own submission
router.post('/withdrawSubmission', async (req, res) => {
  const conn = await pool.getConnection();
  let transactionStarted = false;
  try {
    const actorContext = await resolveAuditAssignmentActor(req, conn);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    let withdrawerAssignment = actorContext.assignment;
    const hrId = withdrawerAssignment.hr_id;
    const orgId = actorContext.orgId;

    const submissionId = safeString(req.body.submissionId);
    if (!submissionId) return res.json({ status: 'invalid_params', message: localeCopy.copy_fa1dcca5ac });

    await conn.beginTransaction();
    transactionStarted = true;
    withdrawerAssignment = await lockAndRefreshAuditActor(conn, actorContext);
    if (!withdrawerAssignment) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'forbidden', message: localeCopy.copy_d494e57d86 });
    }

    const submission = await submissionModel.getByIdForUpdate(submissionId, conn);
    if (!submission) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }
    if (submission.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
      submission,
      withdrawerAssignment.assignment_id
    )) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'forbidden', message: localeCopy.copy_d494e57d86 });
    }
    if (submission.status === 'approved') {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_state', message: localeCopy.copy_842db5ba24 });
    }
    if (submission.status === 'withdrawn') {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_state', message: localeCopy.copy_1a9ab24765 });
    }
    if (submission.status === 'draft') {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_state', message: localeCopy.copy_f2b0cea827 });
    }
    if (submission.status === 'pending') {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_state', message: localeCopy.copy_8e458850a9 });
    }

    await submissionModel.update(submissionId, { status: 'withdrawn' }, conn);

    // Insert withdraw event with actual current round (not hardcoded 1)
    const allSteps = await submissionStepModel.getBySubmissionIdForUpdate(submissionId, conn);
    let currentRound = 1;
    for (let wi = 0; wi < allSteps.length; wi++) {
      currentRound = Math.max(currentRound, allSteps[wi].round || 1);
    }
    await auditEventModel.create(generateId(), {
      ...buildAuditOperatorContext(req, withdrawerAssignment),
      submissionId,
      eventType: 'withdraw',
      stepIndex: null,
      round: currentRound,
      operatorHrId: hrId,
      operatorName: withdrawerAssignment.name,
      comment: null
    }, conn);

    await conn.commit();
    transactionStarted = false;
    res.json({ status: 'success', message: localeCopy.copy_372eb38048 });
  } catch (e) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) {}
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

// listAvailableFlowTemplates — User-facing: list active templates the current user is eligible to start
router.post('/listAvailableFlowTemplates', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const submitterFull = actorContext.assignment;

    const templates = await flowTemplateModel.getActive();
    const result = [];

    for (const t of templates) {
      // Check if user is eligible to start this template
      // Parse starter conditions
      let starterConditions = [];
      if (t.starter_conditions_json) {
        try { starterConditions = JSON.parse(t.starter_conditions_json); } catch (_) {}
      }
      if (!Array.isArray(starterConditions)) starterConditions = [];

      if (!matchesStarter(t, starterConditions, submitterFull)) continue;

      const steps = await flowTemplateStepModel.getByTemplateId(t.id);
      if (!steps.length || steps.some(function(step) {
        const conditions = (step.conditions || []).map(function(condition) {
          return {
            conditionType: condition.condition_type,
            personHrIds: condition.person_hr_ids,
            assignmentIds: condition.assignment_ids,
            departmentScope: condition.department_scope,
            specificDepartmentId: condition.specific_department_id,
            workGroupScope: condition.work_group_scope,
            specificWorkGroupId: condition.specific_work_group_id,
            identityScope: condition.identity_scope,
            specificIdentityId: condition.specific_identity_id
          };
        });
        return !validateStepShape({ actionType: step.action_type, conditions }).ok || !conditions.length;
      })) continue;
      result.push({
        id: safeString(t.id),
        name: safeString(t.name),
        description: safeString(t.description),
        stepCount: steps.length,
        resubmitMode: safeString(t.resubmit_mode)
      });
    }
    res.json({ status: 'success', templates: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// previewTemplateSteps — Returns template steps with resolved condition display info
router.post('/previewTemplateSteps', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }

    const templateId = safeString(req.body.templateId);
    if (!templateId) return res.json({ status: 'invalid_params', message: localeCopy.copy_319cc04882 });

    const template = await flowTemplateModel.getById(templateId);
    if (!template || !template.is_active) return res.json({ status: 'not_found', message: localeCopy.copy_bb180253a4 });

    let starterConditions = [];
    if (template.starter_conditions_json) {
      try { starterConditions = JSON.parse(template.starter_conditions_json); } catch (_) { starterConditions = []; }
    }
    if (!Array.isArray(starterConditions) || !matchesStarter(template, starterConditions, actorContext.assignment)) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_bc75efaa89 });
    }

    const templateSteps = await flowTemplateStepModel.getByTemplateId(templateId);
    const allConditions = await flowTemplateStepConditionModel.getByTemplateId(templateId);
    if (!templateSteps.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_f9f6b991ba });
    }

    // Group conditions by template_step_id
    const stepConditionMap = {};
    for (const c of allConditions) {
      const sid = c.template_step_id;
      if (!stepConditionMap[sid]) stepConditionMap[sid] = [];
      stepConditionMap[sid].push({
        conditionType: c.condition_type,
        personHrIds: c.person_hr_ids,
        assignmentIds: c.assignment_ids,
        departmentScope: c.department_scope,
        specificDepartmentId: c.specific_department_id,
        workGroupScope: c.work_group_scope,
        specificWorkGroupId: c.specific_work_group_id,
        identityScope: c.identity_scope,
        specificIdentityId: c.specific_identity_id
      });
    }
    if (templateSteps.some(function(step) {
      const conditions = stepConditionMap[step.id] || [];
      return !conditions.length || !validateStepShape({
        actionType: step.action_type,
        conditions
      }).ok;
    })) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_f428da1450 });
    }

    // Collect IDs to resolve names
    const orgId = await getCurrentOrgId();
    const hrIdSet = new Set();
    const identIdSet = new Set();
    const deptIdSet = new Set();
    const wgIdSet = new Set();

    for (const sid in stepConditionMap) {
      for (const cond of stepConditionMap[sid]) {
        if (cond.conditionType === 'person' && cond.personHrIds) {
          cond.personHrIds.split(',').forEach(function(id) { hrIdSet.add(id.trim()); });
        } else {
          if (cond.specificDepartmentId) cond.specificDepartmentId.split(',').forEach(function(id) { deptIdSet.add(id.trim()); });
          if (cond.specificWorkGroupId) cond.specificWorkGroupId.split(',').forEach(function(id) { wgIdSet.add(id.trim()); });
          if (cond.specificIdentityId) cond.specificIdentityId.split(',').forEach(function(id) { identIdSet.add(id.trim()); });
        }
      }
    }

    const identityMap = {};
    if (identIdSet.size) {
      const [idRows] = await pool.query('SELECT id, name FROM identities WHERE id IN (?) AND org_id = ?', [[...identIdSet], orgId]);
      for (const r of idRows) identityMap[r.id] = safeString(r.name);
    }
    const deptMap = {};
    if (deptIdSet.size) {
      const [dRows] = await pool.query('SELECT id, name FROM departments WHERE id IN (?) AND org_id = ?', [[...deptIdSet], orgId]);
      for (const r of dRows) deptMap[r.id] = safeString(r.name);
    }
    const wgMap = {};
    if (wgIdSet.size) {
      const [wRows] = await pool.query('SELECT id, name FROM work_groups WHERE id IN (?) AND org_id = ?', [[...wgIdSet], orgId]);
      for (const r of wRows) wgMap[r.id] = safeString(r.name);
    }
    const hrMap = {};
    if (hrIdSet.size) {
      const hrRows = await hrInfoModel.getByIds([...hrIdSet]);
      for (const hr of hrRows) hrMap[hr.id] = safeString(hr.name);
    }

    // Build step preview
    const previewSteps = templateSteps.sort((a, b) => a.sort_order - b.sort_order).map(function(ts, idx) {
      const conds = stepConditionMap[ts.id] || [];
      const actionMap = { pass: '仅通过', sign: '签字', estamp: '盖章', both: '签字+盖章' };
      const actionLabel = actionMap[ts.action_type] || ts.action_type || localeCopy.copy_49cbf30d6b;

      // Build condition display using shared helper
      const condJson = conds.length ? JSON.stringify(conds) : null;
      const display = buildStepConditionsDisplay(condJson, { hrMap, identityMap, deptMap, wgMap });

      return {
        stepIndex: Number(ts.sort_order) || idx + 1,
        sortOrder: Number(ts.sort_order) || idx + 1,
        name: ts.name || '',
        actionType: ts.action_type || 'sign',
        actionLabel: actionLabel,
        allowApproverDesignation: Number(ts.allow_approver_designation) === 1,
        displayParts: display.displayParts,
        approverDesc: display.approverDesc || localeCopy.copy_8705219d19,
        // Pass raw conditions for client-side person override logic
        conditions: conds
      };
    });

    res.json({ status: 'success', steps: previewSteps });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// listMyStamps — Get stamps available for the current user's identity
router.post('/listMyStamps', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const orgId = actorContext.orgId;
    const identityId = actorContext.assignment.identity_id;
    if (!identityId) return res.json({ status: 'success', stamps: [] });

    const assignments = await stampAssignmentModel.getByIdentityId(identityId);
    if (!assignments.length) return res.json({ status: 'success', stamps: [] });

    const stampIds = assignments.map(a => a.stamp_id);
    const [stampRows] = await pool.query(
      'SELECT id, name, image_data FROM stamps WHERE id IN (?) AND org_id = ?',
      [stampIds, orgId]
    );
    const stamps = stampRows.map(s => ({
      id: safeString(s.id),
      name: safeString(s.name),
      imageData: s.image_data || ''
    }));

    res.json({ status: 'success', stamps });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Read Status Tracking
// ═══════════════════════════════════════════════════

// getUnreadCounts — returns unread counts for my submissions + pending count
// Each section is independently fault-tolerant: one failure won't zero out the others
router.post('/getUnreadCounts', async (req, res) => {
  const actorContext = await resolveAuditAssignmentActor(req);
  if (!actorContext.ok) {
    const actorResult = actorContext.actorResult;
    return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
  }
  const hrId = actorContext.assignment.hr_id;

  let pendingCount = 0;
  let mySubmissionsUnread = 0;
  let myApprovalHistoryUnread = 0;
  const orgId = await getCurrentOrgId();

  // ── Pending count (items needing my action) ──
  try {
    const pendingSteps = await submissionStepModel.getPendingByApprover(actorContext.actor, actorContext.assignment);
    pendingCount = pendingSteps.length;
  } catch (e) {
    console.error('[getUnreadCounts] pendingCount failed:', e.message);
  }

  // ── My submissions unread count ──
  try {
    const mySubs = await submissionModel.getAll({
      submittedBy: hrId,
      submittedAssignmentId: actorContext.assignment.assignment_id,
      limit: 200
    });
    const mySubmissionIds = mySubs.map(s => s.id);

    if (mySubmissionIds.length) {
      const [cursors] = await pool.query(
        'SELECT submission_id, last_read_status, last_read_step_index FROM audit_read_cursors WHERE org_id = ? AND hr_id = ? AND submission_id IN (?)',
        [orgId, hrId, mySubmissionIds]
      );
      const cursorMap = {};
      cursors.forEach(c => { cursorMap[c.submission_id] = c; });

      for (const s of mySubs) {
        const c = cursorMap[s.id];
        if (!c || c.last_read_status !== s.status || c.last_read_step_index !== s.current_step_index) {
          mySubmissionsUnread++;
        }
      }
    }
  } catch (e) {
    console.error('[getUnreadCounts] mySubmissionsUnread failed:', e.message);
  }

  // myApprovalHistoryUnread is always 0 — approval history no longer uses read/unread
  // (only mySubmissions retains read/unread functionality)

  res.json({ status: 'success', mySubmissionsUnread, myApprovalHistoryUnread, pendingCount });
});

// markSubmissionRead — mark a single submission as read (upsert cursor)
router.post('/markSubmissionRead', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const hrId = actorContext.assignment.hr_id;

    const submissionId = safeString(req.body.submissionId);
    if (!submissionId) return res.json({ status: 'invalid_params', message: localeCopy.copy_fa1dcca5ac });

    // Get current submission state
    const sub = await submissionModel.getById(submissionId);
    if (!sub) return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    if (sub.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
      sub,
      actorContext.assignment.assignment_id
    )) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_534ae184dc });
    }
    const orgId = await getCurrentOrgId();

    await pool.query(
      `INSERT INTO audit_read_cursors (hr_id, submission_id, org_id, last_read_status, last_read_step_index, read_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE last_read_status = VALUES(last_read_status), last_read_step_index = VALUES(last_read_step_index), read_at = NOW()`,
      [hrId, submissionId, orgId, sub.status, sub.current_step_index]
    );

    res.json({ status: 'success' });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// markAllSubmissionsRead — batch mark all user's submissions as read
router.post('/markAllSubmissionsRead', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const hrId = actorContext.assignment.hr_id;

    // Only mark "my submissions" as read — approval history no longer uses read/unread
    const mySubs = await submissionModel.getAll({
      submittedBy: hrId,
      submittedAssignmentId: actorContext.assignment.assignment_id,
      limit: 500
    });
    const orgId = await getCurrentOrgId();
    for (const s of mySubs) {
      await pool.query(
        `INSERT INTO audit_read_cursors (hr_id, submission_id, org_id, last_read_status, last_read_step_index, read_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE last_read_status = VALUES(last_read_status), last_read_step_index = VALUES(last_read_step_index), read_at = NOW()`,
        [hrId, s.id, orgId, s.status, s.current_step_index]
      );
    }

    res.json({ status: 'success' });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// listMyApprovalHistory — submissions where the current user has approved/rejected a step
// QUERY SOURCE: audit_events table (records actual operator, not template-defined approver_hr_id).
// This correctly captures identity-matched approvers and multi-select approvers that the old
// st.approver_hr_id = ? query missed.
router.post('/listMyApprovalHistory', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const assignmentId = safeString(actorContext.assignment.assignment_id);

    const limit = Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.body.offset, 10) || 0);
    const orgId = actorContext.orgId;
    const historyAssignmentSql = assignmentSqlExpression('e', 'handled_step');

    // 普通用户审批历史严格绑定当前岗位。事件岗位优先，其次使用事件快照；
    // 仅在事件没有岗位信息时才读取同一步骤的处理岗位/快照。
    const [rows] = await pool.query(
      `SELECT s.*, MAX(e.created_at) AS my_last_action_at
       FROM audit_submissions s
       JOIN audit_events e ON s.id = e.submission_id
       LEFT JOIN audit_submission_steps handled_step
         ON handled_step.submission_id = e.submission_id
        AND handled_step.sort_order = e.step_index
        AND handled_step.round = COALESCE(e.round, 1)
        AND handled_step.org_id = e.org_id
       WHERE ${historyAssignmentSql} = ?
         AND s.org_id = ?
         AND e.org_id = ?
         AND e.event_type IN ('approve', 'reject')
       GROUP BY s.id
       ORDER BY my_last_action_at DESC
       LIMIT ? OFFSET ?`,
      [assignmentId, orgId, orgId, limit, offset]
    );

    // Get the steps I handled for each submission (from audit_events)
    const submissionIds = rows.map(r => r.id);
    let myStepsMap = {};
    if (submissionIds.length) {
      const [mySteps] = await pool.query(
        `SELECT e.submission_id, e.step_index AS sort_order,
           e.event_type, e.created_at AS processed_at, e.comment,
           e.operator_person_id, e.operator_assignment_id, e.operator_context_snapshot
         FROM audit_events e
         LEFT JOIN audit_submission_steps handled_step
           ON handled_step.submission_id = e.submission_id
          AND handled_step.sort_order = e.step_index
          AND handled_step.round = COALESCE(e.round, 1)
          AND handled_step.org_id = e.org_id
         WHERE e.submission_id IN (?)
           AND ${historyAssignmentSql} = ?
           AND e.org_id = ?
           AND e.event_type IN ('approve', 'reject')
         ORDER BY e.created_at DESC`,
        [submissionIds, assignmentId, orgId]
      );
      mySteps.forEach((st, stIdx) => {
        if (!myStepsMap[st.submission_id]) myStepsMap[st.submission_id] = [];
        myStepsMap[st.submission_id].push({
          _key: stIdx,
          sortOrder: st.sort_order,
          status: st.event_type === 'approve' ? 'approved' : 'rejected',
          processedAt: st.processed_at,
          comment: safeString(st.comment || ''),
          operatorPersonId: safeString(st.operator_person_id),
          operatorAssignmentId: safeString(st.operator_assignment_id),
          operatorContextSnapshot: parseSnapshot(st.operator_context_snapshot)
        });
      });
    }

    // Load submitter names
    const submitterIds = [...new Set(rows.map(r => r.submitted_by))];
    const hrMap = {};
    if (submitterIds.length) {
      const hrRows = await hrInfoModel.getByIds(submitterIds);
      hrRows.forEach(hr => { hrMap[hr.id] = safeString(hr.name); });
    }

    // Note: isUnread intentionally omitted — approval history no longer uses read/unread
    const result = rows.map(s => {
      return {
        id: safeString(s.id),
        submissionNumber: safeString(s.submission_number),
        title: safeString(s.title),
        description: safeString(s.description),
        type: safeString(s.type),
        status: safeString(s.status),
        currentStepIndex: s.current_step_index,
        submittedBy: safeString(s.submitted_by),
        submitterName: hrMap[s.submitted_by] || localeCopy.copy_8d3451355b,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        mySteps: myStepsMap[s.id] || [],
        myLastActionAt: s.my_last_action_at
      };
    });

    res.json({ status: 'success', items: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// listEligibleApprovers — Return eligible approvers matching a step's conditions
// Used by both Create mode (template step preview) and View mode (designate next approver)
router.post('/listEligibleApprovers', async (req, res) => {
  try {
    const actorContext = await resolveAuditAssignmentActor(req);
    if (!actorContext.ok) {
      const actorResult = actorContext.actorResult;
      return res.json({ status: actorResult.status || 'forbidden', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const hrId = actorContext.assignment.hr_id;

    const orgId = actorContext.orgId;
    const submissionId = safeString(req.body.submissionId);
    const editSubmissionId = safeString(req.body.editSubmissionId);
    const templateId = safeString(req.body.templateId);
    const stepIndex = parseInt(req.body.stepIndex) || 0;

    let conditions = [];
    let submitterInfo = null;
    let hasUnboundLegacyPersonCondition = false;

    if (editSubmissionId) {
      const editSubmission = await submissionModel.getById(editSubmissionId);
      if (!editSubmission || editSubmission.submitted_by !== hrId || !submissionMatchesSubmitterAssignment(
        editSubmission,
        actorContext.assignment.assignment_id
      )) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_1eb23101ee });
      }
      if (!['draft', 'pending', 'rejected', 'withdrawn'].includes(editSubmission.status)) {
        return res.json({ status: 'invalid_state', message: localeCopy.copy_0e544f1c08 });
      }
      if (stepIndex !== 1 || !editSubmission.template_id ||
        (templateId && templateId !== String(editSubmission.template_id))) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_490b4fe026 });
      }
      const editTemplateSteps = await flowTemplateStepModel.getByTemplateId(editSubmission.template_id);
      const editTargetStep = editTemplateSteps.find(function(step) { return Number(step.sort_order) === 1; });
      if (!editTargetStep) return res.json({ status: 'not_found', message: localeCopy.copy_7913354ccb });
      if (Number(editTargetStep.allow_approver_designation) !== 1) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_670f4a48f1 });
      }
      const editConditions = await submissionStepModel.getTemplateStepConditions(editTargetStep.id);
      conditions = Array.isArray(editConditions) ? editConditions : [];
      hasUnboundLegacyPersonCondition = editTargetStep.approver_type === 'specific_person'
        && !conditions.length;
      submitterInfo = actorContext.assignment;
    } else if (submissionId) {
      // View mode: resolve next step's conditions from the submission
      const submission = await submissionModel.getById(submissionId);
      if (!submission) return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });

      const allSteps = await submissionStepModel.getBySubmissionId(submissionId);
      const currentIdx = submission.current_step_index || 0;
      const currentRound = Math.max(...allSteps.map(function(s) { return s.round || 1; }));
      const currentRoundSteps = allSteps
        .filter(function(s) { return (s.round || 1) === currentRound; })
        .sort(function(a, b) { return a.sort_order - b.sort_order; });
      const currentStep = currentRoundSteps.find(function(s) { return s.sort_order === currentIdx; });
      const nextStep = currentRoundSteps.find(function(s) { return s.sort_order === currentIdx + 1; });

      if (!currentStep) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_4d7982666d });
      }
      const currentAuthorization = await checkStepAuthorization(
        currentStep,
        submission,
        actorContext.assignment
      );
      if (!currentAuthorization.authorized) {
        return res.json({
          status: currentAuthorization.snapshotValid ? 'forbidden' : 'historical_snapshot_missing',
          message: currentAuthorization.snapshotValid
            ? localeCopy.copy_4d7982666d
            : localeCopy.historicalApprovalSnapshotMissing
        });
      }
      if (!nextStep) {
        return res.json({ status: 'success', approvers: [], message: localeCopy.copy_798fa078a7 });
      }
      if (Number(nextStep.allow_approver_designation) !== 1) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_97d569974c });
      }

      // Parse next step's conditions
      if (nextStep.step_conditions_json) {
        try {
          conditions = JSON.parse(nextStep.step_conditions_json);
          if (!Array.isArray(conditions)) throw new Error();
        } catch (_) {
          return res.json({ status: 'forbidden', message: localeCopy.copy_4d7982666d });
        }
      }

      if (!conditions.length) {
        return res.json({
          status: 'historical_snapshot_missing',
          message: localeCopy.historicalApprovalSnapshotMissing
        });
      }
      hasUnboundLegacyPersonCondition = nextStep.approver_type === 'specific_person'
        && !conditions.length;

      // Load submitter for 'own' scope resolution
      submitterInfo = await getSubmissionSubmitterAssignments(submission, orgId);
      if (!submitterInfo.length) {
        return res.json({
          status: 'historical_snapshot_missing',
          message: localeCopy.historicalApprovalSnapshotMissing
        });
      }
    } else if (templateId && stepIndex > 0) {
      // Create mode: resolve template step conditions
      if (stepIndex !== 1) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_2f878cb2da });
      }
      const template = await flowTemplateModel.getById(templateId);
      if (!template || !template.is_active) {
        return res.json({ status: 'not_found', message: localeCopy.copy_bb180253a4 });
      }
      const templateSteps = await flowTemplateStepModel.getByTemplateId(templateId);
      const targetStep = templateSteps.find(function(s) { return Number(s.sort_order) === stepIndex; });
      if (!targetStep) {
        return res.json({ status: 'not_found', message: localeCopy.copy_7913354ccb });
      }
      if (Number(targetStep.allow_approver_designation) !== 1) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_670f4a48f1 });
      }

      const tplConds = await submissionStepModel.getTemplateStepConditions(targetStep.id);
      if (tplConds) conditions = tplConds;
      hasUnboundLegacyPersonCondition = targetStep.approver_type === 'specific_person'
        && !conditions.length;

      // For Create mode, use the current user as submitter (for 'own' scope)
      submitterInfo = actorContext.assignment;
      let starterConditions = [];
      if (template.starter_conditions_json) {
        try { starterConditions = JSON.parse(template.starter_conditions_json); } catch (_) { starterConditions = []; }
      }
      if (!matchesStarter(template, starterConditions, actorContext.assignment)) {
        return res.json({ status: 'forbidden', message: localeCopy.copy_bc75efaa89 });
      }
    } else if (!(req.body && req.body.all === true)) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_d537fa2510 });
    }

    // 自定义流程的“指定人员添加”需要完整目录；目录仍严格限制在当前组织，
    // 不复用管理员专用的 listHrInfo 接口。
    if (req.body && req.body.all === true && !submissionId && !templateId) {
      const allAssignments = await listActiveAssignments(orgId);
      return res.json({ status: 'success', approvers: groupEligibleCandidates(allAssignments) });
    }

    if (hasUnboundLegacyPersonCondition) {
      return res.json({ status: 'success', approvers: [] });
    }

    if (!conditions.length) {
      return res.json({
        status: submissionId ? 'historical_snapshot_missing' : 'invalid_params',
        message: submissionId
          ? localeCopy.historicalApprovalSnapshotMissing
          : localeCopy.copy_e6048310d4
      });
    }
    if (conditions.some(function(condition) { return !validateConditionShape(condition).ok; })) {
      return res.json({
        status: submissionId ? 'historical_snapshot_missing' : 'invalid_params',
        message: submissionId
          ? localeCopy.historicalApprovalSnapshotMissing
          : localeCopy.copy_e6048310d4
      });
    }

    // 候选范围始终从当前组织的有效岗位目录计算。
    // Check if all conditions are effectively "all" (identity_scope with all scopes = 'all')
    const allAreOpen = conditions.every(function(c) {
      if (c.conditionType === 'person') return false;
      return (c.departmentScope || 'all') === 'all' &&
             (c.workGroupScope || 'all') === 'all' &&
             (c.identityScope || 'all') === 'all';
    });
    if (allAreOpen) {
      const allAssignments = await listActiveAssignments(orgId);
      return res.json({ status: 'success', approvers: groupEligibleCandidates(allAssignments) });
    }

    const allAssignments = await listActiveAssignments(orgId);
    const eligibleAssignments = allAssignments.filter(function(assignment) {
      return matchesAnyCondition(conditions, assignment, submitterInfo);
    });

    res.json({ status: 'success', approvers: groupEligibleCandidates(eligibleAssignments) });
  } catch (e) {
    console.error('[audit:listEligibleApprovers] error:', e);
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

module.exports = router;
