const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/routes/auditAdmin');
const retiredCopy = require('../../../locales/zh-CN/generated/core/routes/admin');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../../utils/helpers');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pool = require('../../../config/db');
const { resolveRequestAdmin: ensureAdmin } = require('../../../core/services/adminRequestContext');
const hrInfoModel = require('../../../core/models/hrInfo');
const flowTemplateModel = require('../models/auditFlowTemplate');
const flowTemplateStepModel = require('../models/auditFlowTemplateStep');
const flowTemplateStepConditionModel = require('../models/auditFlowTemplateStepCondition');
const stampModel = require('../models/stamp');
const stampAssignmentModel = require('../models/identityStampAssignment');
const stampGrantModel = require('../models/stampAssignmentGrant');
const stampCopy = require('../../../locales/zh-CN/stampAuthorization');
const submissionModel = require('../models/auditSubmission');
const submissionStepModel = require('../models/auditSubmissionStep');
const submissionFileModel = require('../models/auditSubmissionFile');
const submissionSignatureModel = require('../models/auditSubmissionSignature');
const auditEventModel = require('../models/auditEvent');
const verificationPermModel = require('../models/verificationPermission');
const {
  resolveAndValidateBindings
} = require('../services/auditPersonAssignmentCondition');
const {
  validateConditionShape,
  validateStepShape,
  isValidResubmitMode
} = require('../services/auditWorkflowPolicy');
const dictionaryUsage = require('../../../core/services/dictionaryUsage');
const { inspectAuditImageData } = require('../utils/auditImageData');

function collectDictionaryReferences(condition) {
  const item = condition || {};
  return {
    departmentIds: [item.specificDepartmentId, item.specificDepartmentIds],
    identityCategoryIds: [item.specificIdentityId, item.specificIdentityIds],
    workGroupIds: [item.specificWorkGroupId, item.specificWorkGroupIds]
  };
}

// ═══════════════════════════════════════════════════
// Audit Flow Templates
// ═══════════════════════════════════════════════════

// listAuditFlowTemplates
router.post('/listAuditFlowTemplates', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const templates = await flowTemplateModel.getAll();
    // Load steps for each template
    const result = [];
    for (const t of templates) {
      const steps = await flowTemplateStepModel.getByTemplateId(t.id);
      // Parse starter conditions JSON
      let starterConditions = [];
      if (t.starter_conditions_json) {
        try {
          starterConditions = JSON.parse(t.starter_conditions_json);
        } catch (_) { starterConditions = []; }
      }
      result.push({
        id: safeString(t.id),
        name: safeString(t.name),
        description: safeString(t.description),
        starterType: safeString(t.starter_type),
        starterIdentityId: safeString(t.starter_identity_id),
        starterHrId: safeString(t.starter_hr_id),
        starterConditionsJson: t.starter_conditions_json || null,
        starterConditions: starterConditions.map(function(c) { return {
          conditionType: safeString(c.conditionType),
          personHrIds: safeString(c.personHrIds),
          assignmentIds: safeString(c.assignmentIds),
          departmentScope: safeString(c.departmentScope),
          specificDepartmentId: safeString(c.specificDepartmentId),
          workGroupScope: safeString(c.workGroupScope),
          specificWorkGroupId: safeString(c.specificWorkGroupId),
          identityScope: safeString(c.identityScope),
          specificIdentityId: safeString(c.specificIdentityId)
        }; }),
        resubmitMode: safeString(t.resubmit_mode),
        isActive: t.is_active === 1,
        createdBy: safeString(t.created_by),
        stepCount: steps.length,
        steps: steps.map((s) => ({
          id: safeString(s.id),
          sortOrder: s.sort_order,
          name: s.name || '',
          approverType: safeString(s.approver_type),
          approverIdentityId: safeString(s.approver_identity_id),
          approverHrId: safeString(s.approver_hr_id),
          relatedRelation: safeString(s.related_relation),
          actionType: safeString(s.action_type),
          allowApproverDesignation: s.allow_approver_designation === 1,
          conditions: (s.conditions || []).map((c) => ({
            id: safeString(c.id),
            sortOrder: c.sort_order,
            conditionType: safeString(c.condition_type),
            personHrIds: safeString(c.person_hr_ids),
            assignmentIds: safeString(c.assignment_ids),
            departmentScope: safeString(c.department_scope),
            specificDepartmentId: safeString(c.specific_department_id),
            workGroupScope: safeString(c.work_group_scope),
            specificWorkGroupId: safeString(c.specific_work_group_id),
            identityScope: safeString(c.identity_scope),
            specificIdentityId: safeString(c.specific_identity_id)
          }))
        })),
        createdAt: t.created_at,
        updatedAt: t.updated_at
      });
    }
    res.json({ status: 'success', templates: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveAuditFlowTemplate
router.post('/saveAuditFlowTemplate', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const orgId = await getCurrentOrgId();
    if (!orgId) return res.json({ status: 'invalid_params', message: localeCopy.copy_e0aaf03f8a });
    const description = safeString(req.body.description);
    const starterType = safeString(req.body.starterType) || 'conditions';
    const starterIdentityId = safeString(req.body.starterIdentityId);
    const starterHrId = safeString(req.body.starterHrId);
    const resubmitMode = safeString(req.body.resubmitMode) || 'fresh';
    const starterConditions = Array.isArray(req.body.starterConditions) ? req.body.starterConditions : [];
    const steps = Array.isArray(req.body.steps) ? req.body.steps : [];

    if (!name) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_cf05c2ba56 });
    }
    if (!steps.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_4ac0ae43dd });
    }
    if (starterType === 'specific_person') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_10d3269bb4 });
    }
    if (!['conditions', 'self', 'identity'].includes(starterType)
      || !isValidResubmitMode(resubmitMode)
      || (starterType === 'conditions' && !starterConditions.length)
      || (starterType !== 'conditions' && starterConditions.length)
      || (starterType === 'identity' && !starterIdentityId)) {
      return res.json({ status: 'invalid_params', message: localeCopy.workflowConfigurationInvalid });
    }

    for (let si = 0; si < starterConditions.length; si++) {
      const starterCondition = starterConditions[si];
      if (!starterCondition || typeof starterCondition !== 'object' || Array.isArray(starterCondition)) {
        return res.json({ status: 'invalid_params', message: localeCopy.workflowConfigurationInvalid });
      }
      if (starterCondition.conditionType !== 'person') continue;
      const binding = await resolveAndValidateBindings(starterCondition, orgId);
      if (!binding.ok) {
        return res.json({
          status: 'invalid_params',
          reason: binding.reason,
          message: localeCopy.copy_10d3269bb4
        });
      }
      starterCondition.personHrIds = binding.condition.personHrIds;
      starterCondition.assignmentIds = binding.condition.assignmentIds;
    }
    if (starterConditions.some(function(condition) { return !validateConditionShape(condition).ok; })) {
      return res.json({ status: 'invalid_params', message: localeCopy.workflowConfigurationInvalid });
    }

    // Validate each step has at least one valid condition with proper IDs
    for (let vi = 0; vi < steps.length; vi++) {
      const vstep = steps[vi];
      if (!vstep || typeof vstep !== 'object' || Array.isArray(vstep)) {
        return res.json({ status: 'invalid_params', message: localeCopy.workflowConfigurationInvalid });
      }
      const vconditions = Array.isArray(vstep.conditions) ? vstep.conditions : [];
      if (!vconditions.length && !(vstep.approverType || vstep.approverIdentityId || vstep.approverHrId)) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_93c50c01c0 + (vi + 1) + localeCopy.copy_287253008b });
      }
      if (!vconditions.length && safeString(vstep.approverType) === 'specific_person') {
        const legacyBinding = await resolveAndValidateBindings({
          personHrIds: vstep.approverHrId,
          assignmentIds: vstep.approverAssignmentIds || vstep.assignmentIds
        }, orgId);
        if (!legacyBinding.ok) {
          return res.json({
            status: 'invalid_params',
            reason: legacyBinding.reason,
            message: localeCopy.copy_eb6b0a83d2 + (vi + 1) + localeCopy.copy_5f90e06fa0
          });
        }
        vstep.approverHrId = legacyBinding.condition.personHrIds;
        vstep.approverAssignmentIds = legacyBinding.condition.assignmentIds;
      }
      for (let vj = 0; vj < vconditions.length; vj++) {
        const vc = vconditions[vj];
        if (!vc || typeof vc !== 'object' || Array.isArray(vc)) {
          return res.json({ status: 'invalid_params', message: localeCopy.workflowConfigurationInvalid });
        }
        if (vc.conditionType === 'person') {
          const binding = await resolveAndValidateBindings(vc, orgId);
          if (!binding.ok) {
            return res.json({ status: 'invalid_params', message: localeCopy.copy_eb6b0a83d2 + (vi + 1) + localeCopy.copy_5f90e06fa0 });
          }
          vc.personHrIds = binding.condition.personHrIds;
          vc.assignmentIds = binding.condition.assignmentIds;
        } else {
          if (vc.departmentScope === 'specific' && (typeof vc.specificDepartmentId !== 'string' || !vc.specificDepartmentId.trim())) {
            return res.json({ status: 'invalid_params', message: localeCopy.copy_93c50c01c0 + (vi + 1) + localeCopy.copy_61ae470673 + (vj + 1) + localeCopy.copy_c4dc113412 });
          }
          if (vc.workGroupScope === 'specific' && (typeof vc.specificWorkGroupId !== 'string' || !vc.specificWorkGroupId.trim())) {
            return res.json({ status: 'invalid_params', message: localeCopy.copy_93c50c01c0 + (vi + 1) + localeCopy.copy_61ae470673 + (vj + 1) + localeCopy.copy_5fed9cfcc5 });
          }
          if (vc.identityScope === 'specific' && (typeof vc.specificIdentityId !== 'string' || !vc.specificIdentityId.trim())) {
            return res.json({ status: 'invalid_params', message: localeCopy.copy_93c50c01c0 + (vi + 1) + localeCopy.copy_61ae470673 + (vj + 1) + localeCopy.copy_20ef4f329b });
          }
        }
      }
      // 校验必须处于当前步骤的作用域内，并在打开事务前完成。
      let validationConditions = vconditions;
      if (!validationConditions.length && safeString(vstep.approverType) === 'specific_person') {
        validationConditions = [{
          conditionType: 'person',
          personHrIds: vstep.approverHrId,
          assignmentIds: vstep.approverAssignmentIds || vstep.assignmentIds
        }];
      } else if (!validationConditions.length && safeString(vstep.approverType) === 'identity'
        && safeString(vstep.approverIdentityId)) {
        validationConditions = [{
          conditionType: 'identity_scope',
          departmentScope: 'all',
          workGroupScope: 'all',
          identityScope: 'specific',
          specificIdentityId: vstep.approverIdentityId
        }];
      }
      if (!validateStepShape({ actionType: vstep.actionType, conditions: validationConditions }).ok) {
        return res.json({ status: 'invalid_params', message: localeCopy.workflowConfigurationInvalid });
      }
    }

    // Build starter conditions JSON if provided
    let starterConditionsJson = null;
    if (starterConditions.length) {
      starterConditionsJson = JSON.stringify(starterConditions.map(function(c) {
        let cond = { conditionType: c.conditionType };
        if (c.conditionType === 'person') {
          cond.personHrIds = c.personHrIds || '';
          cond.assignmentIds = c.assignmentIds || '';
        } else {
          cond.departmentScope = c.departmentScope || 'all';
          cond.specificDepartmentId = c.specificDepartmentId || null;
          cond.workGroupScope = c.workGroupScope || 'all';
          cond.specificWorkGroupId = c.specificWorkGroupId || null;
          cond.identityScope = c.identityScope || 'all';
          cond.specificIdentityId = c.specificIdentityId || null;
        }
        return cond;
      }));
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const allConditions = starterConditions.slice();
      for (const step of steps) {
        const stepConditions = Array.isArray(step.conditions) ? step.conditions : [];
        allConditions.push(...stepConditions);
        if (!stepConditions.length && step.approverIdentityId) {
          allConditions.push({ specificIdentityId: step.approverIdentityId });
        }
      }
      await dictionaryUsage.lockOrganizationDictionaryWrites(orgId, conn);
      for (const condition of allConditions) {
        await dictionaryUsage.assertDictionaryReferences(Object.assign({
          organizationId: orgId,
          connection: conn
        }, collectDictionaryReferences(condition)));
      }

      let templateId;
      if (id) {
        templateId = id;
        const lockedTemplate = await flowTemplateModel.getByIdForUpdate(id, conn);
        if (!lockedTemplate) {
          const notFoundError = new Error(localeCopy.workflowConfigurationInvalid);
          notFoundError.status = 'not_found';
          throw notFoundError;
        }
        await flowTemplateModel.update(id, {
          name, description, starterType,
          starterIdentityId: starterIdentityId || null,
          starterHrId: starterHrId || null,
          starterConditionsJson,
          resubmitMode,
          isActive: true
        }, conn);
        // Remove old steps, re-insert
        await flowTemplateStepModel.removeByTemplateId(id, conn);
      } else {
        templateId = generateId();
        await flowTemplateModel.create(templateId, {
          name, description, starterType,
          starterIdentityId: starterIdentityId || null,
          starterHrId: starterHrId || null,
          starterConditionsJson,
          resubmitMode,
          createdBy: admin.id
        }, conn);
      }

      // Insert steps with conditions
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepId = generateId();
        await flowTemplateStepModel.create(stepId, {
          templateId,
          sortOrder: i + 1,
          actionType: safeString(step.actionType) || 'sign',
          allowApproverDesignation: step.allowApproverDesignation === true,
          name: safeString(step.name) || ''
        }, conn);

        // Create conditions for this step
        const conditions = Array.isArray(step.conditions) ? step.conditions : [];
        // If no conditions provided, try legacy fields
        if (!conditions.length && (step.approverType || step.approverIdentityId || step.approverHrId)) {
          const legacyCondId = generateId();
          const legacyType = safeString(step.approverType) || 'identity';
          if (legacyType === 'specific_person' && step.approverHrId) {
            const legacyBinding = await resolveAndValidateBindings({
              personHrIds: step.approverHrId,
              assignmentIds: step.approverAssignmentIds || step.assignmentIds
            }, orgId, conn);
            if (!legacyBinding.ok) {
              const bindingError = new Error(localeCopy.copy_eb6b0a83d2 + (i + 1) + localeCopy.copy_5f90e06fa0);
              bindingError.code = legacyBinding.reason;
              throw bindingError;
            }
            await flowTemplateStepConditionModel.create(legacyCondId, {
              templateStepId: stepId,
              sortOrder: 1,
              conditionType: 'person',
              personHrIds: legacyBinding.condition.personHrIds,
              assignmentIds: legacyBinding.condition.assignmentIds
            }, conn);
          } else if (legacyType === 'identity' && step.approverIdentityId) {
            await flowTemplateStepConditionModel.create(legacyCondId, {
              templateStepId: stepId,
              sortOrder: 1,
              conditionType: 'identity_scope',
              identityScope: 'specific',
              specificIdentityId: safeString(step.approverIdentityId)
            }, conn);
          }
        } else {
          for (let j = 0; j < conditions.length; j++) {
            const cond = conditions[j];
            const condId = generateId();
            await flowTemplateStepConditionModel.create(condId, {
              templateStepId: stepId,
              sortOrder: j + 1,
              conditionType: safeString(cond.conditionType) || 'identity_scope',
              personHrIds: safeString(cond.personHrIds) || null,
              assignmentIds: safeString(cond.assignmentIds) || null,
              departmentScope: safeString(cond.departmentScope) || 'all',
              specificDepartmentId: safeString(cond.specificDepartmentId) || null,
              workGroupScope: safeString(cond.workGroupScope) || 'all',
              specificWorkGroupId: safeString(cond.specificWorkGroupId) || null,
              identityScope: safeString(cond.identityScope) || 'all',
              specificIdentityId: safeString(cond.specificIdentityId) || null
            }, conn);
          }
        }
      }

      await conn.commit();
      res.json({ status: 'success', id: templateId, message: id ? localeCopy.copy_c0182529aa : localeCopy.copy_e06667ae8f });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    res.json({ status: safeString(e.status) || 'error', message: safeString(e.message) });
  }
});

// deleteAuditFlowTemplate
router.post('/deleteAuditFlowTemplate', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_319cc04882 });

    // Check if any submissions reference this template
    const orgId = await getCurrentOrgId();
    const [submissions] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM audit_submissions WHERE template_id = ? AND org_id = ?',
      [id, orgId]
    );
    if (submissions[0] && submissions[0].cnt > 0) {
      return res.json({ status: 'in_use', message: localeCopy.copy_f6152889c8 });
    }

    await flowTemplateModel.remove(id);
    res.json({ status: 'success', message: localeCopy.copy_efc8493bdc });
  } catch (e) {
    console.error('[audit:stamp:list] failed:', e);
    res.json({ status: 'error', message: localeCopy.stampOperationFailed });
  }
});

// ═══════════════════════════════════════════════════
// Stamps Management
// ═══════════════════════════════════════════════════

// listStamps
router.post('/listStamps', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const stamps = await stampModel.getAll();
    const assignments = await stampAssignmentModel.getAllGrouped();
    const grants = await stampGrantModel.listGrants();

    // Build stamp → identity list map
    const stampIdentityMap = {};
    for (const a of assignments) {
      if (!stampIdentityMap[a.stamp_id]) stampIdentityMap[a.stamp_id] = [];
      stampIdentityMap[a.stamp_id].push({
        identityId: safeString(a.identity_id),
        stampName: safeString(a.stamp_name)
      });
    }

    const result = stamps.map((s) => ({
      id: safeString(s.id),
      name: safeString(s.name),
      imageData: s.image_data || '',
      assignedIdentities: stampIdentityMap[s.id] || [],
      assignedPeople: grants.filter(grant => grant.stampId === s.id),
      createdBy: safeString(s.created_by),
      createdAt: s.created_at
    }));

    res.json({ status: 'success', stamps: result });
  } catch (e) {
    console.error('[audit:stamp:list] failed:', e);
    res.json({ status: 'error', message: localeCopy.stampOperationFailed });
  }
});

// saveStamp
router.post('/saveStamp', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const imageData = safeString(req.body.imageData);

    if (!name) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_76f2662073 });
    }
    if (!imageData) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_9c1d248076 });
    }
    if (Array.from(name).length > 200) {
      return res.json({ status: 'invalid_params', message: localeCopy.stampNameTooLong });
    }
    const imageInspection = inspectAuditImageData(imageData);
    if (!imageInspection.ok) {
      return res.json({
        status: 'invalid_params',
        message: imageInspection.reason === 'too_large'
          ? localeCopy.stampImageTooLarge
          : localeCopy.stampImageInvalid
      });
    }

    if (id) {
      const updated = await stampModel.update(id, { name, imageData });
      if (!updated) {
        return res.json({ status: 'not_found', message: localeCopy.copy_fc971e88db });
      }
      res.json({ status: 'success', message: localeCopy.copy_161855b67c });
    } else {
      const newId = generateId();
      await stampModel.create(newId, { name, imageData, createdBy: admin.id });
      res.json({ status: 'success', id: newId, message: localeCopy.copy_8e51c9c0df });
    }
  } catch (e) {
    console.error('[audit:stamp:save] failed:', e);
    res.json({ status: 'error', message: localeCopy.stampOperationFailed });
  }
});

// deleteStamp
router.post('/deleteStamp', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_fc971e88db });

    const removed = await stampModel.remove(id);
    if (!removed) {
      return res.json({ status: 'not_found', message: localeCopy.copy_fc971e88db });
    }
    res.json({ status: 'success', message: localeCopy.copy_a5d4679cf0 });
  } catch (e) {
    console.error('[audit:stamp:delete] failed:', e);
    res.json({ status: 'error', message: localeCopy.stampOperationFailed });
  }
});

// 印章可用人仅由当前组织的印章管理权限配置，候选接口不依赖人事管理权限。
router.post('/listStampCandidates', async (req, res) => {
  try {
    if (!await ensureAdmin(req)) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    res.json({ status: 'success', candidates: await stampGrantModel.listCandidates() });
  } catch (error) {
    console.error('[audit:stamp:candidates] failed:', error);
    res.json({ status: 'error', message: stampCopy.failed });
  }
});

router.post('/saveStampGrants', async (req, res) => {
  try {
    if (!await ensureAdmin(req)) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const result = await stampGrantModel.replaceForStamp(safeString(req.body.stampId), req.body.assignmentIds);
    const messages = { invalid_params: stampCopy.invalidSelection, assignment_unavailable: stampCopy.unavailable,
      stamp_not_found: localeCopy.copy_fc971e88db, success: stampCopy.saved };
    res.json({ status: result.status, message: messages[result.status] || stampCopy.failed });
  } catch (error) {
    console.error('[audit:stamp:grants] failed:', error);
    res.json({ status: 'error', message: stampCopy.failed });
  }
});

// 旧类别授权入口退役，不能继续扩大为整类岗位的用章权限。
router.post('/saveStampAssignments', async (req, res) => {
  return res.status(410).json({ status: 'legacy_api_retired', message: stampCopy.legacyRetired });
});

// listIdentityStamps — Get stamps available for an identity
router.post('/listIdentityStamps', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// ═══════════════════════════════════════════════════
// Verification Permissions
// ═══════════════════════════════════════════════════

// listVerificationPermissions
router.post('/listVerificationPermissions', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const perms = await verificationPermModel.getAll();
    const result = perms.map((p) => ({
      id: safeString(p.id),
      granteeHrId: safeString(p.grantee_hr_id),
      granteeName: safeString(p.grantee_name) || localeCopy.copy_8d3451355b,
      grantedBy: safeString(p.granted_by),
      createdAt: p.created_at
    }));

    res.json({ status: 'success', permissions: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVerificationPermission
router.post('/saveVerificationPermission', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const granteeHrId = safeString(req.body.granteeHrId);
    const action = safeString(req.body.action) || 'grant'; // 'grant' or 'revoke'

    if (!granteeHrId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_7d1a305d97 });
    }

    if (action === 'revoke') {
      const removed = await verificationPermModel.removeByGrantee(granteeHrId);
      if (!removed) {
        return res.json({ status: 'not_found', message: localeCopy.copy_7d1a305d97 });
      }
      res.json({ status: 'success', message: localeCopy.copy_c2eabcfd63 });
    } else {
      const newId = generateId();
      const result = await verificationPermModel.create(newId, { granteeHrId, grantedBy: admin.id });
      if (result.status === 'grantee_not_found') {
        return res.json({ status: 'not_found', message: localeCopy.copy_7d1a305d97 });
      }
      if (result.status === 'duplicate') {
        return res.json({ status: 'duplicate', message: localeCopy.copy_dcc2e39631 });
      }
      res.json({ status: 'success', message: localeCopy.copy_31f5d1514b });
    }
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Admin Submission Monitoring
// ═══════════════════════════════════════════════════

// listAllAuditSubmissions — Admin view of all submissions
router.post('/listAllAuditSubmissions', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const filters = {
      status: safeString(req.body.status) || null,
      type: safeString(req.body.type) || null,
      limit: Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 50)),
      offset: Math.max(0, parseInt(req.body.offset, 10) || 0)
    };

    const submissions = await submissionModel.getAll(filters);

    // Load submitter names
    const submitterIds = [...new Set(submissions.map((s) => s.submitted_by))];
    const hrMap = {};
    if (submitterIds.length) {
      const hrRows = await hrInfoModel.getByIds(submitterIds);
      for (const hr of hrRows) {
        hrMap[hr.id] = safeString(hr.name);
      }
    }

    const result = submissions.map((s) => ({
      id: safeString(s.id),
      submissionNumber: safeString(s.submission_number),
      title: safeString(s.title),
      description: safeString(s.description),
      type: safeString(s.type),
      status: safeString(s.status),
      submittedBy: safeString(s.submitted_by),
      submitterName: hrMap[s.submitted_by] || localeCopy.copy_8d3451355b,
      currentStepIndex: s.current_step_index,
      resubmitMode: safeString(s.resubmit_mode),
      createdAt: s.created_at,
      updatedAt: s.updated_at
    }));

    res.json({ status: 'success', submissions: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

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

  for (const cond of conditions) {
    let part = '';
    if (cond.conditionType === 'person') {
      const ids = (cond.personHrIds || '').split(',').map(s => s.trim()).filter(Boolean);
      const names = ids.map(id => hrMap[id] || id).filter(Boolean);
      part = names.length ? '由 ' + names.join('、') + localeCopy.copy_7abed5378f : '由指定人员审批';
    } else {
      const scopeParts = [];
      if (cond.departmentScope === 'own') scopeParts.push('同部门');
      else if (cond.departmentScope === 'specific' && cond.specificDepartmentId) {
        const deptIds = cond.specificDepartmentId.split(',').map(s => s.trim()).filter(Boolean);
        const deptNames = deptIds.map(id => deptMap[id] || id).filter(Boolean);
        if (deptNames.length) scopeParts.push(deptNames.join('、'));
      }
      if (cond.workGroupScope === 'own') scopeParts.push('同职能组');
      else if (cond.workGroupScope === 'specific' && cond.specificWorkGroupId) {
        const wgIds = cond.specificWorkGroupId.split(',').map(s => s.trim()).filter(Boolean);
        const wgNames = wgIds.map(id => wgMap[id] || id).filter(Boolean);
        if (wgNames.length) scopeParts.push(wgNames.join('、'));
      }
      if (cond.identityScope === 'own') scopeParts.push('同身份');
      else if (cond.identityScope === 'specific' && cond.specificIdentityId) {
        const identIds = cond.specificIdentityId.split(',').map(s => s.trim()).filter(Boolean);
        const identNames = identIds.map(id => identityMap[id] || id).filter(Boolean);
        if (identNames.length) scopeParts.push(identNames.join('、'));
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

// getAuditProgress — View flow progress for a submission
router.post('/getAuditProgress', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const orgId = await getCurrentOrgId();

    const submissionId = safeString(req.body.submissionId);
    if (!submissionId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_fa1dcca5ac });
    }

    const submission = await submissionModel.getById(submissionId);
    if (!submission) {
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }

    const steps = await submissionStepModel.getBySubmissionId(submissionId);
    const files = await submissionFileModel.getBySubmissionId(submissionId);
    const currentFileIds = new Set(files.map(function(file) { return safeString(file.id); }));
    const signatures = (await submissionSignatureModel.getBySubmissionId(submissionId))
      .filter(function(signature) { return currentFileIds.has(safeString(signature.file_id)); });
    const events = await auditEventModel.getBySubmissionId(submissionId);

    // Load HR names
    const allHrIds = new Set();
    allHrIds.add(submission.submitted_by);
    steps.forEach((s) => { if (s.approver_hr_id) allHrIds.add(s.approver_hr_id); });
    signatures.forEach((s) => allHrIds.add(s.signer_hr_id));
    events.forEach((e) => { if (e.operator_hr_id) allHrIds.add(e.operator_hr_id); });
    const hrMap = {};
    if (allHrIds.size) {
      const hrRows = await hrInfoModel.getByIds([...allHrIds]);
      for (const hr of hrRows) hrMap[hr.id] = safeString(hr.name);
    }

    // Load identity names
    const identityIds = new Set(steps.map(s => s.approver_identity_id).filter(Boolean));
    const deptIdSet = new Set(steps.map(s => s.scope_department_id).filter(Boolean));
    const wgIdSet = new Set(steps.map(s => s.scope_work_group_id).filter(Boolean));
    const hrIdSet = new Set();
    for (const s of steps) {
      if (s.step_conditions_json) {
        try {
          const conds = JSON.parse(s.step_conditions_json);
          if (Array.isArray(conds)) {
            for (const c of conds) {
              if (c.conditionType === 'person' && c.personHrIds) {
                c.personHrIds.split(',').forEach(function(id) { hrIdSet.add(id.trim()); });
              } else {
                // identity_scope or unknown type — treat as identity_scope
                if (c.specificIdentityId) c.specificIdentityId.split(',').forEach(function(id) { identityIds.add(id.trim()); });
                if (c.specificDepartmentId) c.specificDepartmentId.split(',').forEach(function(id) { deptIdSet.add(id.trim()); });
                if (c.specificWorkGroupId) c.specificWorkGroupId.split(',').forEach(function(id) { wgIdSet.add(id.trim()); });
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
      submission: {
        id: safeString(submission.id),
        submissionNumber: safeString(submission.submission_number),
        title: safeString(submission.title),
        description: safeString(submission.description),
        type: safeString(submission.type),
        status: safeString(submission.status),
        submittedBy: safeString(submission.submitted_by),
        submitterName: hrMap[submission.submitted_by] || localeCopy.copy_8d3451355b,
        currentStepIndex: submission.current_step_index,
        resubmitMode: safeString(submission.resubmit_mode),
        createdAt: submission.created_at,
        updatedAt: submission.updated_at
      },
      events: events.map((e) => ({
        id: safeString(e.id),
        eventType: safeString(e.event_type),
        stepIndex: e.step_index,
        round: e.round || 1,
        operatorHrId: safeString(e.operator_hr_id),
        operatorName: hrMap[e.operator_hr_id] || e.operator_name || '',
        comment: safeString(e.comment),
        createdAt: e.created_at
      })),
      steps: steps.map((s) => {
        const condDisplay = buildStepConditionsDisplay(
          s.step_conditions_json,
          { hrMap, identityMap, deptMap, wgMap }
        );
        let legacyApproverDesc = '';
        const identName = identityMap[s.approver_identity_id] || '';
        const scopeType = (s.scope_type || '').trim();
        if (s.approver_type === 'specific_person') {
          legacyApproverDesc = localeCopy.copy_d3028048b3 + (hrMap[s.approver_hr_id] || localeCopy.copy_86bbf0d28e) + localeCopy.copy_7abed5378f;
        } else if (identName) {
          if (!scopeType || scopeType === 'all') {
            legacyApproverDesc = localeCopy.copy_9b774f950c + identName + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'same_department') {
            legacyApproverDesc = localeCopy.copy_fc98ff863c + identName + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'same_work_group') {
            legacyApproverDesc = localeCopy.copy_d0348010eb + identName + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'specific_department') {
            const dn = deptMap[s.scope_department_id] || s.scope_department_id || localeCopy.copy_b3604f443f;
            legacyApproverDesc = localeCopy.copy_d3028048b3 + dn + ' ' + identName + localeCopy.copy_7abed5378f;
          } else if (scopeType === 'specific_work_group') {
            const dn = deptMap[s.scope_department_id] || '';
            const wn = wgMap[s.scope_work_group_id] || '';
            const loc = [dn, wn].filter(Boolean).join('·') || localeCopy.copy_258347beac;
            legacyApproverDesc = localeCopy.copy_d3028048b3 + loc + ' ' + identName + localeCopy.copy_7abed5378f;
          } else {
            legacyApproverDesc = localeCopy.copy_d3028048b3 + identName + localeCopy.copy_7abed5378f;
          }
        }
        return {
          id: safeString(s.id),
          sortOrder: s.sort_order,
          approverType: safeString(s.approver_type),
          approverHrId: safeString(s.approver_hr_id),
          approverName: hrMap[s.approver_hr_id] || localeCopy.copy_86bbf0d28e,
          approverIdentityId: safeString(s.approver_identity_id),
          approverIdentityName: identityMap[s.approver_identity_id] || '',
          scopeType: safeString(s.scope_type),
          scopeDepartmentId: safeString(s.scope_department_id),
          scopeDepartmentName: deptMap[s.scope_department_id] || '',
          scopeWorkGroupId: safeString(s.scope_work_group_id),
          scopeWorkGroupName: wgMap[s.scope_work_group_id] || '',
          actionType: safeString(s.action_type),
          allowApproverDesignation: s.allow_approver_designation === 1,
          status: safeString(s.status),
          comment: safeString(s.comment),
          rejectionReason: safeString(s.rejection_reason),
          round: s.round,
          processedAt: s.processed_at,
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
      }))
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

router.post('/verifyAuditFile', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

module.exports = router;
