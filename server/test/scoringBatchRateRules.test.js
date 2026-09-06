'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const actualHelpers = require('../src/utils/helpers');

process.env.DB_USER = process.env.DB_USER || 'test-only';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test-only';

let nextId = 1;
let failOnDepartment = '';
let state = {
  activities: [
    { id: 'activity-1', name: '活动一', org_id: 'org-1' },
    { id: 'activity-other', name: '其他活动', org_id: 'org-2' }
  ],
  departments: [
    { id: 'department-1', name: '部门一', org_id: 'org-1' },
    { id: 'department-2', name: '部门二', org_id: 'org-1' }
  ],
  identities: [
    { id: 'identity-scorer', name: '评分身份', org_id: 'org-1' },
    { id: 'identity-target', name: '被评分身份', org_id: 'org-1' }
  ],
  templates: [{ id: 'template-1' }],
  rules: [],
  clauses: [],
  configs: [],
  records: []
};

function cloneState(source) {
  return JSON.parse(JSON.stringify(source));
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const connection = {
  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('SELECT id, name FROM score_activities')) {
      return [state.activities.filter((row) => row.id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id FROM score_activities')) {
      return [state.activities.filter((row) => row.id === params[0] && row.org_id === params[1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id, name FROM departments')) {
      return [state.departments.filter((row) => row.id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id, name FROM identities')) {
      return [state.identities.filter((row) => row.id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id FROM identities')) {
      return [state.identities.filter((row) => row.id === params[0] && row.org_id === params[1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id FROM score_question_templates')) {
      return [state.templates.filter((row) => row.id === params[0])];
    }
    if (normalized.startsWith('SELECT rule_row.*')) {
      return [state.rules
        .filter((row) => row.id === params[0] && row.org_id === params[1])
        .map((row) => Object.assign({}, row, {
          score_count: state.records.filter((record) => record.rule_id === row.id && record.org_id === row.org_id).length
        }))];
    }
    if (normalized.startsWith('SELECT id FROM rate_target_rules WHERE id')) {
      return [state.rules.filter((row) => row.id === params[0] && row.org_id === params[1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id FROM rate_target_rules WHERE activity_id')) {
      return [state.rules.filter((row) => row.activity_id === params[0]
        && row.scorer_key === params[1]
        && row.org_id === params[2]
        && (!params[4] || row.id !== params[4])).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id FROM rate_rule_clauses')) {
      return [state.clauses.filter((row) => row.rule_id === params[0] && row.org_id === params[1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT 1 FROM score_records')) {
      return [state.records.filter((row) => row.rule_id === params[0] && row.org_id === params[1]).map(() => ({ present: 1 }))];
    }
    if (normalized.startsWith('SELECT * FROM rate_target_rules WHERE activity_id')) {
      return [state.rules.filter((row) => row.activity_id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id, rule_id FROM score_records')) {
      const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
      return [state.records.filter((row) => ids.includes(row.rule_id) && row.org_id === params[1])];
    }
    if (normalized.startsWith('INSERT INTO rate_target_rules')) {
      if (params[2] === failOnDepartment) throw new Error('模拟第二条写入失败');
      const generated = normalized.includes('VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)');
      state.rules.push({
        id: params[0], activity_id: params[1], scorer_department_id: params[2],
        scorer_identity_id: params[3], scorer_key: params[4],
        allow_self_assessment: generated ? 1 : params[5],
        org_id: generated ? params[5] : params[6]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('UPDATE rate_target_rules')) {
      if (params[1] === failOnDepartment) throw new Error('模拟第二条写入失败');
      const row = state.rules.find((item) => item.id === params[6] && item.org_id === params[7]);
      if (row) {
        row.activity_id = params[0];
        row.scorer_department_id = params[1];
        row.scorer_identity_id = params[2];
        row.scorer_key = params[3];
        row.allow_self_assessment = params[4];
      }
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (normalized.startsWith('DELETE FROM clause_template_configs')) {
      const clauseIds = Array.isArray(params[0]) ? params[0] : [params[0]];
      state.configs = state.configs.filter((row) => !clauseIds.includes(row.clause_id) || row.org_id !== params[1]);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('DELETE FROM rate_rule_clauses')) {
      state.clauses = state.clauses.filter((row) => row.rule_id !== params[0] || row.org_id !== params[1]);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('DELETE FROM rate_target_rules')) {
      state.rules = state.rules.filter((row) => row.id !== params[0] || row.org_id !== params[1]);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('INSERT INTO rate_rule_clauses')) {
      state.clauses.push({ id: params[0], rule_id: params[1], scope_type: params[2], org_id: params[5] });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('INSERT INTO clause_template_configs')) {
      state.configs.push({ id: params[0], clause_id: params[1], template_id: params[3], org_id: params[8] });
      return [{ affectedRows: 1 }];
    }
    throw new Error('未处理 SQL：' + normalized);
  }
};

const database = {
  async withTransaction(callback) {
    const before = cloneState(state);
    try {
      return await callback(connection);
    } catch (error) {
      state = before;
      throw error;
    }
  },
  async query() {
    throw new Error('批量规则不得绕过事务连接');
  }
};

const mocks = {
  '../../../utils/helpers': Object.assign({}, actualHelpers, {
    generateId() { return 'generated-' + nextId++; }
  }),
  '../../../utils/dateTime': { nowMysqlUtc() { return '2026-08-30 00:00:00'; } },
  '../../../core/models/adminInfo': { async getByOpenid() { return { id: 'admin-1' }; } },
  '../models/rateRule': {},
  '../models/rateRuleClause': {},
  '../models/clauseTemplateConfig': {},
  '../../../core/models/department': { async getAll() { return state.departments.filter((row) => row.org_id === 'org-1'); } },
  '../../../core/models/identity': { async getAll() { return state.identities.filter((row) => row.org_id === 'org-1'); } },
  '../models/scoreActivity': { async getById(id) { return state.activities.find((row) => row.id === id && row.org_id === 'org-1') || null; } },
  '../models/scoreTemplate': {},
  '../models/scoreQuestion': {},
  '../services/participants': {
    async listParticipants() {
      return [{ department_id: 'department-1', identity_id: 'identity-scorer' }];
    }
  },
  '../../../config/db': database,
  '../../../utils/orgContext': { async getCurrentOrgId() { return 'org-1'; } },
  '../../../core/services/dictionaryUsage': {
    async assertDictionaryReferences(options) {
      assert.strictEqual(options.organizationId, 'org-1');
      assert.strictEqual(options.connection, connection);
      const departmentIds = options.departmentIds || [];
      const identityIds = (options.identityCategoryIds || []).filter(Boolean);
      if (departmentIds.some((id) => !state.departments.some((row) => row.id === id && row.org_id === 'org-1'))) {
        const error = new Error('invalid_department_reference');
        error.code = 'invalid_department_reference';
        throw error;
      }
      if (identityIds.some((id) => !state.identities.some((row) => row.id === id && row.org_id === 'org-1'))) {
        const error = new Error('invalid_identity_reference');
        error.code = 'invalid_identity_reference';
        throw error;
      }
    }
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const router = require(path.resolve(__dirname, '../src/modules/scoring/routes/rules.js'));
Module._load = originalLoad;

function routeHandler(routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, '缺少路由：' + routePath);
  return layer.route.stack[0].handle;
}

async function invoke(routePath, body) {
  let payload;
  await routeHandler(routePath)({ admin: { id: 'admin-1' }, body }, {
    json(value) { payload = value; return value; }
  });
  return payload;
}

function rateRule(departmentId, overrides = {}) {
  return Object.assign({
    activityId: 'activity-1',
    scorerDepartmentId: departmentId,
    scorerIdentityId: 'identity-scorer',
    allowSelfAssessment: true,
    mode: 'replace',
    clauses: [{
      scopeType: 'identity_only',
      targetIdentityId: 'identity-target',
      templateConfigs: [{ templateId: 'template-1', weight: 1, sortOrder: 1 }]
    }]
  }, overrides);
}

(async function run() {
  let result = await invoke('/batchSaveRateRules', { rules: [] });
  assert.strictEqual(result.status, 'invalid_params');

  result = await invoke('/batchSaveRateRules', { rules: Array.from({ length: 201 }, () => rateRule('department-1')) });
  assert.strictEqual(result.status, 'batch_limit_exceeded');
  assert.match(result.message, /200/);

  result = await invoke('/batchSaveRateRules', {
    rules: [rateRule('department-1'), rateRule('department-1')]
  });
  assert.strictEqual(result.status, 'duplicate_batch_item');
  assert.strictEqual(state.rules.length, 0);

  result = await invoke('/batchSaveRateRules', { rules: [rateRule('department-1', { activityId: 'activity-other' })] });
  assert.strictEqual(result.status, 'invalid_params');
  assert.strictEqual(state.rules.length, 0, '跨组织活动不得产生规则');

  result = await invoke('/saveRateRule', rateRule('department-1', {
    clauses: [{
      scopeType: 'identity_only',
      targetIdentityId: 'identity-target',
      templateConfigs: [{
        templateId: 'template-1', weight: 1, sortOrder: 1,
        calculationMethod: 'unknown_method', trimHighCount: 0, trimLowCount: 0
      }]
    }]
  }));
  assert.strictEqual(result.status, 'invalid_params');
  assert.strictEqual(state.rules.length, 0, '非法计算方式不得进入评分规则');

  failOnDepartment = 'department-2';
  result = await invoke('/batchSaveRateRules', { rules: [rateRule('department-1'), rateRule('department-2')] });
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(state.rules.length, 0, '第二条写入失败后第一条必须回滚');
  assert.match(result.message, /未保存任何更改/);

  failOnDepartment = '';
  const request = { rules: [rateRule('department-1'), rateRule('department-2')] };
  const first = await invoke('/batchSaveRateRules', request);
  assert.strictEqual(first.status, 'success');
  assert.strictEqual(first.count, 2);
  assert.strictEqual(first.ids.length, 2);
  assert.strictEqual(state.rules.length, 2);

  const second = await invoke('/batchSaveRateRules', request);
  assert.strictEqual(second.status, 'success');
  assert.deepStrictEqual(second.ids, first.ids, 'replace 模式重复请求应复用原规则 ID');
  assert.strictEqual(state.rules.length, 2, '幂等重试不得新增重复规则');

  const single = await invoke('/saveRateRule', rateRule('department-1', {
    id: first.ids[0],
    allowSelfAssessment: false
  }));
  assert.strictEqual(single.status, 'success');
  assert.strictEqual(single.rule.allowSelfAssessment, false);
  assert.strictEqual(single.rule.scorerDepartmentId, 'department-1');
  assert.strictEqual(single.rule.scorerIdentityId, 'identity-scorer');
  assert(Array.isArray(single.rule.clauses));

  state.records.push({ id: 'record-1', rule_id: first.ids[0], org_id: 'org-1' });
  const locked = await invoke('/saveRateRule', rateRule('department-2', {
    id: first.ids[0]
  }));
  assert.strictEqual(locked.status, 'rule_identity_locked');

  const blockedDelete = await invoke('/deleteRateRule', { id: first.ids[0] });
  assert.strictEqual(blockedDelete.status, 'conflict');
  assert(state.rules.some((row) => row.id === first.ids[0]), '有评分记录的规则不得删除');

  state.records = [];
  const deleted = await invoke('/deleteRateRule', { id: first.ids[0] });
  assert.strictEqual(deleted.status, 'success');
  assert(!state.rules.some((row) => row.id === first.ids[0]));

  state.rules = [
    { id: 'duplicate-a', activity_id: 'activity-1', scorer_department_id: 'department-1', scorer_identity_id: 'identity-scorer', scorer_key: 'department-1::identity-scorer', org_id: 'org-1' },
    { id: 'duplicate-b', activity_id: 'activity-1', scorer_department_id: 'department-1', scorer_identity_id: 'identity-scorer', scorer_key: 'department-1::identity-scorer', org_id: 'org-1' }
  ];
  state.clauses = [];
  state.configs = [];
  state.records = [
    { id: 'record-a', rule_id: 'duplicate-a', org_id: 'org-1' },
    { id: 'record-b', rule_id: 'duplicate-b', org_id: 'org-1' }
  ];
  const duplicateConflict = await invoke('/generateRateTargetRules', { activityId: 'activity-1' });
  assert.strictEqual(duplicateConflict.status, 'duplicate_rules_have_records');
  assert.strictEqual(state.rules.length, 2, '两条重复规则均有历史评分时不得猜测保留哪一条');

  state.records = [{ id: 'record-a', rule_id: 'duplicate-a', org_id: 'org-1' }];
  const duplicateRepaired = await invoke('/generateRateTargetRules', { activityId: 'activity-1' });
  assert.strictEqual(duplicateRepaired.status, 'success');
  assert.deepStrictEqual(state.rules.map((row) => row.id), ['duplicate-a'], '必须保留已有历史评分的规则并删除无引用重复项');

  console.log('评分规则批量保存原子性、组织隔离、上限、重复项与幂等测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
