const assert = require('assert');
const Module = require('module');

let scenario = {
  orgId: 'org-44',
  activity: null,
  cached: null
};
const cacheReads = [];

const emptyModel = {};
const mocks = {
  '../../../core/models/adminInfo': {
    async getByOpenid() { return { id: 'admin-super', admin_level: 'super_admin', org_id: '' }; }
  },
  '../models/scoreActivity': {
    async getById(id) {
      return scenario.activity && scenario.activity.id === id ? scenario.activity : null;
    }
  },
  '../../../core/models/hrInfo': emptyModel,
  '../../../core/models/department': emptyModel,
  '../../../core/models/identity': emptyModel,
  '../../../core/models/workGroup': emptyModel,
  '../models/scoreTemplate': emptyModel,
  '../models/scoreQuestion': emptyModel,
  '../models/rateRule': emptyModel,
  '../models/rateRuleClause': emptyModel,
  '../models/clauseTemplateConfig': emptyModel,
  '../models/scoreRecord': emptyModel,
  '../models/scoreAnswer': emptyModel,
  '../../../core/models/systemConfig': emptyModel,
  '../../../config/db': {},
  '../../../utils/orgContext': {
    async getCurrentOrgId() { return scenario.orgId; }
  },
  '../utils/sharedCache': {
    async get(key) {
      cacheReads.push(key);
      return scenario.cached;
    },
    async invalidateKey() {}
  }
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

async function invoke(activityId) {
  let payload;
  await handler({
    admin: { id: 'admin-super', admin_level: 'super_admin', org_id: '' },
    body: { activityId, dataType: 'overview', filters: {} }
  }, {
    json(value) {
      payload = value;
      return value;
    }
  });
  return payload;
}

async function run() {
  scenario = {
    orgId: 'org-44',
    activity: null,
    cached: {
      activity: { id: 'activity-43' },
      overviewRows: [{ id: 'member-43' }],
      stats: { memberCount: 778 },
      filterOptions: {}
    }
  };
  cacheReads.length = 0;
  const rejected = await invoke('activity-43');
  assert.strictEqual(rejected.status, 'activity_not_found');
  assert.deepStrictEqual(rejected.overviewRows, []);
  assert.deepStrictEqual(rejected.stats, {
    totalMembers: 0,
    scoredMembers: 0,
    recordCount: 0,
    completedMembers: 0
  });
  assert.strictEqual(cacheReads.length, 0, '跨组织旧活动不得读取缓存');

  scenario.activity = { id: 'activity-44', name: '第四十四届活动' };
  scenario.cached = {
    activity: scenario.activity,
    overviewRows: [],
    stats: { memberCount: 0 },
    filterOptions: {},
    historicalIntegrityVerified: true
  };
  const org44 = await invoke('activity-44');
  assert.strictEqual(org44.status, 'success');
  assert(cacheReads[0].includes('org-44_activity-44_overview'), '缓存键必须包含组织、活动和视图');

  scenario.orgId = 'org-43';
  await invoke('activity-44');
  assert.notStrictEqual(cacheReads[0], cacheReads[1], '不同组织不得共享结果缓存键');
  assert(cacheReads[1].includes('org-43_activity-44_overview'));

  console.log('评分结果组织缓存隔离测试通过');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
