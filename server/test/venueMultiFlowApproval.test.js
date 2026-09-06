const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

const ORG = 'org-1';
let liveFlowDefinitionQueries = 0;
const assignments = {
  'a-app': { assignmentId: 'a-app', legacyHrId: 'hr-app', personId: 'p-app', organizationId: ORG, departmentId: 'D1', workGroupId: '', identityCategoryId: 'member' },
  'a-head': { assignmentId: 'a-head', legacyHrId: 'hr-head', personId: 'p-head', organizationId: ORG, departmentId: 'D1', workGroupId: '', identityCategoryId: 'dept_head' },
  'a-head-member': { assignmentId: 'a-head-member', legacyHrId: 'hr-head', personId: 'p-head', organizationId: ORG, departmentId: 'D1', workGroupId: '', identityCategoryId: 'member' },
  'a-head2': { assignmentId: 'a-head2', legacyHrId: 'hr-head2', personId: 'p-head2', organizationId: ORG, departmentId: 'D1', workGroupId: '', identityCategoryId: 'dept_head' },
  'a-chair': { assignmentId: 'a-chair', legacyHrId: 'hr-chair', personId: 'p-chair', organizationId: ORG, departmentId: 'D1', workGroupId: '', identityCategoryId: 'chairman' },
  'a-chair2': { assignmentId: 'a-chair2', legacyHrId: 'hr-chair2', personId: 'p-chair2', organizationId: ORG, departmentId: 'D2', workGroupId: '', identityCategoryId: 'chairman' },
  'a-other': { assignmentId: 'a-other', legacyHrId: 'hr-other', personId: 'p-other', organizationId: ORG, departmentId: 'D2', workGroupId: '', identityCategoryId: 'member' }
};

function toRuleProfile(assignment) {
  return {
    id: assignment.legacyHrId,
    assignment_id: assignment.assignmentId,
    person_id: assignment.personId,
    org_id: assignment.organizationId,
    department_id: assignment.departmentId,
    work_group_id: assignment.workGroupId,
    identity_id: assignment.identityCategoryId
  };
}

const flowDept = {
  id: 'flow-dept',
  venue_id: 'v1',
  org_id: ORG,
  name: '部门负责人审批',
  allow_user_select: 0,
  allow_designate_first: 0,
  allow_designate_next: 0,
  steps: [
    {
      id: 's1', flow_id: 'flow-dept', sort_order: 1, name: '部门负责人',
      approval_mode: 'hr_rule', org_id: ORG,
      rules: [{ id: 'r1', step_id: 's1', department_scope: 'same', work_group_scope: 'all', identity_scope: 'specific', specific_identity_id: 'dept_head' }]
    },
    {
      id: 's2', flow_id: 'flow-dept', sort_order: 2, name: '主席团',
      approval_mode: 'hr_rule', org_id: ORG,
      rules: [{ id: 'r2', step_id: 's2', department_scope: 'all', work_group_scope: 'all', identity_scope: 'specific', specific_identity_id: 'chairman' }]
    }
  ]
};
const flowAdmin = {
  id: 'flow-admin',
  venue_id: 'v1',
  org_id: ORG,
  name: '管理员直接通过',
  allow_user_select: 0,
  allow_designate_first: 0,
  allow_designate_next: 0,
  steps: [
    { id: 's3', flow_id: 'flow-admin', sort_order: 1, name: '管理员', approval_mode: 'admin_any', org_id: ORG, rules: [] }
  ]
};
const noChairFlow = {
  id: 'flow-no-chair',
  venue_id: 'v1',
  org_id: ORG,
  name: '无下一步候选人流程',
  allow_user_select: 0,
  allow_designate_first: 0,
  allow_designate_next: 0,
  steps: [
    flowDept.steps[0],
    {
      id: 's2b', flow_id: 'flow-no-chair', sort_order: 2, name: '无人步骤',
      approval_mode: 'hr_rule', org_id: ORG,
      rules: [{ id: 'r9', step_id: 's2b', department_scope: 'all', work_group_scope: 'all', identity_scope: 'specific', specific_identity_id: 'nobody' }]
    }
  ]
};
const consecutiveChairFlow = {
  id: 'flow-consecutive-chair',
  venue_id: 'v1',
  org_id: ORG,
  name: '主席团连续审批',
  allow_user_select: 0,
  allow_designate_first: 0,
  allow_designate_next: 0,
  steps: [
    {
      id: 's-chair-1', flow_id: 'flow-consecutive-chair', sort_order: 1, name: '主席团初审',
      approval_mode: 'hr_rule', org_id: ORG,
      rules: [{ id: 'r-chair-1', step_id: 's-chair-1', department_scope: 'all', work_group_scope: 'all', identity_scope: 'specific', specific_identity_id: 'chairman' }]
    },
    {
      id: 's-chair-2', flow_id: 'flow-consecutive-chair', sort_order: 2, name: '主席团复核',
      approval_mode: 'hr_rule', org_id: ORG,
      rules: [{ id: 'r-chair-2', step_id: 's-chair-2', department_scope: 'all', work_group_scope: 'all', identity_scope: 'specific', specific_identity_id: 'chairman' }]
    }
  ]
};
const widenedResponsibilityFlow = {
  id: 'flow-widened-responsibility',
  venue_id: 'v1',
  org_id: ORG,
  name: '责任范围变化流程',
  allow_user_select: 0,
  allow_designate_first: 0,
  allow_designate_next: 0,
  steps: [
    consecutiveChairFlow.steps[0],
    {
      id: 's-all-member', flow_id: 'flow-widened-responsibility', sort_order: 2, name: '全体成员复核',
      approval_mode: 'hr_rule', org_id: ORG,
      rules: [{ id: 'r-all-member', step_id: 's-all-member', department_scope: 'all', work_group_scope: 'all', identity_scope: 'all' }]
    }
  ]
};

const pool = {
  async query(sql, params) {
    if (sql.indexOf('AS total') >= 0) {
      return [[{ total: 1 }]];
    }
    if (sql.indexOf('venue_approval_flows WHERE id') >= 0) {
      liveFlowDefinitionQueries += 1;
      const id = String(params[0]);
      return [[[flowDept, flowAdmin, noChairFlow, consecutiveChairFlow, widenedResponsibilityFlow].find(function(flow) { return flow.id === id; }) || null]];
    }
    if (sql.indexOf('admin_grants') >= 0 && sql.indexOf('status = \'active\'') >= 0) {
      return [[{ ok: 1 }]];
    }
    if (sql.indexOf('FROM admin_info WHERE org_id') >= 0 && sql.indexOf('bind_status') >= 0) {
      return [[{ total: 1 }]];
    }
    if (sql.indexOf('admin_info') >= 0 && sql.indexOf('bind_status = \'active\'') >= 0) {
      return [[{ ok: 1 }]];
    }
    throw new Error('未预期的 SQL: ' + sql);
  }
};

const assignmentContext = {
  toRuleProfile,
  toAssignmentSnapshot: function(assignment) { return Object.assign({}, assignment); },
  async loadAssignmentById(id, orgId) {
    const assignment = assignments[id];
    return assignment && assignment.organizationId === orgId ? assignment : null;
  },
  async listActiveAssignmentsByPerson(personId, orgId) {
    return Object.values(assignments).filter(function(item) {
      return item.personId === personId && item.organizationId === orgId;
    });
  },
  async listActiveAssignmentsByLegacyHrId(hrId, orgId) {
    return Object.values(assignments).filter(function(item) {
      return item.legacyHrId === String(hrId) && item.organizationId === orgId;
    });
  },
  async listActiveAssignmentsByOrg(orgId) {
    return Object.values(assignments).filter(function(item) { return item.organizationId === orgId; });
  },
  async resolveCurrentActorAssignment(actor, orgId) {
    const assignment = assignments[actor.assignmentId];
    return assignment && assignment.organizationId === orgId ? assignment : null;
  },
  async resolveBookingApplicantAssignment(booking) {
    return booking && booking.id === 'legacy-no-assignment' ? null : assignments['a-app'];
  },
  actorMatchesDesignation: function(actor, designation) {
    return Boolean(designation && designation.assignmentId
      && actor.assignmentId === designation.assignmentId
      && actor.personId === designation.personId
      && actor.id === designation.legacyHrId);
  }
};

const stepModel = {
  async getByFlowId(flowId, orgId) {
    assert.strictEqual(orgId, ORG, '跨组织待办加载步骤时必须显式使用借用审批组织');
    return [flowDept, flowAdmin, noChairFlow, consecutiveChairFlow, widenedResponsibilityFlow].find(function(flow) { return flow.id === flowId; }).steps;
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../../../config/db') return pool;
  if (request === './venueAssignmentContext') return assignmentContext;
  if (request === '../../../core/models/unifiedIdentity') return { listContexts: async function() { return []; } };
  if (request === '../models/venueApprovalFlowStep') return stepModel;
  if (request === '../../../utils/orgContext') {
    return { getCurrentOrgId: function() { return ORG; } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const engine = require('../src/modules/venue/services/venueApprovalMultiFlow');
Module._load = originalLoad;

function userActor(hrId, personId, assignmentId) {
  const assignment = assignments[assignmentId]
    || Object.values(assignments).find(function(item) {
      return item.legacyHrId === hrId && item.identityCategoryId !== 'member';
    })
    || Object.values(assignments).find(function(item) { return item.legacyHrId === hrId; });
  return {
    id: hrId,
    personId: personId || assignment.personId,
    type: 'user',
    assignmentId: assignment.assignmentId,
    contextId: 'ctx-' + assignment.assignmentId,
    organizationId: assignment.organizationId,
    assignment,
    profile: toRuleProfile(assignment)
  };
}

function makeBooking(flowState) {
  const flowList = Object.keys(flowState.flows || {}).map(function(flowId) {
    return [flowDept, flowAdmin, noChairFlow, consecutiveChairFlow, widenedResponsibilityFlow].find(function(flow) { return flow.id === flowId; });
  }).filter(Boolean);
  const stepsByFlow = {};
  flowList.forEach(function(flow) { stepsByFlow[flow.id] = flow.steps; });
  return {
    id: 'b1',
    approval_org_id: ORG,
    status: 'pending',
    user_hr_id: 'hr-app',
    approval_flow_state_json: JSON.stringify(flowState),
    approval_flow_snapshot_json: JSON.stringify(engine.buildFlowDefinitionSnapshot(
      flowList,
      stepsByFlow,
      flowState.selectedFlowId,
      ORG,
      toRuleProfile(assignments['a-app'])
    )),
    approval_snapshots_json: '[]',
    approval_flow_id: flowState.selectedFlowId || null,
    approval_current_step: 0,
    approval_total_steps: 2
  };
}

async function run() {
  const unsafeLegacy = makeBooking(engine.buildInitialFlowState([flowDept], null, null));
  unsafeLegacy.approval_flow_snapshot_json = null;
  const unsafeLegacyEligibility = await engine.evaluateActorEligibility(
    unsafeLegacy,
    userActor('hr-head'),
    ORG
  );
  assert.strictEqual(unsafeLegacyEligibility.ok, false, '缺少不可变流程快照的旧在途记录必须失败关闭');
  assert.strictEqual(unsafeLegacyEligibility.reason, engine.REASONS.FLOW_SNAPSHOT_MISSING);

  const legacyWithoutAssignment = makeBooking(engine.buildInitialFlowState([flowDept], null, null));
  legacyWithoutAssignment.id = 'legacy-no-assignment';
  const legacyDefinition = JSON.parse(legacyWithoutAssignment.approval_flow_snapshot_json);
  legacyDefinition.applicantRuleProfile = null;
  legacyWithoutAssignment.approval_flow_snapshot_json = JSON.stringify(legacyDefinition);
  const legacyEligibility = await engine.evaluateActorEligibility(
    legacyWithoutAssignment,
    userActor('hr-head'),
    ORG
  );
  assert.strictEqual(legacyEligibility.ok, false, '无申请岗位引用或快照的旧借用必须失败关闭');
  assert.strictEqual(legacyEligibility.reason, engine.REASONS.INVALID_HR);

  // 1) 并行两流程：管理员与同部门负责人同时可见
  const parallelState = engine.buildInitialFlowState([flowDept, flowAdmin], null, null);
  const booking = makeBooking(parallelState);
  const adminEligible = await engine.evaluateActorEligibility(booking, { id: 'adm-1', personId: 'p-adm', type: 'admin', adminGrantId: 'g-adm', name: '管理员' }, ORG);
  assert.strictEqual(adminEligible.ok, true, '管理员应满足管理员流程');
  const headEligible = await engine.evaluateActorEligibility(booking, userActor('hr-head'), ORG);
  assert.strictEqual(headEligible.ok, true, '同部门负责人应满足负责人流程');
  const wrongHeadAssignment = await engine.evaluateActorEligibility(
    booking,
    userActor('hr-head', 'p-head', 'a-head-member'),
    ORG
  );
  assert.strictEqual(wrongHeadAssignment.ok, false, '同一人员切到不符合规则的岗位后不得审批');
  const chairmanBefore = await engine.evaluateActorEligibility(booking, userActor('hr-chair'), ORG);
  assert.strictEqual(chairmanBefore.ok, false, '第1步主席团不应可见');
  const otherEligible = await engine.evaluateActorEligibility(booking, userActor('hr-other'), ORG);
  assert.strictEqual(otherEligible.ok, false, '异部门普通成员不可见');

  const crossOrgVisibility = await engine.evaluateWorkContextEligibility(
    booking,
    [
      userActor('hr-head'),
      { type: 'admin', id: 'adm-org-2', personId: 'p-head', contextId: 'ctx-org-2', organizationId: 'org-2' }
    ],
    'ctx-org-2',
    'org-2'
  );
  assert.strictEqual(crossOrgVisibility.visible, true, '其他组织的可审批岗位应让待办跨组织可见');
  assert.strictEqual(crossOrgVisibility.canProcessInCurrentContext, false, '未切到目标组织岗位时不得直接处理');

  // 2) 管理员审批 → 直接通过，且绝不推进负责人流程（防串步）
  const adminApproval = await engine.prepareApproval(booking, { id: 'adm-1', personId: 'p-adm', type: 'admin', adminGrantId: 'g-adm', name: '管理员' }, '同意', null, ORG);
  assert.strictEqual(adminApproval.ok, true);
  assert.strictEqual(adminApproval.completed, true, '管理员流程单步即完成');
  assert.strictEqual(adminApproval.completedFlowId, 'flow-admin');
  assert.strictEqual(adminApproval.state.flows['flow-dept'].stepIndex, 0, '负责人流程不得被管理员审批推进');
  assert.strictEqual(adminApproval.snapshots.length, 1);
  assert.strictEqual(adminApproval.snapshots[0].flowId, 'flow-admin');

  // 3) 负责人审批第1步 → 确定负责人路线，其他替代路线终止但不得伪装成完成
  const freshBooking = makeBooking(engine.buildInitialFlowState([flowDept, flowAdmin], null, null));
  const headApproval = await engine.prepareApproval(freshBooking, userActor('hr-head'), '同意', null, ORG);
  assert.strictEqual(headApproval.ok, true);
  assert.strictEqual(headApproval.completed, false);
  assert.strictEqual(headApproval.state.flows['flow-dept'].stepIndex, 1, '负责人流程应推进到主席团');
  assert.strictEqual(headApproval.state.flows['flow-admin'].stepIndex, 0, '管理员流程不受影响');
  assert.strictEqual(headApproval.state.flows['flow-admin'].active, false, '首个审批动作应确定唯一替代路线');
  assert.strictEqual(headApproval.state.flows['flow-admin'].completed, false, '未走的替代路线不得标成完成');
  assert.strictEqual(headApproval.state.flows['flow-admin'].superseded, true, '未走路线应标记为被替代');
  assert.strictEqual(headApproval.candidateMissing, false, '主席团有人，不应标记候选人缺失');
  assert.strictEqual(headApproval.snapshots[0].approverAssignmentId, 'a-head');
  assert.strictEqual(headApproval.snapshots[0].approverAssignmentSnapshot.identityCategoryId, 'dept_head', '审批快照必须固化实际岗位');

  // 推进后只有已选择路线的主席团可见
  const advancedBooking = Object.assign({}, freshBooking, {
    approval_flow_state_json: JSON.stringify(headApproval.state),
    approval_snapshots_json: JSON.stringify(headApproval.snapshots)
  });
  const chairmanAfter = await engine.evaluateActorEligibility(advancedBooking, userActor('hr-chair'), ORG);
  assert.strictEqual(chairmanAfter.ok, true, '第2步主席团应可见');
  const adminAfter = await engine.evaluateActorEligibility(advancedBooking, { id: 'adm-1', personId: 'p-adm', type: 'admin', adminGrantId: 'g-adm', name: '管理员' }, ORG);
  assert.strictEqual(adminAfter.ok, false, '被替代的管理员路线不得继续处理');

  // 连续步骤由同一当前岗位负责时，一次人工审批应自动完成后续连续步骤。
  const consecutiveBooking = makeBooking(engine.buildInitialFlowState([consecutiveChairFlow], null, null));
  const consecutiveApproval = await engine.prepareApproval(
    consecutiveBooking,
    userActor('hr-chair'),
    '同意',
    null,
    ORG
  );
  assert.strictEqual(consecutiveApproval.ok, true);
  assert.strictEqual(consecutiveApproval.completed, true, '同一审批人连续命中后续步骤时应自动完成流程');
  assert.strictEqual(consecutiveApproval.processedStepCount, 2);
  assert.strictEqual(consecutiveApproval.autoApprovedStepCount, 1);
  assert.strictEqual(consecutiveApproval.snapshots.length, 2, '人工步骤和自动步骤都必须保留独立审批快照');
  assert.strictEqual(consecutiveApproval.snapshots[0].automatic, false);
  assert.strictEqual(consecutiveApproval.snapshots[1].automatic, true);
  assert.strictEqual(consecutiveApproval.snapshots[1].approverAssignmentId, 'a-chair');
  assert.strictEqual(consecutiveApproval.snapshots[1].stepName, '主席团复核');

  // 当前岗位只要仍符合下一步，就按新规则自动推进，不再要求前后审批契约完全一致。
  const widenedBooking = makeBooking(engine.buildInitialFlowState([widenedResponsibilityFlow], null, null));
  const widenedApproval = await engine.prepareApproval(
    widenedBooking,
    userActor('hr-chair'),
    '同意',
    null,
    ORG
  );
  assert.strictEqual(widenedApproval.ok, true);
  assert.strictEqual(widenedApproval.completed, true, '当前审批人仍命中下一步时应自动完成');
  assert.strictEqual(widenedApproval.processedStepCount, 2);
  assert.strictEqual(widenedApproval.autoApprovedStepCount, 1);
  assert.strictEqual(widenedApproval.state.flows[widenedResponsibilityFlow.id].stepIndex, 2);

  // 损坏快照和未知范围枚举必须失败关闭，不能被解释为“全部”。
  const malformedSnapshotsBooking = Object.assign({}, widenedBooking, { approval_snapshots_json: '{broken' });
  const malformedEligibility = await engine.evaluateActorEligibility(
    malformedSnapshotsBooking,
    userActor('hr-chair'),
    ORG
  );
  assert.strictEqual(malformedEligibility.ok, false);
  assert.strictEqual(malformedEligibility.reason, engine.REASONS.FLOW_SNAPSHOT_MISSING);

  const unknownScopeBooking = Object.assign({}, widenedBooking);
  const unknownScopeDefinition = JSON.parse(unknownScopeBooking.approval_flow_snapshot_json);
  unknownScopeDefinition.flows[0].steps[0].rules[0].department_scope = 'specfic';
  unknownScopeBooking.approval_flow_snapshot_json = JSON.stringify(unknownScopeDefinition);
  const unknownScopeEligibility = await engine.evaluateActorEligibility(
    unknownScopeBooking,
    userActor('hr-chair'),
    ORG
  );
  assert.strictEqual(unknownScopeEligibility.ok, false);

  const syntheticPersonFlows = engine.buildSyntheticFlowsFromBookingRules([{
    id: 'legacy-person-rule',
    rule_type: 'person',
    approver_hr_id: 'hr-chair',
    approver_assignment_id: 'a-chair'
  }]);
  assert.strictEqual(syntheticPersonFlows.length, 1);
  assert.strictEqual(syntheticPersonFlows[0].steps[0].rules[0].assignment_id, 'a-chair');

  // 已在旧版本完成第一步的在途记录，升级后同一人仍应能继续处理第二步。
  const resumedState = engine.buildInitialFlowState([consecutiveChairFlow], null, null);
  resumedState.flows['flow-consecutive-chair'].stepIndex = 1;
  resumedState.flows['flow-consecutive-chair'].approvedSteps.push({
    stepIndex: 0,
    approverHrId: 'hr-chair',
    approverPersonId: 'p-chair',
    approverAssignmentId: 'a-chair',
    approverType: 'user'
  });
  const resumedBooking = makeBooking(resumedState);
  resumedBooking.approval_snapshots_json = JSON.stringify([{
    flowId: 'flow-consecutive-chair',
    stepIndex: 0,
    approverHrId: 'hr-chair',
    approverPersonId: 'p-chair',
    approverAssignmentId: 'a-chair'
  }]);
  const resumedEligibility = await engine.evaluateActorEligibility(resumedBooking, userActor('hr-chair'), ORG);
  assert.strictEqual(resumedEligibility.ok, true, '历史第一步审批人不得被错误排除在当前步骤之外');
  const resumedApproval = await engine.prepareApproval(resumedBooking, userActor('hr-chair'), '同意', null, ORG);
  assert.strictEqual(resumedApproval.completed, true);
  assert.strictEqual(resumedApproval.snapshots.length, 2);

  // 当前流程被改名、改规则、停用甚至从当前配置查询中消失后，在途授权仍只认借用快照。
  const originalFlowName = flowDept.name;
  const originalIdentity = flowDept.steps[1].rules[0].specific_identity_id;
  flowDept.name = '已被管理员改名的当前流程';
  flowDept.is_active = 0;
  flowDept.steps[1].rules[0].specific_identity_id = 'nobody';
  const afterCurrentRuleMutation = await engine.evaluateActorEligibility(
    advancedBooking,
    userActor('hr-chair'),
    ORG
  );
  assert.strictEqual(afterCurrentRuleMutation.ok, true, '当前规则修改或停用不得改变在途审批授权');
  assert.strictEqual(afterCurrentRuleMutation.summary.flowSummary[0].flowName, originalFlowName, '在途展示必须保留发起时流程名称');
  assert.strictEqual(liveFlowDefinitionQueries, 0, '在途授权不得回查当前流程定义');
  flowDept.name = originalFlowName;
  flowDept.is_active = 1;
  flowDept.steps[1].rules[0].specific_identity_id = originalIdentity;

  // 4) 历史审批不可变：负责人事后调岗不得追溯推翻已完成步骤
  assignments['a-head'].identityCategoryId = 'member';
  const rematch = await engine.evaluateActorEligibility(advancedBooking, userActor('hr-chair'), ORG);
  assert.strictEqual(rematch.ok, true, '历史步骤必须按审批时岗位快照继续有效');
  const adminStill = await engine.evaluateActorEligibility(advancedBooking, { id: 'adm-1', personId: 'p-adm', type: 'admin', adminGrantId: 'g-adm', name: '管理员' }, ORG);
  assert.strictEqual(adminStill.ok, false, '已被替代的其他路线不得因历史岗位变化重新激活');
  assignments['a-head'].identityCategoryId = 'dept_head';

  // 5) 指定第一步审批人：只有被指定者可见
  flowDept.allow_designate_first = 1;
  const designatedState = engine.buildInitialFlowState([flowDept], 'flow-dept', {
    hrId: 'hr-head', legacyHrId: 'hr-head', personId: 'p-head', assignmentId: 'a-head'
  });
  const designatedBooking = makeBooking(designatedState);
  const designatedOk = await engine.evaluateActorEligibility(designatedBooking, userActor('hr-head'), ORG);
  assert.strictEqual(designatedOk.ok, true, '被指定负责人应可见');
  const designatedOther = await engine.evaluateActorEligibility(designatedBooking, userActor('hr-head2'), ORG);
  assert.strictEqual(designatedOther.ok, false, '其他负责人不可见（仅指定人）');
  const designatedWrongAssignment = await engine.evaluateActorEligibility(
    designatedBooking,
    userActor('hr-head', 'p-head', 'a-head-member'),
    ORG
  );
  assert.strictEqual(designatedWrongAssignment.ok, false, '被指定人员切到其他岗位也不得审批');

  const validated = await engine.validateDesignation(ORG, 'a-head', flowDept.steps[0], toRuleProfile(assignments['a-app']));
  assert.strictEqual(validated.assignmentId, 'a-head');
  assert.strictEqual(validated.personId, 'p-head');
  await assert.rejects(
    engine.validateDesignation(ORG, 'a-head-member', flowDept.steps[0], toRuleProfile(assignments['a-app'])),
    /请选择符合条件的审批人/,
    '指定岗位本身必须满足目标步骤规则'
  );

  // 6) 第一步与下一步指定权限必须完全独立，缺失字段不得扩大授权。
  flowDept.allow_designate_first = 1;
  flowDept.allow_designate_next = 0;
  const firstOnlyState = engine.buildInitialFlowState([flowDept], 'flow-dept', {
    hrId: 'hr-head', legacyHrId: 'hr-head', personId: 'p-head', assignmentId: 'a-head'
  });
  assert.strictEqual(firstOnlyState.flows['flow-dept'].designated['0'][0].assignmentId, 'a-head');
  const fixedFirstOnlyState = engine.buildInitialFlowState([flowDept], null, {
    hrId: 'hr-head', legacyHrId: 'hr-head', personId: 'p-head', assignmentId: 'a-head'
  });
  assert.strictEqual(fixedFirstOnlyState.flows['flow-dept'].designated['0'][0].assignmentId, 'a-head',
    '固定单流程无需用户选择流程，也必须支持已授权的第一步指定');
  const firstOnlyBooking = makeBooking(engine.buildInitialFlowState([flowDept], 'flow-dept', null));
  await assert.rejects(
    engine.prepareApproval(firstOnlyBooking, userActor('hr-head'), '同意', { assignmentId: 'a-chair' }, ORG),
    /不允许指定下一步审批人/,
    '仅允许指定第一步时，服务端必须拒绝下一步指定'
  );

  flowDept.allow_designate_first = 0;
  flowDept.allow_designate_next = 1;
  assert.throws(
    function() {
      engine.buildInitialFlowState([flowDept], 'flow-dept', {
        hrId: 'hr-head', legacyHrId: 'hr-head', personId: 'p-head', assignmentId: 'a-head'
      });
    },
    /不允许指定第一步审批人/,
    '仅允许指定下一步时，服务端必须拒绝第一步指定'
  );
  const nextOnlyBooking = makeBooking(engine.buildInitialFlowState([flowDept], 'flow-dept', null));
  const nextOnlyApproval = await engine.prepareApproval(
    nextOnlyBooking,
    userActor('hr-head'),
    '同意',
    { assignmentId: 'a-chair' },
    ORG
  );
  assert.strictEqual(nextOnlyApproval.state.flows['flow-dept'].designated['1'][0].assignmentId, 'a-chair');

  const multiNextApproval = await engine.prepareApproval(
    makeBooking(engine.buildInitialFlowState([flowDept], 'flow-dept', null)),
    userActor('hr-head'),
    '同意',
    [{ assignmentId: 'a-chair' }, { assignmentId: 'a-chair2' }],
    ORG
  );
  assert.deepStrictEqual(
    multiNextApproval.state.flows['flow-dept'].designated['1'].map(function(item) { return item.assignmentId; }),
    ['a-chair', 'a-chair2'],
    '下一步多人指定必须原子保存完整岗位候选集合'
  );
  const multiNextBooking = makeBooking(multiNextApproval.state);
  multiNextBooking.approval_snapshots_json = JSON.stringify(multiNextApproval.snapshots);
  assert.strictEqual(
    (await engine.evaluateActorEligibility(multiNextBooking, userActor('hr-chair2', 'p-chair2', 'a-chair2'), ORG)).ok,
    true,
    '下一步指定集合中的任一岗位均可完成审批'
  );

  flowDept.allow_designate_first = 1;
  const multiDesignationState = engine.buildInitialFlowState([flowDept], 'flow-dept', [
    { hrId: 'hr-head', personId: 'p-head', assignmentId: 'a-head' },
    { hrId: 'hr-head2', personId: 'p-head2', assignmentId: 'a-head2' },
    { hrId: 'hr-head', personId: 'p-head', assignmentId: 'a-head' }
  ]);
  assert.deepStrictEqual(
    multiDesignationState.flows['flow-dept'].designated['0'].map(function(item) { return item.assignmentId; }),
    ['a-head', 'a-head2'],
    '多人指定必须按岗位去重并保留任一人可审批的候选集合'
  );
  assert.strictEqual(
    (await engine.evaluateActorEligibility(makeBooking(multiDesignationState), userActor('hr-head2'), ORG)).ok,
    true,
    '多人指定中的任一岗位都应获得审批资格'
  );
  flowDept.allow_designate_first = 0;
  assert.strictEqual(nextOnlyApproval.summary.flowSummary[0].allowDesignateFirst, false);
  assert.strictEqual(nextOnlyApproval.summary.flowSummary[0].allowDesignateNext, true);

  const failClosedSnapshot = engine.buildFlowDefinitionSnapshot([
    Object.assign({}, flowDept, {
      allow_designate_first: 0,
      allowDesignateFirst: 1,
      allow_designate_next: undefined,
      allowDesignateNext: 1
    })
  ], { 'flow-dept': flowDept.steps }, 'flow-dept', ORG, toRuleProfile(assignments['a-app']));
  assert.strictEqual(failClosedSnapshot.flows[0].allow_designate_first, 0, '显式关闭值不得被兼容字段覆盖');
  assert.strictEqual(failClosedSnapshot.flows[0].allow_designate_next, 0, '缺失的新字段必须默认关闭');
  flowDept.allow_designate_first = 0;
  flowDept.allow_designate_next = 0;

  // 7) 候选人缺失：下一步无人匹配 → candidateMissing 标记且不自动完成
  const missingBooking = makeBooking(engine.buildInitialFlowState([noChairFlow], null, null));
  const missingApproval = await engine.prepareApproval(missingBooking, userActor('hr-head'), '同意', null, ORG);
  assert.strictEqual(missingApproval.ok, true);
  assert.strictEqual(missingApproval.completed, false);
  assert.strictEqual(missingApproval.candidateMissing, true, '下一步无候选人应标记 candidateMissing');

  // 8) 旧列派生：路线确定后只取当前活动路线，通过时取总步数
  const legacyPending = engine.legacyColumnsFromState(headApproval.state, headApproval.totalSteps, 'pending');
  assert.strictEqual(legacyPending.currentStep, 1);
  const legacyApproved = engine.legacyColumnsFromState(adminApproval.state, adminApproval.totalSteps, 'approved');
  assert.strictEqual(legacyApproved.currentStep, adminApproval.totalSteps);

  const approvalRouteSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/venue/routes/venueApprovalAdmin.js'),
    'utf8'
  );
  const pendingPageSource = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/subpackages/venue/pages/pendingVenueApprovals/pendingVenueApprovals.js'),
    'utf8'
  );
  const venueUserSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/venue/routes/venueUser.js'),
    'utf8'
  );
  assert.match(approvalRouteSource, /nextApproverAssignmentIds/);
  assert.match(approvalRouteSource, /nextDesignations,[\s\S]{0,120}safeString\(req\.body\.flowId\),[\s\S]{0,40}conn/,
    '下一步指定岗位必须使用审批事务连接完成原子校验');
  assert.match(approvalRouteSource, /!nextDesignationRequest\.hasList\s*&&\s*req\.body\.nextApproverHrId/,
    '下一步数组字段出现时必须优先处理，包括显式空数组');
  assert.match(venueUserSource, /!firstDesignationRequest\.hasList\s*&&\s*requestedFirstApproverHrId/,
    '第一步数组字段出现时必须优先处理，包括显式空数组');
  assert.match(pendingPageSource, /nextApproverAssignmentIds:\s*action === 'approve'/);
  assert.doesNotMatch(pendingPageSource, /nextApproverHrId/, '前端不得再提交仅人员级的下一审批人');

  assert.match(venueUserSource, /approvalFlowId, approvalFlowState, approvalFlowSnapshot, approvalTotalSteps/,
    '创建借用必须把流程定义快照写入记录');
  assert.match(venueUserSource, /assertDesignationAllowed\(singleSelected, 'first'/,
    '创建借用时必须由服务端校验第一步指定开关');
  assert.match(venueUserSource, /listUsableByVenueId\(venueId/);
  assert.match(venueUserSource, /visibleFlows = allowUserSelect[\s\S]*allow_user_select\) === 1/,
    '发起页只应返回有步骤的流程；存在可选流程时不得把不可选流程放入选择器');
  assert.match(venueUserSource, /if \(!autoApprove\) \{[\s\S]*hasFirstStepCandidate/,
    '自动通过时不得继续执行第一步候选人检查');
  assert.match(venueUserSource, /applicantMatchesAllFlowSteps\(flowForAutoApproval, applicantHrInfo\)/,
    '自动通过必须验证申请人命中全部步骤');
  assert.doesNotMatch(venueUserSource, /SELECT sort_order, name FROM venue_approval_flow_steps/,
    '历史详情不得回查当前步骤定义');

  const venueManageSource = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/subpackages/venue/pages/venueManage/venueManage.js'),
    'utf8'
  );
  const venueManageTemplate = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/subpackages/venue/pages/venueManage/venueManage.wxml'),
    'utf8'
  );
  const venueBookingSource = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/subpackages/venue/pages/venueBooking/venueBooking.js'),
    'utf8'
  );
  const venueBookingTemplate = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/subpackages/venue/pages/venueBooking/venueBooking.wxml'),
    'utf8'
  );
  assert.match(venueManageTemplate, /data-field="allow_designate_first"/);
  assert.match(venueManageTemplate, /data-field="allow_designate_next"/);
  assert.doesNotMatch(venueManageTemplate, /allow_designate_first === 1 \|\| item\.allow_designate_next === 1/,
    '管理界面不得再合并两个指定开关');
  assert.doesNotMatch(venueManageSource, /allow_designate_first\) === 1 \|\| Number\([^\n]*allow_designate_next/,
    '加载和编辑必须保持两个字段独立');
  assert.match(venueManageSource, /_openApprovalFlowEditor\(\{[\s\S]*?id: ''[\s\S]*?steps: \[\]/,
    '新增审批流程必须打开无 ID、无步骤的本地草稿');
  assert.doesNotMatch(venueManageSource, /saveVenueApprovalFlowMeta[\s\S]{0,200}flowId: ''/,
    '新增审批流程不得预先持久化空流程');
  assert.match(venueBookingSource, /fixedSingleFlow = !res\.allowUserSelect && options\.length === 1/,
    '固定单流程必须自动识别第一步指定能力');
  assert.match(venueBookingTemplate, /wx:if="\{\{selectedFlowId && selectedFlowAllowDesignateFirst\}\}"/);
  assert.doesNotMatch(venueBookingTemplate, /allowUserSelectFlow && selectedFlowId && selectedFlowAllowDesignateFirst/,
    '固定单流程的第一步指定入口不得依赖用户选流程开关');

  const venueAdminSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/venue/routes/venueAdmin.js'),
    'utf8'
  );
  assert.doesNotMatch(venueAdminSource, /SELECT \* FROM venue_approval_flow_steps WHERE flow_id/,
    '管理端列表与历史不得回查当前流程定义');

  const venueApprovalAdminSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/venue/routes/venueApprovalAdmin.js'),
    'utf8'
  );
  assert.doesNotMatch(venueApprovalAdminSource, /if \(!flow\) flow = await flowModel\.getByVenueId/,
    '整条流程保存不得把空或错误 flowId 回退到场地第一条流程');
  assert.match(venueApprovalAdminSource, /if \(!flow\) \{[\s\S]*?status: 'not_found'/,
    '显式 flowId 不存在时必须拒绝，不能静默新建');

  const migrationSource = fs.readFileSync(
    path.resolve(__dirname, '../db/deploy/20260826110000_venue_approval_flow_snapshot.sql'),
    'utf8'
  );
  assert.match(migrationSource, /information_schema\.COLUMNS/);
  assert.match(migrationSource, /approval_flow_snapshot_json MEDIUMTEXT/);
  assert.doesNotMatch(migrationSource, /UPDATE\s+venue_bookings/i,
    '无法证明来源的旧借用不得猜测回填当前流程');

  console.log('场地多审批流引擎测试通过');
}

run().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
