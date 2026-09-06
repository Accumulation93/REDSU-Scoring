const localeCopy = require('../../../locales/zh-CN/generated/modules/venue/services/venueApprovalMultiFlow');
const pool = require('../../../config/db');
const { safeString } = require('../../../utils/helpers');
const { matchesAnyRule } = require('../utils/venueApprovalRuleMatcher');
const {
  toRuleProfile,
  toAssignmentSnapshot,
  loadAssignmentById,
  listActiveAssignmentsByOrg,
  resolveCurrentActorAssignment,
  actorMatchesDesignation
} = require('./venueAssignmentContext');

const REASONS = Object.freeze({
  NO_FLOW: '该借用未设置审批流程',
  REJECTED: '该借用已被驳回',
  COMPLETED: '该借用已完成所有审批步骤',
  INVALID_STEP: '审批步骤有误，请联系管理员',
  ADMIN_REQUIRED: '该步骤仅允许当前组织管理员审批',
  USER_ROLE_REQUIRED: '当前步骤需切换到普通用户身份审批',
  NO_RULES: '请联系管理员设置审批条件',
  INVALID_HR: localeCopy.applicantSnapshotMissing,
  FLOW_SNAPSHOT_MISSING: localeCopy.flowSnapshotMissing,
  RULE_MISMATCH: '您不符合当前审批步骤的审批条件',
  DESIGNATED_ONLY: '该步骤已指定审批人，只有指定人员可以审批',
  DESIGNATE_FIRST_NOT_ALLOWED: localeCopy.firstDesignationNotAllowed,
  DESIGNATE_NEXT_NOT_ALLOWED: localeCopy.nextDesignationNotAllowed,
  DESIGNATE_INVALID: '请选择符合条件的审批人'
});

function normalizeFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function readFlowFlag(source, snakeKey, camelKey) {
  const item = source || {};
  if (Object.prototype.hasOwnProperty.call(item, snakeKey)) {
    return normalizeFlag(item[snakeKey]);
  }
  if (Object.prototype.hasOwnProperty.call(item, camelKey)) {
    return normalizeFlag(item[camelKey]);
  }
  return 0;
}

function assertDesignationAllowed(flow, phase, designation) {
  if (!safeString(designation && designation.assignmentId)) return false;
  const isFirst = phase === 'first';
  const allowed = flow
    ? readFlowFlag(
      flow,
      isFirst ? 'allow_designate_first' : 'allow_designate_next',
      isFirst ? 'allowDesignateFirst' : 'allowDesignateNext'
    ) === 1
    : false;
  if (!allowed) {
    throw new Error(isFirst ? REASONS.DESIGNATE_FIRST_NOT_ALLOWED : REASONS.DESIGNATE_NEXT_NOT_ALLOWED);
  }
  return true;
}

function normalizeDesignationList(value) {
  const list = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  const seen = new Set();
  return list.filter(function(designation) {
    const assignmentId = safeString(designation && designation.assignmentId);
    if (!assignmentId || seen.has(assignmentId)) return false;
    seen.add(assignmentId);
    return true;
  });
}

function normalizeStateDesignationLists(flows) {
  const normalizedFlows = flows && typeof flows === 'object' ? flows : {};
  for (const flowId of Object.keys(normalizedFlows)) {
    const flowState = normalizedFlows[flowId];
    if (!flowState || !flowState.designated || typeof flowState.designated !== 'object') continue;
    for (const stepIndex of Object.keys(flowState.designated)) {
      const list = normalizeDesignationList(flowState.designated[stepIndex]);
      if (list.length) flowState.designated[stepIndex] = list;
      else delete flowState.designated[stepIndex];
    }
  }
  return normalizedFlows;
}

function parseSnapshots(raw) {
  return parseSnapshotsResult(raw).snapshots;
}

function parseSnapshotsResult(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, snapshots: [] };
  }
  try {
    const snapshots = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(snapshots)
      ? { ok: true, snapshots }
      : { ok: false, snapshots: [] };
  } catch (_) {
    return { ok: false, snapshots: [] };
  }
}

function snapshotsForFlow(raw, flowId) {
  const snapshots = parseSnapshots(raw);
  const targetFlowId = safeString(flowId);
  if (!targetFlowId) return snapshots;
  const tagged = snapshots.filter(function(snapshot) {
    return safeString(snapshot && (snapshot.flowId || snapshot.flow_id));
  });
  if (!tagged.length) return snapshots;
  return tagged.filter(function(snapshot) {
    return safeString(snapshot.flowId || snapshot.flow_id) === targetFlowId;
  });
}

function jsonValue(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function immutableRule(rule) {
  const source = rule || {};
  return {
    id: safeString(source.id),
    sort_order: Number(source.sort_order || source.sortOrder) || 0,
    assignment_id: safeString(source.assignment_id || source.assignmentId),
    legacy_hr_id: safeString(source.legacy_hr_id || source.legacyHrId || source.approver_hr_id),
    department_scope: safeString(source.department_scope || source.departmentScope) || 'all',
    specific_department_id: safeString(source.specific_department_id || source.specificDepartmentId),
    work_group_scope: safeString(source.work_group_scope || source.workGroupScope) || 'all',
    specific_work_group_id: safeString(source.specific_work_group_id || source.specificWorkGroupId),
    identity_scope: safeString(source.identity_scope || source.identityScope) || 'all',
    specific_identity_id: safeString(source.specific_identity_id || source.specificIdentityId)
  };
}

function isValidScope(scope) {
  return scope === 'all' || scope === 'same' || scope === 'specific';
}

function isValidImmutableRule(rule) {
  if (!rule || !isValidScope(rule.department_scope)
    || !isValidScope(rule.work_group_scope)
    || !isValidScope(rule.identity_scope)) return false;
  if (rule.department_scope === 'specific' && !safeString(rule.specific_department_id)) return false;
  if (rule.work_group_scope === 'specific' && !safeString(rule.specific_work_group_id)) return false;
  if (rule.identity_scope === 'specific' && !safeString(rule.specific_identity_id)) return false;
  if (safeString(rule.legacy_hr_id) && !safeString(rule.assignment_id)) return false;
  return true;
}

function canonicalCsv(value) {
  return safeString(value).split(',').map(function(item) {
    return item.trim();
  }).filter(Boolean).sort().join(',');
}

function canonicalRuleSignature(rule) {
  return [
    safeString(rule.assignment_id), safeString(rule.legacy_hr_id),
    safeString(rule.department_scope), canonicalCsv(rule.specific_department_id),
    safeString(rule.work_group_scope), canonicalCsv(rule.specific_work_group_id),
    safeString(rule.identity_scope), canonicalCsv(rule.specific_identity_id)
  ].join('|');
}

function buildSyntheticFlowsFromBookingRules(bookingRules) {
  const activeRules = (Array.isArray(bookingRules) ? bookingRules : []).filter(function(rule) {
    return safeString(rule && rule.rule_type) !== 'direct';
  });
  const sourceRules = activeRules.length ? activeRules : [{ id: 'default-admin', rule_type: 'admin' }];
  return sourceRules.map(function(source, index) {
    const ruleType = safeString(source.rule_type);
    const flowId = 'booking-rule:' + (safeString(source.id) || String(index + 1));
    const step = {
      id: flowId + ':step:1',
      sort_order: 1,
      name: localeCopy.approvalStepName,
      approval_mode: ruleType === 'admin' ? 'admin_any' : 'hr_rule',
      rules: []
    };
    if (ruleType === 'person') {
      step.rules.push({
        id: flowId + ':rule:1',
        sort_order: 1,
        assignment_id: safeString(source.approver_assignment_id),
        legacy_hr_id: safeString(source.approver_hr_id),
        department_scope: 'all',
        work_group_scope: 'all',
        identity_scope: 'all'
      });
    } else if (ruleType === 'identity') {
      step.rules.push({
        id: flowId + ':rule:1',
        sort_order: 1,
        department_scope: safeString(source.scope_department_id) ? 'specific' : 'all',
        specific_department_id: safeString(source.scope_department_id),
        work_group_scope: safeString(source.scope_work_group_id) ? 'specific' : 'all',
        specific_work_group_id: safeString(source.scope_work_group_id),
        identity_scope: 'specific',
        specific_identity_id: safeString(source.approver_identity_id)
      });
    }
    return {
      id: flowId,
      name: localeCopy.approvalStepName,
      allow_user_select: 0,
      allow_designate_first: 0,
      allow_designate_next: 0,
      steps: [step]
    };
  });
}

function canonicalStepContract(step) {
  if (!step || safeString(step.approval_mode) !== 'hr_rule') return '';
  const rules = Array.isArray(step.rules) ? step.rules : [];
  if (!rules.length || rules.some(function(rule) { return !isValidImmutableRule(rule); })) return '';
  return rules.map(canonicalRuleSignature).sort().join('||');
}

function stepsHaveEquivalentApprovalContract(previousStep, nextStep) {
  const previous = canonicalStepContract(previousStep);
  return Boolean(previous) && previous === canonicalStepContract(nextStep);
}

function immutableStep(step, index) {
  const source = step || {};
  return {
    id: safeString(source.id),
    sort_order: Number(source.sort_order || source.sortOrder) || index + 1,
    name: safeString(source.name),
    approval_mode: safeString(source.approval_mode || source.approvalMode) === 'admin_any'
      ? 'admin_any'
      : 'hr_rule',
    rules: (Array.isArray(source.rules) ? source.rules : []).map(immutableRule)
  };
}

function immutableFlow(flow, steps) {
  const source = flow || {};
  return {
    id: safeString(source.id),
    name: safeString(source.name),
    allow_user_select: readFlowFlag(source, 'allow_user_select', 'allowUserSelect'),
    allow_designate_first: readFlowFlag(source, 'allow_designate_first', 'allowDesignateFirst'),
    allow_designate_next: readFlowFlag(source, 'allow_designate_next', 'allowDesignateNext'),
    steps: (Array.isArray(steps) ? steps : []).map(immutableStep)
  };
}

function buildFlowDefinitionSnapshot(flows, stepsByFlow, selectedFlowId, orgId, applicantRuleProfile) {
  const list = Array.isArray(flows) ? flows : [];
  const selectedId = safeString(selectedFlowId);
  const chosen = selectedId
    ? list.filter(function(flow) { return safeString(flow && flow.id) === selectedId; })
    : list;
  const snapshotFlows = chosen.map(function(flow) {
    return immutableFlow(flow, stepsByFlow && stepsByFlow[flow.id]);
  }).filter(function(flow) { return flow.id && flow.steps.length; });
  return {
    schemaVersion: 1,
    organizationId: safeString(orgId),
    selectedFlowId: selectedId,
    applicantRuleProfile: applicantRuleProfile ? {
      id: safeString(applicantRuleProfile.id),
      assignment_id: safeString(applicantRuleProfile.assignment_id),
      assignment_kind: safeString(applicantRuleProfile.assignment_kind),
      membership_id: safeString(applicantRuleProfile.membership_id),
      person_id: safeString(applicantRuleProfile.person_id),
      org_id: safeString(applicantRuleProfile.org_id),
      name: safeString(applicantRuleProfile.name),
      student_id: safeString(applicantRuleProfile.student_id),
      department_id: safeString(applicantRuleProfile.department_id),
      department_name: safeString(applicantRuleProfile.department_name),
      work_group_id: safeString(applicantRuleProfile.work_group_id),
      work_group_name: safeString(applicantRuleProfile.work_group_name),
      identity_id: safeString(applicantRuleProfile.identity_id),
      identity_name: safeString(applicantRuleProfile.identity_name),
      assignment_label: safeString(applicantRuleProfile.assignment_label)
    } : null,
    flows: snapshotFlows
  };
}

function parseFlowDefinitionSnapshot(booking, orgId) {
  const parsed = jsonValue(booking && booking.approval_flow_snapshot_json);
  if (!parsed || Number(parsed.schemaVersion) !== 1 || !Array.isArray(parsed.flows)) {
    return { ok: false, reason: REASONS.FLOW_SNAPSHOT_MISSING, snapshot: null, flowsMap: {} };
  }
  if (!safeString(parsed.organizationId) || safeString(parsed.organizationId) !== safeString(orgId)) {
    return { ok: false, reason: REASONS.FLOW_SNAPSHOT_MISSING, snapshot: null, flowsMap: {} };
  }
  const flowsMap = {};
  for (const sourceFlow of parsed.flows) {
    const flow = immutableFlow(sourceFlow, sourceFlow && sourceFlow.steps);
    if (!flow.id || !flow.steps.length || flowsMap[flow.id]) {
      return { ok: false, reason: REASONS.FLOW_SNAPSHOT_MISSING, snapshot: null, flowsMap: {} };
    }
    for (const step of flow.steps) {
      if (!step.id
        || (step.approval_mode === 'hr_rule'
          && (!step.rules.length || step.rules.some(function(rule) { return !isValidImmutableRule(rule); })))) {
        return { ok: false, reason: REASONS.FLOW_SNAPSHOT_MISSING, snapshot: null, flowsMap: {} };
      }
    }
    flowsMap[flow.id] = flow;
  }
  if (!Object.keys(flowsMap).length) {
    return { ok: false, reason: REASONS.FLOW_SNAPSHOT_MISSING, snapshot: null, flowsMap: {} };
  }
  return {
    ok: true,
    reason: '',
    snapshot: Object.assign({}, parsed, { flows: Object.values(flowsMap) }),
    flowsMap
  };
}

function validateFlowState(state, flowsMap, snapshots) {
  if (!state || !state.flows || typeof state.flows !== 'object' || Array.isArray(state.flows)) return false;
  const snapshotKeys = new Set();
  for (const snapshot of snapshots) {
    const flowId = safeString(snapshot && snapshot.flowId);
    const stepIndex = Number(snapshot && snapshot.stepIndex);
    if (!flowId || !Number.isInteger(stepIndex) || stepIndex < 0 || !flowsMap[flowId]) return false;
    const key = flowId + ':' + stepIndex;
    if (snapshotKeys.has(key) || !hasImmutableApproverReference({
      approverType: safeString(snapshot.approverIdentityType),
      approverAdminGrantId: safeString(snapshot.approverAdminGrantId),
      approverHrId: safeString(snapshot.approverHrId),
      approverAssignmentId: safeString(snapshot.approverAssignmentId)
    })) return false;
    snapshotKeys.add(key);
  }
  for (const flowId of Object.keys(state.flows)) {
    const flow = flowsMap[flowId];
    const current = state.flows[flowId];
    if (!flow || !current || typeof current !== 'object') return false;
    const stepIndex = Number(current.stepIndex);
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > flow.steps.length) return false;
    if (typeof current.active !== 'boolean' || typeof current.completed !== 'boolean') return false;
    if (current.active && current.completed) return false;
    if (current.completed && stepIndex !== flow.steps.length) return false;
    if (!Array.isArray(current.approvedSteps) || !current.designated
      || typeof current.designated !== 'object' || Array.isArray(current.designated)) return false;
    if (current.approvedSteps.length !== stepIndex) return false;
    for (let index = 0; index < current.approvedSteps.length; index += 1) {
      const approval = current.approvedSteps[index];
      if (Number(approval && approval.stepIndex) !== index || !hasImmutableApproverReference(approval)) return false;
      if (!snapshotKeys.has(flowId + ':' + index)) return false;
    }
    for (const designatedIndex of Object.keys(current.designated)) {
      const numericIndex = Number(designatedIndex);
      const designations = normalizeDesignationList(current.designated[designatedIndex]);
      if (!Number.isInteger(numericIndex) || numericIndex !== stepIndex
        || !designations.length) return false;
    }
  }
  return true;
}

function getSnapshotFlowSteps(booking, orgId, flowId) {
  const parsed = parseFlowDefinitionSnapshot(booking, orgId);
  if (!parsed.ok) return [];
  const targetFlowId = safeString(flowId || (booking && booking.approval_flow_id));
  const flow = parsed.flowsMap[targetFlowId] || parsed.snapshot.flows[0];
  return flow ? flow.steps.map(function(step) {
    return {
      stepIndex: flow.steps.indexOf(step),
      sortOrder: Number(step.sort_order) || flow.steps.indexOf(step) + 1,
      name: safeString(step.name),
      actionType: '',
      approvalMode: safeString(step.approval_mode)
    };
  }) : [];
}

function parseFlowState(booking) {
  if (booking && booking.approval_flow_state_json) {
    try {
      const parsed = JSON.parse(booking.approval_flow_state_json);
      if (parsed && parsed.flows && typeof parsed.flows === 'object') {
        return {
          selectedFlowId: safeString(parsed.selectedFlowId),
          candidateMissing: Boolean(parsed.candidateMissing),
          flows: normalizeStateDesignationLists(parsed.flows)
        };
      }
    } catch (_) {}
  }
  const flowId = safeString(booking && booking.approval_flow_id);
  const currentStep = Math.max(0, Number(booking && booking.approval_current_step) || 0);
  const rejected = Number(booking && booking.approval_current_step) < 0;
  const approvedSteps = parseSnapshots(booking && booking.approval_snapshots_json)
    .filter(function(item) { return Number(item.stepIndex) >= 0 && Number(item.stepIndex) < currentStep; })
    .map(function(item) {
      return {
        stepIndex: Number(item.stepIndex),
        approverHrId: safeString(item.approverHrId),
        approverPersonId: safeString(item.approverPersonId),
        approverAssignmentId: safeString(item.approverAssignmentId),
        approverAdminGrantId: safeString(item.approverAdminGrantId),
        approverType: safeString(item.approverIdentityType)
      };
    });
  return {
    selectedFlowId: flowId,
    candidateMissing: false,
    flows: flowId ? {
      [flowId]: {
        stepIndex: rejected ? 0 : currentStep,
        active: !rejected && Number(booking.approval_total_steps || 0) > 0,
        completed: currentStep >= Number(booking && booking.approval_total_steps || 0),
        approvedSteps: approvedSteps,
        designated: {}
      }
    } : {}
  };
}

function isSingleFlowState(state) {
  return Boolean(state.selectedFlowId) || Object.keys(state.flows || {}).length <= 1;
}

function selectMatchedFlow(eligibility, requestedFlowId) {
  const matched = Array.isArray(eligibility && eligibility.matchedFlows)
    ? eligibility.matchedFlows
    : [];
  const requested = safeString(requestedFlowId);
  if (requested) {
    return matched.find(function(item) { return item.flowId === requested; }) || null;
  }
  const selectedFlowId = safeString(eligibility && eligibility.state && eligibility.state.selectedFlowId);
  return matched.find(function(item) { return item.flowId === selectedFlowId; }) || matched[0] || null;
}

function buildInitialFlowState(flows, selectedFlowId, firstDesignations) {
  const list = Array.isArray(flows) ? flows : [];
  const selected = list.find(function(flow) {
    return String(flow.id) === String(selectedFlowId);
  });
  const designationFlow = selected || (list.length === 1 ? list[0] : null);
  const chosen = selected ? [selected] : list;
  const state = {
    selectedFlowId: selected ? String(selected.id) : null,
    candidateMissing: false,
    flows: {}
  };
  for (const flow of chosen) {
    state.flows[String(flow.id)] = {
      stepIndex: 0,
      active: true,
      completed: false,
      approvedSteps: [],
      designated: {}
    };
  }
  const normalizedFirstDesignations = normalizeDesignationList(firstDesignations);
  if (normalizedFirstDesignations.length) {
    assertDesignationAllowed(designationFlow, 'first', normalizedFirstDesignations[0]);
    state.flows[String(designationFlow.id)].designated['0'] = normalizedFirstDesignations.map(function(firstDesignation) {
      return {
        personId: safeString(firstDesignation.personId),
        legacyHrId: safeString(firstDesignation.legacyHrId || firstDesignation.hrId),
        assignmentId: safeString(firstDesignation.assignmentId),
        assignmentSnapshot: firstDesignation.assignmentSnapshot || null
      };
    });
  }
  return state;
}

function hasImmutableApproverReference(approval) {
  if (safeString(approval && approval.approverType) === 'admin') {
    return Boolean(safeString(approval.approverAdminGrantId) || safeString(approval.approverHrId));
  }
  return Boolean(safeString(approval && approval.approverAssignmentId));
}

async function recomputeActiveFlows(state, flowsMap) {
  for (const flowId of Object.keys(state.flows)) {
    const st = state.flows[flowId];
    if (!st || !st.active || st.completed) continue;
    const flow = flowsMap[flowId];
    if (!flow) {
      st.active = false;
      continue;
    }
    let valid = Boolean(flow);
    for (const ap of (st.approvedSteps || [])) {
      // 已发生审批只按当时写入的管理员授权/岗位引用认定，不能因事后调岗、离任或规则变化被追溯推翻。
      if (!hasImmutableApproverReference(ap)) {
        valid = false;
        break;
      }
      const designated = normalizeDesignationList(st.designated && st.designated[String(ap.stepIndex)]);
      if (designated.length && !designated.some(function(designation) { return actorMatchesDesignation({
        id: ap.approverHrId,
        personId: ap.approverPersonId,
        assignmentId: ap.approverAssignmentId
      }, designation); })) {
        valid = false;
        break;
      }
    }
    st.active = valid;
  }
}

async function validateDesignation(orgId, assignmentId, step, applicantHrInfo, conn) {
  if (!step || safeString(step.approval_mode) === 'admin_any') {
    throw new Error(REASONS.DESIGNATE_INVALID);
  }
  const assignment = await loadAssignmentById(safeString(assignmentId), orgId, true, conn);
  if (!assignment) {
    throw new Error(REASONS.DESIGNATE_INVALID);
  }
  if (!matchesAnyRule(step.rules || [], toRuleProfile(assignment), applicantHrInfo || null)) {
    throw new Error(REASONS.DESIGNATE_INVALID);
  }
  return {
    personId: assignment.personId,
    hrId: assignment.legacyHrId,
    legacyHrId: assignment.legacyHrId,
    assignmentId: assignment.assignmentId,
    assignmentSnapshot: toAssignmentSnapshot(assignment)
  };
}

async function actorMatchesStep(actor, flow, st, applicantHrInfo, orgId) {
  const step = flow.steps && flow.steps[Number(st.stepIndex)];
  if (!step) return false;
  const designated = normalizeDesignationList(st.designated && st.designated[String(st.stepIndex)]);
  if (designated.length) {
    if (!actor || actor.type !== 'user' || !designated.some(function(designation) {
      return actorMatchesDesignation(actor, designation);
    })) return false;
    if (!actor.assignment) return false;
    return matchesAnyRule(step.rules || [], toRuleProfile(actor.assignment), applicantHrInfo || null);
  }
  const mode = safeString(step.approval_mode) || ((step.rules || []).length ? 'hr_rule' : 'admin_any');
  if (mode === 'admin_any') {
    return Boolean(actor && actor.type === 'admin');
  }
  if (!actor || actor.type !== 'user') return false;
  if (!actor.assignment) return false;
  if (!Array.isArray(step.rules) || !step.rules.length) return false;
  return matchesAnyRule(step.rules, toRuleProfile(actor.assignment), applicantHrInfo || null);
}

async function countStepCandidates(flow, st, applicantHrInfo, orgId, conn) {
  const step = flow.steps && flow.steps[Number(st.stepIndex)];
  if (!step) return 0;
  const designated = normalizeDesignationList(st.designated && st.designated[String(st.stepIndex)]);
  if (designated.length) {
    let total = 0;
    for (const designation of designated) {
      const assignment = await loadAssignmentById(designation.assignmentId, orgId, true, conn);
      if (!assignment) continue;
      if (!actorMatchesDesignation({
        id: assignment.legacyHrId,
        personId: assignment.personId,
        assignmentId: assignment.assignmentId
      }, designation)) continue;
      if (matchesAnyRule(step.rules || [], toRuleProfile(assignment), applicantHrInfo || null)) total += 1;
    }
    return total;
  }
  const mode = safeString(step.approval_mode) || ((step.rules || []).length ? 'hr_rule' : 'admin_any');
  if (mode === 'admin_any') {
    const db = conn || pool;
    const [rows] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM admin_info WHERE org_id = ? AND bind_status = 'active')
         + (SELECT COUNT(*) FROM admin_grants WHERE (org_id = ? OR org_id = '') AND status = 'active')
         AS total`,
      [orgId, orgId]
    );
    return Number(rows[0] && rows[0].total) || 0;
  }
  const assignments = await listActiveAssignmentsByOrg(orgId, conn);
  const people = new Set();
  for (const assignment of assignments) {
    if (matchesAnyRule(step.rules || [], toRuleProfile(assignment), applicantHrInfo || null)) {
      people.add(assignment.personId || assignment.legacyHrId);
    }
  }
  return people.size;
}

async function listNextStepDesignationCandidates(booking, actor, orgId, requestedFlowId) {
  const eligibility = await evaluateActorEligibility(booking, actor, orgId);
  if (!eligibility.ok) return eligibility;
  const selected = selectMatchedFlow(eligibility, requestedFlowId);
  if (!selected) return Object.assign({}, eligibility, { ok: false, reason: REASONS.RULE_MISMATCH });
  assertDesignationAllowed(selected.flow, 'next', { assignmentId: '__candidate_check__' });
  const nextStepIndex = Number(selected.st.stepIndex) + 1;
  const nextStep = selected.flow.steps[nextStepIndex];
  if (!nextStep || safeString(nextStep.approval_mode) !== 'hr_rule') {
    throw new Error(REASONS.DESIGNATE_INVALID);
  }
  const candidates = await listEligibleAssignmentsForStep(nextStep, eligibility.applicantHrInfo, orgId);
  return {
    ok: true,
    flowId: selected.flowId,
    stepIndex: nextStepIndex,
    stepName: safeString(nextStep.name),
    candidates
  };
}

async function listEligibleAssignmentsForStep(step, applicantHrInfo, orgId) {
  if (!step || safeString(step.approval_mode || step.approvalMode) !== 'hr_rule') return [];
  const normalizedStep = immutableStep(step, 0);
  const assignments = await listActiveAssignmentsByOrg(orgId);
  return assignments.filter(function(assignment) {
    return matchesAnyRule(normalizedStep.rules || [], toRuleProfile(assignment), applicantHrInfo || null);
  }).map(function(assignment) {
    return {
      id: assignment.assignmentId,
      assignmentId: assignment.assignmentId,
      contextId: assignment.contextId,
      hrId: assignment.legacyHrId,
      legacyHrId: assignment.legacyHrId,
      personId: assignment.personId,
      organizationId: assignment.organizationId,
      name: assignment.personName,
      studentId: assignment.studentId,
      assignment: toAssignmentSnapshot(assignment),
      assignmentLabel: assignment.assignmentLabel
    };
  });
}

function summarizeState(state, flowsMap) {
  const flowIds = Object.keys(state.flows);
  const activeFlowIds = flowIds.filter(function(flowId) {
    const st = state.flows[flowId];
    return st && st.active && !st.completed;
  });
  let candidateMissing = false;
  if (activeFlowIds.length) {
    // candidateMissing 由调用方在推进后计算，此处仅汇总
  }
  return {
    selectedFlowId: state.selectedFlowId || null,
    activeFlowIds: activeFlowIds,
    flowSummary: flowIds.map(function(flowId) {
      const st = state.flows[flowId];
      const flow = flowsMap[flowId] || null;
      const step = flow && flow.steps[Number(st.stepIndex)];
      return {
        flowId: flowId,
        flowName: (flow && flow.name) || '',
        allowUserSelect: Boolean(flow && Number(flow.allow_user_select) === 1),
        allowDesignateFirst: Boolean(flow && Number(flow.allow_designate_first) === 1),
        allowDesignateNext: Boolean(flow && Number(flow.allow_designate_next) === 1),
        stepIndex: Number(st.stepIndex),
        stepName: step ? step.name : '',
        totalSteps: flow ? flow.steps.length : 0,
        active: Boolean(st.active),
        completed: Boolean(st.completed),
        superseded: Boolean(st.superseded),
        designated: st.designated || {}
      };
    })
  };
}

async function evaluateActorEligibility(booking, actor, orgId) {
  let effectiveActor = actor;
  if (actor && actor.type === 'user') {
    const assignment = actor.assignment
      && safeString(actor.assignment.organizationId) === safeString(orgId)
      && safeString(actor.assignment.assignmentId) === safeString(actor.assignmentId)
      ? actor.assignment
      : await resolveCurrentActorAssignment(actor, orgId);
    effectiveActor = Object.assign({}, actor, {
      assignment: assignment || null,
      profile: assignment ? toRuleProfile(assignment) : null
    });
  }
  const state = parseFlowState(booking);
  const flowDefinition = parseFlowDefinitionSnapshot(booking, orgId);
  const flowsMap = flowDefinition.flowsMap;
  const snapshotsResult = parseSnapshotsResult(booking && booking.approval_snapshots_json);
  const stateFlowIds = Object.keys(state.flows || {});
  const snapshotFlowIds = Object.keys(flowsMap);
  const stateMatchesSnapshot = flowDefinition.ok
    && snapshotsResult.ok
    && stateFlowIds.length === snapshotFlowIds.length
    && stateFlowIds.every(function(flowId) { return Boolean(flowsMap[flowId]); })
    && (!state.selectedFlowId || stateFlowIds.includes(state.selectedFlowId))
    && validateFlowState(state, flowsMap, snapshotsResult.snapshots);
  if (!stateMatchesSnapshot) {
    return {
      ok: false,
      reason: REASONS.FLOW_SNAPSHOT_MISSING,
      matchedFlows: [],
      state,
      flowsMap,
      applicantHrInfo: null,
      actor: effectiveActor,
      candidateMissing: true,
      summary: summarizeState(state, flowsMap)
    };
  }
  const applicantHrInfo = flowDefinition.snapshot.applicantRuleProfile || null;
  if (!applicantHrInfo) {
    return {
      ok: false,
      reason: REASONS.INVALID_HR,
      matchedFlows: [],
      state,
      flowsMap,
      applicantHrInfo: null,
      actor: effectiveActor,
      candidateMissing: true,
      summary: summarizeState(state, flowsMap)
    };
  }
  await recomputeActiveFlows(state, flowsMap);

  const matchedFlows = [];
  for (const flowId of Object.keys(state.flows)) {
    const st = state.flows[flowId];
    if (!st || !st.active || st.completed) continue;
    const flow = flowsMap[flowId];
    if (!flow) continue;
    if (await actorMatchesStep(effectiveActor, flow, st, applicantHrInfo, orgId)) {
      matchedFlows.push({ flowId, flow, st, step: flow.steps[Number(st.stepIndex)] });
    }
  }
  const summary = summarizeState(state, flowsMap);
  return {
    ok: matchedFlows.length > 0,
    reason: matchedFlows.length ? '' : REASONS.RULE_MISMATCH,
    matchedFlows,
    state,
    flowsMap,
    applicantHrInfo,
    actor: effectiveActor,
    candidateMissing: summary.activeFlowIds.length > 0 && summary.activeFlowIds.every(function(flowId) {
      const st = state.flows[flowId];
      const flow = flowsMap[flowId];
      return Number(st.stepIndex) >= (flow && flow.steps.length || 0);
    }),
    summary
  };
}

async function prepareApproval(booking, actor, comment, nextDesignations, orgId, requestedFlowId, conn) {
  const eligibility = await evaluateActorEligibility(booking, actor, orgId);
  if (!eligibility.ok) return eligibility;

  const state = eligibility.state;
  const flowsMap = eligibility.flowsMap;
  const applicantHrInfo = eligibility.applicantHrInfo;
  const matched = eligibility.matchedFlows;
  const snapshots = parseSnapshotsResult(booking.approval_snapshots_json).snapshots;
  const effectiveActor = eligibility.actor || actor;
  const now = new Date().toISOString();

  const selectedMatchedFlow = selectMatchedFlow(eligibility, requestedFlowId);
  if (!selectedMatchedFlow) {
    return Object.assign({}, eligibility, { ok: false, reason: REASONS.RULE_MISMATCH });
  }
  const selected = [selectedMatchedFlow];
  if (!safeString(state.selectedFlowId) && Object.keys(state.flows).length > 1) {
    state.selectedFlowId = selectedMatchedFlow.flowId;
    for (const flowId of Object.keys(state.flows)) {
      if (flowId === selectedMatchedFlow.flowId) continue;
      state.flows[flowId].active = false;
      state.flows[flowId].completed = false;
      state.flows[flowId].superseded = true;
    }
  }
  const singleFlow = isSingleFlowState(state);
  let completedFlowId = null;
  let validatedNextDesignations = [];
  let processedStepCount = 0;
  let autoApprovedStepCount = 0;

  const normalizedNextDesignations = normalizeDesignationList(nextDesignations);
  if (normalizedNextDesignations.length) {
    if (!singleFlow || selected.length !== 1) {
      throw new Error(REASONS.DESIGNATE_NEXT_NOT_ALLOWED);
    }
    const matchedFlow = selectedMatchedFlow.flow;
    const matchedState = selectedMatchedFlow.st;
    assertDesignationAllowed(matchedFlow, 'next', normalizedNextDesignations[0]);
    const nextStep = matchedFlow.steps[Number(matchedState.stepIndex) + 1];
    if (!nextStep) {
      throw new Error(REASONS.DESIGNATE_INVALID);
    }
    for (const nextDesignation of normalizedNextDesignations) {
      validatedNextDesignations.push(await validateDesignation(
        orgId,
        nextDesignation.assignmentId,
        nextStep,
        applicantHrInfo,
        conn
      ));
    }
  }

  function recordApproval(item, step, automatic) {
    const st = item.st;
    snapshots.push({
      flowId: item.flowId,
      stepIndex: Number(st.stepIndex),
      stepName: step.name || '',
      approverHrId: safeString(effectiveActor.id),
      approverPersonId: safeString(effectiveActor.personId),
      approverAssignmentId: safeString(effectiveActor.assignmentId),
      approverAssignmentSnapshot: effectiveActor.assignment ? toAssignmentSnapshot(effectiveActor.assignment) : null,
      approverAdminGrantId: safeString(effectiveActor.adminGrantId),
      approverContextId: safeString(effectiveActor.contextId),
      approverIdentityType: safeString(effectiveActor.type),
      approverName: effectiveActor.name || (effectiveActor.type === 'admin' ? '管理员' : ''),
      comment: automatic ? '' : (comment || ''),
      automatic: Boolean(automatic),
      approvedAt: now
    });
    st.approvedSteps.push({
      stepIndex: Number(st.stepIndex),
      approverHrId: safeString(effectiveActor.id),
      approverPersonId: safeString(effectiveActor.personId),
      approverAssignmentId: safeString(effectiveActor.assignmentId),
      approverAdminGrantId: safeString(effectiveActor.adminGrantId),
      approverType: safeString(effectiveActor.type),
      automatic: Boolean(automatic)
    });
    delete st.designated[String(st.stepIndex)];
    st.stepIndex = Number(st.stepIndex) + 1;
    processedStepCount += 1;
    if (automatic) autoApprovedStepCount += 1;
  }

  for (const item of selected) {
    const st = item.st;
    const flow = item.flow;
    let previousStep = item.step;
    const currentWasDesignated = Boolean(st.designated && st.designated[String(st.stepIndex)]);
    recordApproval(item, item.step, false);

    if (st.stepIndex >= flow.steps.length) {
      st.completed = true;
      st.active = false;
      if (!completedFlowId) completedFlowId = item.flowId;
      continue;
    }
    if (validatedNextDesignations.length) {
      st.designated[String(st.stepIndex)] = validatedNextDesignations;
    }

    // 同一次人工审批后，连续步骤仍由同一当前岗位审批时自动推进。
    // 每个自动步骤都写入独立不可变快照，保证历史顺序和岗位事实完整。
    let previousWasDesignated = currentWasDesignated;
    while (st.active && !st.completed && st.stepIndex < flow.steps.length) {
      const automaticStep = flow.steps[Number(st.stepIndex)];
      const nextIsDesignated = Boolean(st.designated && st.designated[String(st.stepIndex)]);
      if (validatedNextDesignations.length
        || !await actorMatchesStep(effectiveActor, flow, st, applicantHrInfo, orgId)) break;
      recordApproval(item, automaticStep, true);
      previousStep = automaticStep;
      previousWasDesignated = false;
      if (st.stepIndex >= flow.steps.length) {
        st.completed = true;
        st.active = false;
        if (!completedFlowId) completedFlowId = item.flowId;
      }
    }
  }

  if (completedFlowId) {
    // 任一流程完成即借用通过，其余流程一并终止
    for (const flowId of Object.keys(state.flows)) {
      state.flows[flowId].active = false;
      if (flowId !== completedFlowId) {
        state.flows[flowId].completed = false;
        state.flows[flowId].superseded = true;
      }
    }
    state.candidateMissing = false;
    const completedFlow = flowsMap[completedFlowId];
    return {
      ok: true,
      completed: true,
      completedFlowId,
      state,
      snapshots,
      actor: effectiveActor,
      processedStepCount,
      autoApprovedStepCount,
      totalSteps: completedFlow ? completedFlow.steps.length : Number(booking.approval_total_steps || 0),
      summary: summarizeState(state, flowsMap)
    };
  }

  await recomputeActiveFlows(state, flowsMap);
  const summary = summarizeState(state, flowsMap);
  let candidateMissing = false;
  if (summary.activeFlowIds.length) {
    const hasCandidate = [];
    for (const flowId of summary.activeFlowIds) {
      const st = state.flows[flowId];
      const flow = flowsMap[flowId];
      if (Number(st.stepIndex) >= flow.steps.length) continue;
      hasCandidate.push(await countStepCandidates(flow, st, applicantHrInfo, orgId));
    }
    candidateMissing = hasCandidate.length > 0 && hasCandidate.every(function(count) { return count === 0; });
  } else {
    candidateMissing = true;
  }
  state.candidateMissing = candidateMissing;

  const flowLengths = Object.keys(state.flows).map(function(flowId) {
    const flow = flowsMap[flowId];
    return flow ? flow.steps.length : 0;
  });
  return {
    ok: true,
    completed: false,
    completedFlowId: null,
    state,
    snapshots,
    actor: effectiveActor,
    processedStepCount,
    autoApprovedStepCount,
    totalSteps: flowLengths.length ? Math.max.apply(null, flowLengths) : Number(booking.approval_total_steps || 0),
    candidateMissing,
    summary: summarizeState(state, flowsMap)
  };
}

async function evaluateWorkContextEligibility(booking, workActors, currentContextId, currentOrgId) {
  const targetOrgId = safeString(booking && booking.approval_org_id);
  const eligible = [];
  for (const actor of (workActors || [])) {
    if (safeString(actor && actor.organizationId) !== targetOrgId) continue;
    const eligibility = await evaluateActorEligibility(booking, actor, targetOrgId);
    if (eligibility.ok) eligible.push({ actor, eligibility });
  }
  const current = eligible.find(function(item) {
    return safeString(item.actor.contextId) === safeString(currentContextId)
      && targetOrgId === safeString(currentOrgId);
  }) || null;
  return {
    visible: eligible.length > 0,
    canProcessInCurrentContext: Boolean(current),
    eligible,
    selected: current || eligible[0] || null
  };
}

function legacyColumnsFromState(state, totalSteps, status) {
  const flowIds = Object.keys(state.flows);
  const approvalFlowId = state.selectedFlowId || flowIds[0] || null;
  if (status === 'approved') {
    return { approvalFlowId, currentStep: totalSteps, totalSteps };
  }
  if (status === 'rejected') {
    return { approvalFlowId, currentStep: -1, totalSteps };
  }
  const activeSteps = flowIds
    .map(function(flowId) { return state.flows[flowId]; })
    .filter(function(st) { return st && st.active && !st.completed; })
    .map(function(st) { return Number(st.stepIndex); });
  const currentStep = activeSteps.length ? Math.min.apply(null, activeSteps) : 0;
  return { approvalFlowId, currentStep, totalSteps };
}

module.exports = {
  REASONS,
  parseSnapshots,
  parseSnapshotsResult,
  snapshotsForFlow,
  parseFlowState,
  buildInitialFlowState,
  buildFlowDefinitionSnapshot,
  buildSyntheticFlowsFromBookingRules,
  parseFlowDefinitionSnapshot,
  getSnapshotFlowSteps,
  isSingleFlowState,
  selectMatchedFlow,
  assertDesignationAllowed,
  normalizeDesignationList,
  validateDesignation,
  evaluateActorEligibility,
  evaluateWorkContextEligibility,
  prepareApproval,
  legacyColumnsFromState,
  countStepCandidates,
  listNextStepDesignationCandidates,
  listEligibleAssignmentsForStep,
  summarizeState
};
