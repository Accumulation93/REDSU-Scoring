const assert = require('assert');
const Module = require('module');

const activity = {
  id: 'history-activity',
  name: '历史评分活动',
  description: '用于验证历史组织评分结果'
};

const members = [
  {
    id: 'target-1',
    legacy_hr_id: 'target-1',
    person_id: 'person-target-1',
    name: '被评人',
    student_id: '20260001',
    department_id: '',
    identity_id: '',
    work_group_id: ''
  },
  {
    id: 'scorer-1',
    legacy_hr_id: 'scorer-1',
    person_id: 'person-scorer-1',
    name: '评分人',
    student_id: '20260002',
    department_id: '',
    identity_id: '',
    work_group_id: ''
  }
];

const records = [
  {
    id: 'record-1',
    activity_id: activity.id,
    scorer_id: 'scorer-1',
    target_id: 'target-1',
    rule_id: 'rule-1',
    submitted_at: '2026-07-01 10:00:00',
    template_config_signature: ''
  }
];

const emptyListModel = { async getAll() { return []; } };
const mocks = {
  '../../../core/models/adminInfo': {
    async getByOpenid() { return { id: 'admin-1', admin_level: 'admin' }; }
  },
  '../models/scoreActivity': {
    async getById(id) { return id === activity.id ? activity : null; }
  },
  '../../../core/models/hrInfo': {
    async getAll() { return members; }
  },
  '../../../core/models/department': emptyListModel,
  '../../../core/models/identity': emptyListModel,
  '../../../core/models/workGroup': emptyListModel,
  '../models/scoreTemplate': emptyListModel,
  '../models/scoreQuestion': {},
  '../models/rateRule': {
    async getByActivity() {
      return [{
        id: 'rule-1',
        scorer_key: '::',
        scorer_department_id: '',
        scorer_identity_id: '',
        allow_self_assessment: 1
      }];
    }
  },
  '../models/rateRuleClause': {
    async getByRuleIds() { return []; }
  },
  '../models/clauseTemplateConfig': {},
  '../models/scoreRecord': {
    async getByActivity() { return records; }
  },
  '../models/scoreAnswer': {
    async getByRecordIds() { return []; }
  },
  '../services/participants': {
    normalizeGranularity(value) { return value === 'assignment' ? 'assignment' : 'person'; },
    async listParticipants() { return members; },
    buildAssignmentLabel() { return ''; },
    participantRecordId(record, side) { return record[side + '_id']; },
    resolveHistoricalParticipant(record, side) {
      return {
        assignmentId: record[side + '_assignment_id'] || '',
        legacyHrId: record[side + '_id'] || '',
        historicalAssignmentUnavailable: true,
        contextSnapshot: {}
      };
    }
  },
  '../../../core/models/systemConfig': {},
  '../../../config/db': {
    async query() { return [[]]; }
  },
  '../../../utils/orgContext': {
    async getCurrentOrgId() { return 'history-org'; }
  },
  '../utils/sharedCache': {}
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const router = require('../src/modules/scoring/routes/results');
Module._load = originalLoad;

const routeLayer = router.stack.find((layer) => layer.route && layer.route.path === '/getScoreResults');
assert(routeLayer, '缺少 getScoreResults 路由');
const handler = routeLayer.route.stack[0].handle;

async function invoke(dataType, extraBody) {
  let payload;
  await handler({
    admin: { id: 'admin-1', admin_level: 'admin' },
    body: Object.assign({
      activityId: activity.id,
      dataType,
      filters: {}
    }, extraBody || {})
  }, {
    json(value) {
      payload = value;
      return value;
    }
  });
  return payload;
}

async function run() {
  const targetRecords = await invoke('targetRecords', { targetId: 'target-1' });
  assert.strictEqual(targetRecords.status, 'historical_snapshot_missing');
  assert.strictEqual(targetRecords.missingSnapshotCount, 1);

  const recordList = await invoke('records');
  assert.strictEqual(recordList.status, 'historical_snapshot_missing');
  assert.strictEqual(recordList.missingSnapshotCount, 1);
  assert.strictEqual(recordList.affectedRecordCount, 1);

  console.log('历史评分缺少不可变快照时显式失败测试通过');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
