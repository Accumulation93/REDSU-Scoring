'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const mysql = require('mysql2/promise');
if (!process.env.DEPLOY_TEST_DB_HOST) {
  console.log('未配置隔离数据库，未执行审核模板保存数据库验收');
  process.exit(0);
}
const database = 'whusu_submit_' + process.pid + '_' + Date.now();
const user = 'submit_' + process.pid;
const password = crypto.randomBytes(32).toString('hex');
const options = {
  host: process.env.DEPLOY_TEST_DB_HOST, port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
  user: process.env.DEPLOY_TEST_DB_USER || 'root', password: process.env.DEPLOY_TEST_DB_PASSWORD || ''
};
(async () => {
  const admin = await mysql.createConnection(options);
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ?`, [password]);
    await admin.query(`GRANT ALL ON \`${database}\`.* TO '${user}'@'%'`);
    const fixture = await mysql.createConnection({ ...options, database, multipleStatements: true });
    try { await fixture.query(fs.readFileSync(path.resolve(__dirname, '../db/init.sql'), 'utf8')); }
    finally { await fixture.end(); }
    Object.assign(process.env, { DB_HOST: options.host, DB_PORT: String(options.port), DB_USER: user, DB_PASSWORD: password,
      DB_NAME: database, AUTH_IDENTITY_SECRET: crypto.randomBytes(32).toString('hex') });
    pool = require('../src/config/db');
    const { orgStorage } = require('../src/utils/orgContext');
    const router = require('../src/modules/audit/routes/auditAdmin');
    await pool.query("INSERT INTO organizations (id,name) VALUES ('submit-a','测试甲'),('submit-b','测试乙')");
    const call = async (name, body, org = 'submit-a') => {
      const handler = router.stack.find(layer => layer.route.path === '/' + name).route.stack[0].handle;
      let result;
      await orgStorage.run(org, () => handler({ admin: { id: 'test-admin' }, body }, { json(value) { result = value; return value; } }));
      return result;
    };
    const condition = { conditionType: 'identity_scope', departmentScope: 'all', workGroupScope: 'all', identityScope: 'all' };
    const source = path.resolve(__dirname, '../../miniprogram/subpackages/scoring/pages/admin/modules/auditBehavior.js');
    let behavior;
    vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
      module: { exports: {} }, Behavior(value) { behavior = value; return value; },
      require(name) {
        if (name === './adminUtils') return { showShortToast() {}, getErrorText(error) { return error.message; } };
        return {};
      }
    }, { filename: source });
    let saved;
    const page = {
      data: { auditTemplateForm: { id: '', name: '模板测试', description: '', starterType: 'conditions',
        starterConditions: [condition], resubmitMode: 'fresh',
        steps: ['pass', 'sign', 'estamp', 'both'].map(actionType => ({ name: actionType, actionType, conditions: [condition], allowApproverDesignation: true })) } },
      setLoading() {}, startCreateAuditTemplate() {}, loadAuditFlowTemplates() {},
      async callCloud(name, body) { saved = await call(name, JSON.parse(JSON.stringify(body))); return saved; }
    };
    // 实际前端保存方法 -> JSON 传参 -> 实际路由 -> 实际 MySQL。
    await behavior.methods.saveAuditFlowTemplate.call(page);
    assert.equal(saved.status, 'success', saved.message);
    const ids = [saved.id];
    for (let i = 0; i < 2; i++) { await behavior.methods.saveAuditFlowTemplate.call(page); assert.equal(saved.status, 'success', saved.message); ids.push(saved.id); }
    assert.equal(new Set(ids).size, 3);
    page.data.auditTemplateForm.id = ids[1]; page.data.auditTemplateForm.name = '仅修改第二条';
    await behavior.methods.saveAuditFlowTemplate.call(page);
    assert.equal(saved.status, 'success', saved.message);
    const listed = await call('listAuditFlowTemplates', {});
    assert.equal(listed.status, 'success', listed.message);
    assert.equal(listed.templates.length, 3);
    assert.equal(listed.templates.find(item => item.id === ids[0]).name, '模板测试');
    const edited = listed.templates.find(item => item.id === ids[1]);
    assert.equal(edited.name, '仅修改第二条');
    assert.deepEqual(edited.steps.map(item => item.actionType), ['pass', 'sign', 'estamp', 'both']);
    assert.ok(edited.steps.every(item => item.allowApproverDesignation && item.conditions.length === 1));
    assert.equal((await call('saveAuditFlowTemplate', page.data.auditTemplateForm, 'submit-b')).status, 'not_found');
    const invalid = JSON.parse(JSON.stringify(page.data.auditTemplateForm));
    invalid.steps[3].actionType = 'invalid';
    assert.equal((await call('saveAuditFlowTemplate', invalid)).status, 'invalid_params');
    assert.equal((await call('listAuditFlowTemplates', {})).templates.find(item => item.id === ids[1]).steps.length, 4);
    for (const id of ids) assert.equal((await call('deleteAuditFlowTemplate', { id })).status, 'success');
    assert.equal((await call('listAuditFlowTemplates', {})).templates.length, 0);
    console.log('审核模板前端真实传参→真实路由→MySQL：连续新增、分别编辑、回读、跨组织拒绝、非法步骤不覆盖、删除通过');
  } finally {
    if (pool) await pool.end();
    // 名称由本测试固定前缀及进程/时间生成，只清理本次创建的隔离库和用户。
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await admin.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
