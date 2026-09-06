const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function loadIsolated(relative, dependencies) {
  const filename = path.resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.prototype.hasOwnProperty.call(dependencies, name)
    ? dependencies[name] : originalRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}

const ownContext = {
  role: 'user', contextId: 'context-a', personId: 'person-a', organizationId: 'org-a',
  organizationName: '组织甲', legacyHrId: 'hr-a', membershipId: 'member-a',
  assignmentId: 'assignment-a', departmentId: 'department-a', identityCategoryId: 'identity-a', name: '同名'
};
function request(openid) {
  return {
    openid,
    authAccount: { id: 'account-a', personId: 'person-a' },
    authContext: ownContext,
    // 故意伪造客户端旧字段，业务主体不得读取它们。
    headers: { 'x-role': 'admin', 'x-active-org': 'org-other' },
    body: { accountId: 'account-other', personId: 'person-other', openid: 'super-admin-wechat' }
  };
}

async function run() {
  const catalog = [
    ownContext,
    Object.assign({}, ownContext, {
      contextId: 'context-b', organizationId: 'org-b', organizationName: '组织乙',
      legacyHrId: 'hr-b', assignmentId: 'assignment-b', membershipId: 'member-b'
    }),
    Object.assign({}, ownContext, {
      role: 'admin', contextId: 'context-admin', adminGrantId: 'grant-a', legacyAdminId: '',
      adminLevel: 'admin', assignmentId: '', legacyHrId: ''
    }),
    Object.assign({}, ownContext, { contextId: 'another-person', personId: 'person-other' })
  ];
  let contextQueries = 0;
  const accessible = loadIsolated('../src/core/services/accessibleOrganizations.js', {
    '../models/unifiedIdentity': {
      async listContexts(accountId) {
        assert.strictEqual(accountId, 'account-a');
        contextQueries += 1;
        return catalog;
      }
    }
  });
  const expected = await accessible.listAccessibleActorContexts(request('bound-wechat'));
  assert.strictEqual(expected.length, 3, '多岗位和无旧管理员记录的管理授权必须保留');
  assert.strictEqual(expected[2].actor.id, 'grant-a');
  assert.strictEqual(expected[2].actor.profile.org_id, 'org-a');
  assert.strictEqual(expected[0].actor.personId, 'person-a');
  assert.strictEqual(expected[0].actor.profile.identity_id, 'identity-a');
  assert(!JSON.stringify(expected).includes('openid'));
  for (const openid of ['', 'unbound-wechat', 'another-person-wechat']) {
    assert.deepStrictEqual(await accessible.listAccessibleActorContexts(request(openid)), expected);
  }
  assert.deepStrictEqual(await accessible.listAvailableOrganizations(request(''), 'user'), [
    { id: 'org-a', name: '组织甲', role: 'user' },
    { id: 'org-b', name: '组织乙', role: 'user' }
  ]);
  const previousQueries = contextQueries;
  assert.deepStrictEqual(await accessible.listAccessibleActorContexts({ openid: 'bound-wechat' }), []);
  assert.deepStrictEqual(await accessible.listAccessibleActorContexts(Object.assign({}, request(''), {
    authAccount: { id: 'account-other', personId: 'person-other' }
  })), []);
  assert.strictEqual(contextQueries, previousQueries, '未认证和主体冲突不能进入目录查询');

  let venueQueries = 0;
  const viewer = loadIsolated('../src/modules/venue/services/venueViewerScope.js', {
    '../../../config/db': {
      async query(sql, params) {
        venueQueries += 1;
        assert(!/openid|user_info|admin_info/.test(sql), '场地范围不得关联旧微信人员目录');
        assert(sql.includes("p.status = 'active'"));
        assert.deepStrictEqual(params, ['person-a']);
        if (sql.includes('organization_memberships')) return [[{ org_id: 'org-a', legacy_hr_id: 'hr-a' }]];
        assert(sql.includes('admin_grants'));
        return [[{ id: 'grant-a', legacy_admin_id: 'legacy-admin-a', org_id: 'org-b', admin_level: 'admin' }]];
      }
    }
  });
  const expectedScope = await viewer.resolveVenueViewerScope(request('bound-wechat'));
  for (const openid of ['', 'super-admin-wechat', 'unbound-wechat']) {
    const scope = await viewer.resolveVenueViewerScope(request(openid));
    assert.deepStrictEqual(scope, expectedScope);
    assert.strictEqual(scope.isSuperAdmin, false, '当前微信属于超级管理员也不能提升口令账号');
    assert.strictEqual(viewer.canViewBookingDetails({ creator_org_id: 'org-other' }, scope), false);
    assert.strictEqual(viewer.canViewBookingDetails({ creator_org_id: 'org-b' }, scope), true);
    assert(scope.adminIds.has('grant-a') && scope.adminIds.has('legacy-admin-a'));
  }
  const beforeDenied = venueQueries;
  const denied = await viewer.resolveVenueViewerScope({ openid: 'super-admin-wechat' });
  assert.strictEqual(denied.personId, '');
  assert.strictEqual(denied.orgs.size, 0);
  assert.strictEqual(venueQueries, beforeDenied);

  const grants = loadIsolated('../src/core/models/adminInfo.js', {
    '../../config/db': { query() { throw new Error('事务连接未透传'); } },
    '../../utils/orgContext': { async getCurrentOrgId() { return 'org-a'; } },
    '../services/identityCrypto': {}
  });
  const transaction = {
    async query(sql, params) {
      assert.deepStrictEqual(params, ['account-a', 'person-a', 'org-b']);
      assert(sql.includes("a.status = 'verified'"));
      assert(sql.includes("g.status = 'active'"));
      assert(sql.includes('g.org_id = ?'));
      assert(sql.endsWith(' FOR UPDATE'));
      assert(!/openid|account_wechat_bindings/.test(sql));
      return [[{ id: 'grant-a', person_id: 'person-a', org_id: 'org-b' }]];
    }
  };
  const grant = await grants.getActiveGrantForAccountInOrganization('account-a', 'person-a', 'org-b', transaction, true);
  assert.strictEqual(grant.id, 'grant-a');
  assert.strictEqual(await grants.getActiveGrantForAccountInOrganization('', 'person-a', 'org-b'), null);
  console.log('认证方式等效、自然人隔离、无微信岗位目录、场地范围及跨组织授权测试通过');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
