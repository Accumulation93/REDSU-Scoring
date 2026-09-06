const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// 使用真实路由与本人解析器，仅隔离数据源；不能只用源码字符串证明认证兼容。
function loadIsolated(relative, dependencies) {
  const filename = path.resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (name) => Object.prototype.hasOwnProperty.call(dependencies, name)
    ? dependencies[name] : originalRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}

async function run() {
  let currentOrg = 'org-a';
  let hr = { id: 'hr-a', person_id: 'person-a', org_id: 'org-a', membership_id: 'member-a', name: 'fixture-a' };
  let mode = 'direct';
  let templateEnabled = true;
  let record = null;
  let barrierError = false;
  const events = [];
  const connection = {};
  const orgContext = { getCurrentOrgId: async () => currentOrg };
  const hrModel = {
    getActiveByPersonIdInOrg: async (personId, orgId) => {
      events.push(['subject', personId, orgId]);
      return hr;
    },
    getMembershipDirectory: async () => []
  };
  const selfSubject = loadIsolated('../src/core/services/selfHrProfileSubject.js', {
    '../models/hrInfo': hrModel, '../../utils/orgContext': orgContext
  });
  const forbiddenLegacy = new Proxy({}, { get() { throw new Error('不得重新查询微信绑定'); } });
  const templateModel = { getByTemplateKey: async () => templateEnabled ? { id: 'template-a', edit_mode: mode } : null };
  const fieldModel = { getByTemplateId: async () => [{ id: 'field-a', label: 'fixture', type: 'text', required: 1 }] };
  const recordModel = {
    getByHrId: async (id) => { events.push(['record-read', id]); return record; },
    getAll: async () => [],
    create: async (id, data, conn, orgId) => {
      assert.strictEqual(conn, connection);
      events.push(['create', data.hrId, orgId]);
    },
    update: async (id, data) => events.push(['update', id, data.audit_status])
  };
  const valueModel = {
    getByRecordIdAndPending: async (id, pending) => [{ field_id: 'field-a', field_value: pending ? 'pending' : 'effective' }],
    removeByRecordIdAndPendingFields: async (id, pending) => events.push(['remove-values', pending]),
    create: async (id, recordId, pending, fieldId, value) => events.push(['value', pending, fieldId, value])
  };
  const sharedModel = {
    key: (label, type) => label + ':' + type,
    mapRows: () => ({}),
    listForPerson: async (id) => { events.push(['shared-read', id]); return []; },
    upsertEffectiveValues: async (id, orgId) => events.push(['shared-write', id, orgId])
  };
  const unifiedIdentity = {
    lockActiveBusinessSubjects: async (conn, subjects) => {
      assert.strictEqual(conn, connection);
      assert.deepStrictEqual(subjects, [{ personId: 'person-a', legacyHrId: 'hr-a', organizationId: 'org-a' }]);
      events.push(['barrier']);
      if (barrierError) throw new Error('成员并发离任');
    },
    listDirectoryAssignmentSummaries: async () => new Map()
  };
  const adminContext = loadIsolated('../src/core/services/adminRequestContext.js', { '../models/adminInfo': forbiddenLegacy });
  const router = loadIsolated('../src/core/routes/hrProfile.js', {
    '../services/selfHrProfileSubject': selfSubject,
    '../services/adminRequestContext': adminContext,
    '../models/userInfo': forbiddenLegacy,
    '../models/adminInfo': forbiddenLegacy,
    '../models/hrInfo': hrModel,
    '../models/department': { getAll: async () => [] },
    '../models/identity': { getAll: async () => [] },
    '../models/workGroup': { getAll: async () => [] },
    '../models/hrProfileTemplate': templateModel,
    '../models/hrProfileField': fieldModel,
    '../models/hrProfileRecord': recordModel,
    '../models/hrProfileValue': valueModel,
    '../models/personProfileValue': sharedModel,
    '../models/hrProfileReviewEvent': {},
    '../models/personIdentityOverview': {},
    '../models/unifiedIdentity': unifiedIdentity,
    '../services/hrProfileTemplateLibrary': {},
    '../services/adminPermissions': {},
    '../services/userBindingStatus': { resolveHrBindingStates: async () => new Map() },
    '../../modules/audit/utils/notificationHelper': {},
    '../../utils/orgContext': orgContext,
    '../../config/db': { withTransaction: async (fn) => fn(connection) }
  });
  const baseRequest = {
    openid: 'temporary-wechat-not-bound',
    authAccount: { id: 'account-a', personId: 'person-a' },
    authContext: { role: 'user', personId: 'person-a', organizationId: 'org-a', legacyHrId: 'hr-a', membershipId: 'member-a', assignmentId: 'job-a' },
    body: { values: { 'field-a': 'own-value' }, personId: 'attacker', hrId: 'other-hr' },
    headers: { 'x-active-org': 'attacker-org', 'x-role': 'admin' }
  };
  async function request(endpoint, overrides) {
    events.length = 0;
    const req = Object.assign({}, baseRequest, overrides);
    let result;
    const res = { status() { return this; }, json(value) { result = value; return this; } };
    const layer = router.stack.find((item) => item.route && item.route.path === '/' + endpoint);
    await layer.route.stack[0].handle(req, res);
    return result;
  }
  // 临时会话、已绑定会话、微信属于另一自然人，结果都只归属于已认证账号。
  for (const openid of ['temporary-wechat-not-bound', 'bound-self', 'wechat-owned-by-person-b']) {
    const result = await request('getUserHrProfile', { openid });
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.profile.id, 'hr-a');
    assert.strictEqual(result.profile.personId, 'person-a');
    assert(events.some((event) => event[0] === 'shared-read' && event[1] === 'person-a'));
  }
  for (const context of [
    Object.assign({}, baseRequest.authContext, { assignmentId: '' }),
    { role: 'admin', personId: 'person-a', organizationId: 'org-a' }
  ]) {
    assert.strictEqual((await request('getUserHrProfile', { authContext: context })).status, 'success');
  }
  const validHr = hr;
  for (const invalidHr of [null, Object.assign({}, hr, { org_id: 'org-b' }), Object.assign({}, hr, { person_id: 'person-b' }), Object.assign({}, hr, { membership_id: 'other' })]) {
    hr = invalidHr;
    for (const endpoint of ['getUserHrProfile', 'submitUserHrProfile']) {
      const result = await request(endpoint);
      assert.notStrictEqual(result.status, 'success');
      assert(!result.message.includes('重新登录'));
      assert(events.every((event) => event[0] === 'subject'));
    }
  }
  hr = validHr;
  for (const context of [null, {}, Object.assign({}, baseRequest.authContext, { personId: 'person-b' }), Object.assign({}, baseRequest.authContext, { organizationId: 'org-b' }), Object.assign({}, baseRequest.authContext, { legacyHrId: 'hr-b' })]) {
    for (const endpoint of ['getUserHrProfile', 'submitUserHrProfile']) {
      assert.notStrictEqual((await request(endpoint, { authContext: context })).status, 'success');
      assert(!events.some((event) => event[0] === 'create' || event[0] === 'record-read'));
    }
  }
  currentOrg = 'org-b';
  assert.notStrictEqual((await request('getUserHrProfile')).status, 'success');
  currentOrg = 'org-a';
  assert.notStrictEqual((await request('getUserHrProfile', { authAccount: null })).status, 'success');
  for (const editMode of ['direct', 'audit']) {
    mode = editMode;
    assert.strictEqual((await request('submitUserHrProfile')).status, 'success');
    assert(events.findIndex((event) => event[0] === 'barrier') < events.findIndex((event) => event[0] === 'create'));
    assert(events.some((event) => event[0] === 'create' && event[1] === 'hr-a' && event[2] === 'org-a'));
    assert.strictEqual(events.some((event) => event[0] === 'shared-write'), mode === 'direct');
    assert(events.some((event) => event[0] === 'value' && event[1] === (mode === 'audit' ? 1 : 0)));
  }
  record = { id: 'record-a', audit_status: 'pending' };
  assert.strictEqual((await request('getUserHrProfile')).pendingValues['field-a'], 'pending');
  assert.strictEqual((await request('submitUserHrProfile')).status, 'success');
  assert(events.some((event) => event[0] === 'update' && event[1] === 'record-a'));
  barrierError = true;
  assert.strictEqual((await request('submitUserHrProfile')).status, 'error');
  assert(!events.some((event) => ['update', 'create', 'value', 'shared-write'].includes(event[0])));
  barrierError = false;
  mode = 'readonly';
  assert.strictEqual((await request('submitUserHrProfile')).status, 'readonly');
  mode = 'direct';
  assert.strictEqual((await request('submitUserHrProfile', { body: { values: {} } })).status, 'invalid_params');
  templateEnabled = false;
  assert.strictEqual((await request('getUserHrProfile')).status, 'success');
  assert.strictEqual((await request('submitUserHrProfile')).status, 'missing_template');
  assert.strictEqual((await request('getHrPersonDetail')).status, 'forbidden');
  // 当前管理员无旧 admin_info 也能通过认证，随后仍执行成员参数与范围校验。
  const adminReq = { authContext: { role: 'admin', personId: 'person-a', organizationId: 'org-a', adminLevel: 'admin', adminGrantId: 'grant-a' }, body: {} };
  assert.strictEqual((await request('getHrPersonDetail', adminReq)).status, 'invalid_params');
  console.log('本人资料统一会话读取、保存、未绑定与跨账号隔离回归通过');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
