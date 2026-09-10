'use strict';

// 执行真实路由与校验代码；仅隔离认证和持久层，不向正式业务写入夹具。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../src/modules/audit/routes/auditAdmin.js');
const realRequire = createRequire(filename);
let calls;
let failure;
let authorized = true;
const record = name => async (...args) => {
  calls.push(name);
  if (failure === name) throw new Error('injected_failure');
  return args;
};
const connection = {
  beginTransaction: record('begin'), commit: record('commit'),
  rollback: record('rollback'), release() { calls.push('release'); }
};
const mocks = {
  '../../../core/services/adminRequestContext': { async resolveRequestAdmin() { return authorized ? { id: 'test-admin' } : null; } },
  '../../../utils/orgContext': { async getCurrentOrgId() { return 'test-org'; } },
  '../../../config/db': { async getConnection() { calls.push('acquire'); return connection; } },
  '../../../core/services/dictionaryUsage': {
    lockOrganizationDictionaryWrites: record('dictionaryLock'), assertDictionaryReferences: record('dictionaryCheck')
  },
  '../models/auditFlowTemplate': {
    create: record('create'), update: record('update'),
    async getByIdForUpdate(id) { calls.push('lockTemplate'); return id === 'existing' ? { id } : null; }
  },
  '../models/auditFlowTemplateStep': { create: record('step'), removeByTemplateId: record('removeSteps') },
  '../models/auditFlowTemplateStepCondition': { create: record('condition') },
  '../services/auditPersonAssignmentCondition': {
    async resolveAndValidateBindings(condition) {
      return { ok: Boolean(condition.personHrIds && condition.assignmentIds), condition, reason: 'invalid_binding' };
    }
  }
};
const sandbox = {
  module: { exports: {} },
  require(name) {
    if (mocks[name]) return mocks[name];
    if (name === 'express' || name.includes('/locales/') || name.endsWith('/helpers')
      || name.endsWith('/auditWorkflowPolicy')) return realRequire(name);
    return {};
  }
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
const handler = sandbox.module.exports.stack.find(layer => layer.route.path === '/saveAuditFlowTemplate').route.stack[0].handle;
const condition = () => ({ conditionType: 'identity_scope', departmentScope: 'all', workGroupScope: 'all', identityScope: 'all' });
const payload = () => ({ name: '测试流程', starterType: 'conditions', starterConditions: [condition()], resubmitMode: 'fresh', steps: [{ name: '审核', actionType: 'sign', conditions: [condition()] }] });
async function invoke(body) {
  calls = [];
  let result;
  await handler({ body }, { json(value) { result = value; return value; } });
  return result;
}

(async () => {
  for (const actionType of ['pass', 'sign', 'estamp', 'both']) {
    const body = payload();
    body.steps[0].actionType = actionType;
    const result = await invoke(body);
    assert.equal(result.status, 'success', `${actionType}: ${result.message}`);
    assert.ok(result.id);
    assert.deepEqual(calls.slice(-2), ['commit', 'release']);
  }
  const edit = payload(); edit.id = 'existing';
  assert.equal((await invoke(edit)).status, 'success');
  assert.ok(calls.includes('update') && calls.includes('removeSteps'));
  const missing = payload(); missing.id = 'other-org-or-missing';
  assert.equal((await invoke(missing)).status, 'not_found');
  assert.deepEqual(calls.slice(-2), ['rollback', 'release']);
  for (const invalidStep of [null, {}, { actionType: 'unknown', conditions: [condition()] }, { conditions: [null] }]) {
    const body = payload(); body.steps.push(invalidStep);
    assert.equal((await invoke(body)).status, 'invalid_params');
    assert.ok(!calls.includes('acquire'), '所有步骤必须在事务前完成形状校验');
  }
  const badStarter = payload(); badStarter.starterConditions = [null];
  assert.equal((await invoke(badStarter)).status, 'invalid_params');
  for (const legacy of [
    { approverType: 'identity', approverIdentityId: 'identity-test' },
    { approverType: 'specific_person', approverHrId: 'hr-test', approverAssignmentIds: 'assignment-test' }
  ]) {
    const body = payload(); body.steps = [legacy];
    assert.equal((await invoke(body)).status, 'success');
  }
  failure = 'condition';
  assert.equal((await invoke(payload())).status, 'error');
  assert.deepEqual(calls.slice(-2), ['rollback', 'release']);
  assert.ok(!calls.includes('commit'));
  failure = null;
  assert.equal((await invoke(payload())).status, 'success');
  authorized = false;
  assert.equal((await invoke(payload())).status, 'forbidden');
  assert.deepEqual(calls, []);
  console.log('审核模板真实保存路由：创建、更新、逐步校验、旧参数、回滚和权限测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
