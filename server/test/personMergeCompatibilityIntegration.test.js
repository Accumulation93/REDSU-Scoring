const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

if (!process.env.DEPLOY_TEST_DB_HOST) {
  console.log('未配置 DEPLOY_TEST_DB_HOST，跳过自然人合并兼容绑定集成测试');
  process.exit(0);
}

const suffix = `${Date.now()}_${process.pid}`;
const databaseName = `whusu_merge_compat_${suffix}`;
const appUser = `merge_${process.pid}_${String(Date.now()).slice(-6)}`;
const appPassword = 'MergeCompatibility-2026';
const adminConfig = {
  host: process.env.DEPLOY_TEST_DB_HOST,
  port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
  user: process.env.DEPLOY_TEST_DB_USER || 'root',
  password: process.env.DEPLOY_TEST_DB_PASSWORD || ''
};

function versionOf(value) {
  return String(new Date(value).getTime());
}

async function invokeAdminLogin(router, openid) {
  const layer = router.stack.find((item) => item.route && item.route.path === '/adminLogin');
  assert(layer, '缺少 adminLogin 路由');
  let payload;
  let statusCode = 200;
  const req = {
    body: { openid },
    logger: { warn() {} }
  };
  const res = {
    status(value) { statusCode = value; return this; },
    json(value) { payload = value; return value; }
  };
  await layer.route.stack[0].handle(req, res);
  return { payload, statusCode };
}

async function seed(connection, legacyHash) {
  await connection.query(`
    INSERT INTO organizations (id, name) VALUES
      ('org-source', '源组织'),
      ('org-target', '目标组织');
    INSERT INTO system_config (id, current_organization)
      VALUES ('default', 'org-target')
      ON DUPLICATE KEY UPDATE current_organization = VALUES(current_organization);
    INSERT INTO hr_info (id, name, student_id, org_id) VALUES
      ('hr-source', '源人员', 'source-001', 'org-source'),
      ('hr-target', '目标人员', 'target-001', 'org-target');
    INSERT INTO persons
      (id, name, student_id, normalized_student_id, status, updated_at) VALUES
      ('person-source', '源人员', 'source-001', 'source-001', 'active', '2026-08-22 09:00:00'),
      ('person-target', '目标人员', 'target-001', 'target-001', 'active', '2026-08-22 09:30:00');
    INSERT INTO organization_memberships
      (id, person_id, org_id, legacy_hr_id, status) VALUES
      ('membership-source', 'person-source', 'org-source', 'hr-source', 'active'),
      ('membership-target', 'person-target', 'org-target', 'hr-target', 'active');
    INSERT INTO accounts (id, person_id, status) VALUES
      ('account-source', 'person-source', 'verified'),
      ('account-target', 'person-target', 'verified');
    INSERT INTO account_wechat_bindings
      (id, account_id, app_id, openid_hash, hash_version, legacy_openid,
       status, active_account_id) VALUES
      ('binding-source', 'account-source', 'whusu-smart-workspace', ?, 'sha256_legacy',
       'openid-source', 'active', 'account-source'),
      ('binding-target', 'account-target', 'whusu-smart-workspace', ?, 'sha256_legacy',
       'openid-target', 'active', 'account-target');
    INSERT INTO user_info (id, openid, hr_id, org_id) VALUES
      ('user-source', 'openid-source', 'hr-source', 'org-source'),
      ('user-target', 'openid-target', 'hr-target', 'org-target');
    INSERT INTO admin_info
      (id, name, student_id, openid, admin_level, bind_status, org_id) VALUES
      ('admin-source', '源管理员', 'source-admin', 'openid-source', 'admin', 'active', 'org-source'),
      ('admin-target', '目标管理员', 'target-admin', 'openid-target', 'admin', 'active', 'org-target');
    INSERT INTO admin_grants
      (id, person_id, org_id, admin_level, status, legacy_admin_id) VALUES
      ('grant-source', 'person-source', 'org-source', 'admin', 'active', 'admin-source'),
      ('grant-target', 'person-target', 'org-target', 'admin', 'active', 'admin-target');
  `, [legacyHash('openid-source'), legacyHash('openid-target')]);
}

async function run() {
  const admin = await mysql.createConnection(adminConfig);
  let fixture;
  let appPool;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`CREATE USER '${appUser}'@'%' IDENTIFIED BY '${appPassword}'`);
    await admin.query(`GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${appUser}'@'%'`);
    fixture = await mysql.createConnection(Object.assign({}, adminConfig, {
      database: databaseName,
      multipleStatements: true
    }));
    await fixture.query(fs.readFileSync(path.resolve(__dirname, '../db/init.sql'), 'utf8'));

    process.env.DB_HOST = adminConfig.host;
    process.env.DB_PORT = String(adminConfig.port);
    process.env.DB_USER = appUser;
    process.env.DB_PASSWORD = appPassword;
    process.env.DB_NAME = databaseName;
    process.env.JWT_SECRET = 'person-merge-compatibility-integration-secret';
    process.env.AUTH_IDENTITY_SECRET = process.env.JWT_SECRET;
    process.env.WECHAT_APPID = 'test-wechat-appid';
    process.env.WECHAT_SECRET = 'test-wechat-secret';
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_DEV_OPENID_LOGIN = '1';

    const { legacyHash } = require('../src/core/services/identityCrypto');
    await seed(fixture, legacyHash);
    const governance = require('../src/core/models/personGovernance');
    const unifiedIdentity = require('../src/core/models/unifiedIdentity');
    const identityModel = require('../src/core/models/unifiedIdentity');
    appPool = require('../src/config/db');

    await fixture.query(`
      INSERT INTO departments (id, name, org_id) VALUES
        ('department-valid', '有效部门', 'org-target'),
        ('department-other', '其他部门', 'org-target');
      INSERT INTO identities (id, name, org_id)
        VALUES ('identity-valid', '有效身份', 'org-target');
      INSERT INTO work_groups (id, name, department_id, org_id)
        VALUES ('group-other', '错位职能组', 'department-other', 'org-target');
      INSERT INTO hr_info
        (id, name, student_id, department_id, identity_id, work_group_id, org_id) VALUES
        ('hr-incomplete', '无岗位成员', 'sync-001', 'department-valid', NULL, NULL, 'org-target'),
        ('hr-invalid-identity', '身份失效成员', 'sync-002', 'department-valid', 'identity-missing', NULL, 'org-target'),
        ('hr-mismatch-group', '职能组错位成员', 'sync-003', 'department-valid', 'identity-valid', 'group-other', 'org-target');
    `);
    await appPool.withTransaction((connection) => unifiedIdentity.syncLegacyHrRecords(
      connection,
      ['hr-incomplete', 'hr-invalid-identity', 'hr-mismatch-group']
    ));
    const [syncedMemberships] = await fixture.query(`
      SELECT h.id, om.status AS membership_status, ma.status AS assignment_status,
             ma.department_id, ma.identity_id, ma.work_group_id,
             h.work_group_id AS legacy_work_group_id
        FROM hr_info h
        JOIN organization_memberships om ON om.legacy_hr_id = h.id AND om.org_id = h.org_id
        LEFT JOIN membership_assignments ma
          ON ma.membership_id = om.id AND ma.org_id = om.org_id AND ma.status = 'active'
       WHERE h.id IN ('hr-incomplete', 'hr-invalid-identity', 'hr-mismatch-group')
       ORDER BY h.id
    `);
    assert.deepStrictEqual(syncedMemberships, [
      {
        id: 'hr-incomplete', membership_status: 'active', assignment_status: null,
        department_id: null, identity_id: null, work_group_id: null, legacy_work_group_id: null
      },
      {
        id: 'hr-invalid-identity', membership_status: 'active', assignment_status: null,
        department_id: null, identity_id: null, work_group_id: null, legacy_work_group_id: null
      },
      {
        id: 'hr-mismatch-group', membership_status: 'active', assignment_status: 'active',
        department_id: 'department-valid', identity_id: 'identity-valid',
        work_group_id: null, legacy_work_group_id: null
      }
    ]);

    await assert.rejects(governance.mergePersons({
      sourcePersonId: 'person-source',
      targetPersonId: 'person-target',
      sourceVersion: versionOf('2026-08-22 09:00:00'),
      targetVersion: versionOf('2026-08-22 09:30:00'),
      organizationId: 'org-target'
    }, { personId: 'person-target', contextId: 'context-target' }), (error) => (
      error && error.code === 'person_not_found'
    ));

    await governance.mergePersons({
      sourcePersonId: 'person-source',
      targetPersonId: 'person-target',
      sourceVersion: versionOf('2026-08-22 09:00:00'),
      targetVersion: versionOf('2026-08-22 09:30:00'),
      organizationId: 'org-source'
    }, { personId: 'person-target', contextId: 'context-target' });

    const [sourceStates] = await fixture.query(`
      SELECT a.status AS account_status, b.status AS binding_status
        FROM accounts a
        JOIN account_wechat_bindings b ON b.account_id = a.id
       WHERE a.id = 'account-source'
    `);
    assert.deepStrictEqual(sourceStates[0], { account_status: 'frozen', binding_status: 'revoked' });

    const [compatUsers] = await fixture.query(`
      SELECT openid, hr_id, org_id FROM user_info
       WHERE openid IN ('openid-source', 'openid-target')
       ORDER BY org_id
    `);
    assert.deepStrictEqual(compatUsers, [
      { openid: 'openid-target', hr_id: 'hr-source', org_id: 'org-source' },
      { openid: 'openid-target', hr_id: 'hr-target', org_id: 'org-target' }
    ]);

    const [compatAdmins] = await fixture.query(`
      SELECT id, openid, bind_status FROM admin_info
       WHERE id IN ('admin-source', 'admin-target') ORDER BY id
    `);
    assert.deepStrictEqual(compatAdmins, [
      { id: 'admin-source', openid: 'openid-target', bind_status: 'active' },
      { id: 'admin-target', openid: 'openid-target', bind_status: 'active' }
    ]);
    assert.deepStrictEqual(await identityModel.listContexts('account-source'), []);
    assert.strictEqual((await identityModel.listContexts('account-target')).filter((item) => item.role === 'admin').length, 2);

    const [orgAccess] = await fixture.query(`
      SELECT 1
        FROM user_info ui
        JOIN hr_info h ON h.id = ui.hr_id AND h.org_id = ui.org_id
       WHERE ui.openid = 'openid-target' AND ui.org_id = 'org-source'
    `);
    assert.strictEqual(orgAccess.length, 1, '目标账号必须保留转移组织的兼容 user_info 访问映射');

    const authRouter = require('../src/core/routes/auth');
    const oldLogin = await invokeAdminLogin(authRouter, 'openid-source');
    assert.strictEqual(oldLogin.statusCode, 426);
    assert.strictEqual(oldLogin.payload.status, 'client_upgrade_required');
    const targetLogin = await invokeAdminLogin(authRouter, 'openid-target');
    assert.strictEqual(targetLogin.statusCode, 426);
    assert.strictEqual(targetLogin.payload.status, 'client_upgrade_required');

    await assert.rejects(governance.mergePersons({
      sourcePersonId: 'person-source',
      targetPersonId: 'person-target',
      sourceVersion: '',
      targetVersion: '',
      organizationId: 'org-target'
    }, { personId: 'person-target', contextId: 'context-target' }), (error) => (
      error && error.code === 'person_not_found'
    ));

    const retryResult = await governance.mergePersons({
      sourcePersonId: 'person-source',
      targetPersonId: 'person-target',
      sourceVersion: '',
      targetVersion: '',
      organizationId: 'org-source'
    }, { personId: 'person-target', contextId: 'context-target' });
    assert.strictEqual(retryResult.idempotent, true);
    assert.deepStrictEqual(await identityModel.listContexts('account-source'), []);
    assert.strictEqual((await identityModel.listContexts('account-target')).filter((item) => item.role === 'admin').length, 2);
    console.log('双账号自然人合并、兼容绑定重建与旧管理员登录阻断集成测试通过');
  } finally {
    if (appPool) await appPool.end();
    if (fixture) await fixture.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.query(`DROP USER IF EXISTS '${appUser}'@'%'`);
    await admin.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
