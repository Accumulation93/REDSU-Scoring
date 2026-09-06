'use strict';

const assert = require('assert');
const mysql = require('mysql2/promise');

if (!process.env.DEPLOY_TEST_DB_HOST) {
  console.log('未配置 DEPLOY_TEST_DB_HOST，跳过组织管理事务集成测试');
  process.exit(0);
}

const adminConfig = {
  host: process.env.DEPLOY_TEST_DB_HOST,
  port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
  user: process.env.DEPLOY_TEST_DB_USER || 'root',
  password: process.env.DEPLOY_TEST_DB_PASSWORD || ''
};
const database = `whusu_smart_workspace_org_management_${Date.now()}_${process.pid}`;
const testUser = `org_management_${process.pid}`;
const testPassword = `OrgManagement_${Date.now()}_${process.pid}`;
const requestedTestUserHost = process.env.TEST_DB_USER_HOST || '127.0.0.1';
const testUserHost = ['%', '127.0.0.1', 'localhost'].includes(requestedTestUserHost)
  ? requestedTestUserHost
  : '127.0.0.1';

function findHandler(router, routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, `找不到路由 ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, body) {
  return new Promise((resolve, reject) => {
    const req = {
      authAccount: { id: 'account-super', personId: 'person-super' },
      authContext: { role: 'admin', contextId: 'context-super', personId: 'person-super',
        organizationId: 'org-a', adminGrantId: 'grant-super', legacyAdminId: 'super', adminLevel: 'super_admin' },
      body,
      get() { return ''; }
    };
    const res = { json: resolve };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  const admin = await mysql.createConnection(adminConfig);
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    await admin.query(`CREATE USER '${testUser}'@'${testUserHost}' IDENTIFIED BY ?`, [testPassword]);
    await admin.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${testUser}'@'${testUserHost}'`);
    await admin.query(
      `CREATE TABLE \`${database}\`.system_config (
        id VARCHAR(64) PRIMARY KEY,
        current_organization VARCHAR(64) NULL,
        timezone INT DEFAULT 8,
        updated_at DATETIME NULL
      )`
    );
    await admin.query(
      `CREATE TABLE \`${database}\`.organizations (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )`
    );
    await admin.query(
      `CREATE TABLE \`${database}\`.admin_info (
        id VARCHAR(64) PRIMARY KEY,
        openid VARCHAR(128) NOT NULL,
        bind_status VARCHAR(32) NOT NULL,
        admin_level VARCHAR(32) NOT NULL,
        org_id VARCHAR(64) NOT NULL
      )`
    );
    await admin.query(
      `CREATE TABLE \`${database}\`.sample_org_data (
        id INT PRIMARY KEY AUTO_INCREMENT,
        org_id VARCHAR(64) NOT NULL
      )`
    );
    await admin.query(
      `INSERT INTO \`${database}\`.system_config
        (id, current_organization) VALUES ('default', 'org-a')`
    );
    await admin.query(
      `INSERT INTO \`${database}\`.organizations (id, name)
       VALUES ('org-a', 'A'), ('org-b', 'B'), ('org-c', 'C')`
    );
    await admin.query(
      `INSERT INTO \`${database}\`.admin_info
        (id, openid, bind_status, admin_level, org_id)
       VALUES ('super', 'super-openid', 'active', 'super_admin', '')`
    );
    await admin.query(
      `INSERT INTO \`${database}\`.sample_org_data (org_id) VALUES ('org-a')`
    );

    process.env.DB_HOST = adminConfig.host;
    process.env.DB_PORT = String(adminConfig.port);
    process.env.DB_USER = testUser;
    process.env.DB_PASSWORD = testPassword;
    process.env.DB_NAME = database;

    const router = require('../src/core/routes/org');
    pool = require('../src/config/db');
    const switchOrganization = findHandler(router, '/switchOrganization');
    const deleteOrganization = findHandler(router, '/deleteOrganization');

    const switched = await invoke(switchOrganization, {
      organizationId: 'org-b',
      organizationName: 'B updated'
    });
    assert.strictEqual(switched.status, 'success');
    const [configRows] = await pool.query(
      "SELECT current_organization FROM system_config WHERE id = 'default'"
    );
    assert.strictEqual(configRows[0].current_organization, 'org-b');

    const currentDelete = await invoke(deleteOrganization, { organizationId: 'org-b' });
    assert.strictEqual(currentDelete.status, 'forbidden');

    const populatedDelete = await invoke(deleteOrganization, { organizationId: 'org-a' });
    assert.strictEqual(populatedDelete.status, 'organization_not_empty');

    const emptyDelete = await invoke(deleteOrganization, { organizationId: 'org-c' });
    assert.strictEqual(emptyDelete.status, 'success');
    const [remaining] = await pool.query(
      "SELECT id FROM organizations WHERE id IN ('org-a', 'org-b', 'org-c') ORDER BY id"
    );
    assert.deepStrictEqual(remaining.map((row) => row.id), ['org-a', 'org-b']);

    console.log('组织切换与安全删除事务集成测试通过');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`DROP USER IF EXISTS '${testUser}'@'${testUserHost}'`);
    await admin.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
