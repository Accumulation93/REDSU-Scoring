'use strict';

const assert = require('assert');
const Module = require('module');
const { buildCalculationPolicySignature } = require('../src/modules/scoring/utils/calculationSnapshotSignature');

process.env.DB_USER = process.env.DB_USER || 'test-only';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test-only';

const scorer = {
  id: 'assignment-scorer', assignment_id: 'assignment-scorer', legacy_hr_id: 'hr-scorer',
  person_id: 'person-scorer', membership_id: 'membership-scorer', name: '评分人', student_id: '1',
  department_id: 'department-1', identity_id: 'identity-scorer', work_group_id: '', assignment_kind: 'staff'
};
const target = {
  id: 'assignment-target', assignment_id: 'assignment-target', legacy_hr_id: 'hr-target',
  person_id: 'person-target', membership_id: 'membership-target', name: '被评人', student_id: '2',
  department_id: 'department-1', identity_id: 'identity-target', work_group_id: '', assignment_kind: 'staff'
};
const templates = [{
  templateId: 'template-1', templateName: '历史模板', weight: 1, sortOrder: 1,
  calculationMethod: 'weighted_average', trimHighCount: 0, trimLowCount: 0,
  questions: [{
    id: 'question-1', questionIndex: 1, globalQuestionIndex: 1, question: '历史问题', scoreLabel: '',
    minValue: 0, startValue: 0, maxValue: 100, stepValue: 1
  }]
}];
const policy = {
  rule: { id: 'rule-1', scorerDepartmentId: 'department-1', scorerIdentityCategoryId: 'identity-scorer', allowSelfAssessment: false },
  clause: { id: 'clause-1', scopeType: 'all_people', targetIdentityCategoryId: '', requireAllComplete: false, requiredTargets: [] },
  templates
};
const calculationSnapshot = {
  version: 1,
  capturedAt: '2026-08-01 00:00:00',
  activityId: 'activity-1',
  participantGranularity: 'assignment',
  templateConfigSignature: 'v2:historical',
  calculationPolicySignature: buildCalculationPolicySignature(policy, 1),
  scorer: { participantId: scorer.id, subjectKey: 'assignment:' + scorer.id },
  target: { participantId: target.id, subjectKey: 'assignment:' + target.id },
  rule: policy.rule,
  clause: policy.clause,
  templates
};
const record = {
  id: 'record-1', org_id: 'org-1', activity_id: 'activity-1', rule_id: 'rule-1',
  scorer_id: 'hr-scorer', scorer_person_id: 'person-scorer', scorer_assignment_id: scorer.id,
  scorer_subject_key: 'assignment:' + scorer.id,
  target_id: 'hr-target', target_person_id: 'person-target', target_assignment_id: target.id,
  target_subject_key: 'assignment:' + target.id,
  template_config_signature: 'v2:historical',
  calculation_context_snapshot: JSON.stringify(calculationSnapshot),
  submitted_at: '2026-08-01 00:00:00', revision_number: 3, updated_at: '2026-08-01 00:00:00'
};
const oldAnswers = [{ question_index: 1, score: 80 }];
const operations = [];
const insertedAnswers = [];
let cacheInvalidated = false;

const connection = {
  async query(sql, params) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM score_records/i.test(normalized)) {
      operations.push('lock-record');
      return [[Object.assign({}, record)]];
    }
    if (/^INSERT INTO score_record_revisions/i.test(normalized)) {
      throw new Error('重新评分不得保存旧评分副本');
    }
    if (/^UPDATE score_records SET revision_number/i.test(normalized)) {
      operations.push('advance');
      assert.deepStrictEqual([params[0], params[4]], [4, 3]);
      return [{ affectedRows: 1 }];
    }
    if (/^DELETE FROM score_answers/i.test(normalized)) {
      operations.push('delete-current-answers');
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO score_answers/i.test(normalized)) {
      operations.push('insert-current-answer');
      insertedAnswers.push({ questionIndex: params[2], score: params[3] });
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unexpected SQL: ' + normalized);
  }
};

const emptyModel = {};
const mocks = {
  '../../../config/db': {
    async withTransaction(callback) { return callback(connection); },
    async query() { throw new Error('评分覆盖不得绕过事务连接'); }
  },
  '../../../core/models/department': { async getAll() { return [{ id: 'department-1', name: '部门' }]; } },
  '../../../core/models/identity': { async getAll() { return [{ id: 'identity-scorer', name: '评分人' }, { id: 'identity-target', name: '被评人' }]; } },
  '../../../core/models/workGroup': { async getAll() { return []; } },
  '../utils/pubCache': { async invalidate(activityId, orgId) { cacheInvalidated = activityId === 'activity-1' && orgId === 'org-1'; } },
  '../models/scoreActivity': {
    async getById() { return { id: 'activity-1', name: '活动', is_paused: 1, participant_granularity: 'assignment' }; }
  },
  '../models/scoreTemplate': { async getById() { throw new Error('覆盖不得读取当前模板'); } },
  '../models/scoreQuestion': { async getByTemplateId() { throw new Error('覆盖不得读取当前题目'); } },
  '../models/rateRule': { async getByKey() { throw new Error('覆盖不得套用当前规则'); } },
  '../models/rateRuleClause': emptyModel,
  '../models/clauseTemplateConfig': emptyModel,
  '../models/scoreRecord': { async getByParticipantPair() { return [record]; } },
  '../models/scoreAnswer': { async getByRecordId() { return oldAnswers; } },
  '../../../core/models/adminInfo': emptyModel,
  '../../../core/services/currentActor': {
    async resolveCurrentActor() { return { ok: true, actor: { type: 'user', assignmentId: scorer.id, contextId: 'context-scorer' } }; }
  },
  '../../../core/models/unifiedIdentity': { async lockActiveBusinessSubjects() { operations.push('lock-subjects'); } },
  '../../../utils/requestDeduplication': {
    stableResourceId() { return 'score-resource'; },
    async claim() { return { claimed: true, enabled: false }; },
    async complete() { operations.push('dedup-complete'); }
  },
  '../services/participants': {
    normalizeGranularity() { return 'assignment'; },
    async resolveActorParticipant() { return scorer; },
    async resolveParticipant() { return target; },
    participantSubjectKey(item) { return 'assignment:' + item.assignment_id; },
    buildAssignmentLabel() { return '岗位'; },
    buildAssignmentSnapshot(item, extra) { return { assignmentId: item.assignment_id, contextId: extra && extra.contextId || '' }; }
  },
  '../../../utils/orgContext': { async getCurrentOrgId() { return 'org-1'; } }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const router = require('../src/modules/scoring/routes/scoring');

const layer = router.stack.find((item) => item.route && item.route.path === '/submitScoreRecord');
assert(layer, '缺少 submitScoreRecord 路由');

(async function run() {
  let payload;
  await layer.route.stack[0].handle({
    authAccount: { id: 'account-scorer', personId: 'person-scorer' },
    authContext: { role: 'user', personId: 'person-scorer', contextId: 'context-scorer', organizationId: 'org-1' },
    body: {
      targetId: target.id,
      activityId: 'activity-1',
      templateConfigSignature: 'v2:historical',
      existingRecordId: 'record-1',
      existingRecordRevision: 3,
      clientRequestId: 'revision-request-1',
      answers: [{ questionIndex: 1, score: 90 }]
    }
  }, {
    json(value) { payload = value; return value; }
  });

  assert.strictEqual(payload.status, 'success', payload.message);
  assert.strictEqual(payload.updated, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'revised'), false);
  assert.strictEqual(payload.revisionNumber, 4);
  assert.deepStrictEqual(insertedAnswers, [{ questionIndex: 1, score: 90 }]);
  assert.strictEqual(operations.includes('archive'), false);
  assert(operations.indexOf('advance') < operations.indexOf('delete-current-answers'));
  assert.strictEqual(cacheInvalidated, true);

  payload = null;
  await layer.route.stack[0].handle({
    authAccount: { id: 'account-scorer', personId: 'person-scorer' },
    authContext: { role: 'user', personId: 'person-scorer', contextId: 'context-scorer', organizationId: 'org-1' },
    body: {
      targetId: target.id,
      activityId: 'activity-1',
      templateConfigSignature: 'v2:historical',
      existingRecordId: 'record-1',
      existingRecordRevision: 4,
      clientRequestId: 'revision-request-duplicate-answer',
      answers: [
        { questionIndex: 1, score: 90 },
        { questionIndex: 1, score: 95 }
      ]
    }
  }, {
    json(value) { payload = value; return value; }
  });
  assert.strictEqual(payload.status, 'invalid_score');
  assert.match(payload.message, /重复题目|不完整/);
  console.log('评分覆盖事务替换当前答案、不保留旧副本并刷新结果缓存测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
});
