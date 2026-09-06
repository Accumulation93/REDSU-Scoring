'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const actualHelpers = require('../src/utils/helpers');

process.env.DB_USER = process.env.DB_USER || 'test-only';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test-only';

let nextId = 1;
let failViewDepartment = '';
let failMeritDepartment = '';
let failDeleteViewId = '';
let failDeleteMeritId = '';
let state = {
  publications: [
    { id: 'publication-1', org_id: 'org-1' },
    { id: 'publication-other', org_id: 'org-2' }
  ],
  departments: [
    { id: 'department-1', org_id: 'org-1' },
    { id: 'department-2', org_id: 'org-1' }
  ],
  identities: [
    { id: 'identity-grantee', org_id: 'org-1' },
    { id: 'identity-target', org_id: 'org-1' }
  ],
  viewRules: [],
  viewClauses: [],
  gradeBands: [],
  meritRules: [],
  meritClauses: [],
  designations: []
};

function cloneState(source) {
  return JSON.parse(JSON.stringify(source));
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function matchingRule(rows, params) {
  return rows.filter((row) => row.publication_id === params[0]
    && row.grantee_department_id === params[1]
    && row.grantee_identity_id === params[2]
    && row.org_id === params[3]);
}

const connection = {
  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('SELECT id FROM result_publications')) {
      return [state.publications.filter((row) => row.id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id, publication_id, grantee_department_id, grantee_identity_id FROM pub_view_rules WHERE id =')) {
      return [state.viewRules.filter((row) => row.id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id FROM pub_view_rules WHERE id =')) {
      return [state.viewRules.filter((row) => row.id === params[0]
        && (!normalized.includes('publication_id = ?') || row.publication_id === params[1])
        && row.org_id === params[normalized.includes('publication_id = ?') ? 2 : 1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id FROM pub_view_rules WHERE publication_id')) {
      return [matchingRule(state.viewRules, params).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id FROM pub_view_rule_clauses')) {
      return [state.viewClauses.filter((row) => row.rule_id === params[0] && row.org_id === params[1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('INSERT INTO pub_view_rules')) {
      if (params[2] === failViewDepartment) throw new Error('模拟查看规则第二条写入失败');
      state.viewRules.push({
        id: params[0], publication_id: params[1], grantee_department_id: params[2],
        grantee_identity_id: params[3], org_id: params[4]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('UPDATE pub_view_rules SET grantee_department_id')) {
      if (params[0] === failViewDepartment) throw new Error('模拟查看规则第二条写入失败');
      const row = state.viewRules.find((item) => item.id === params[3] && item.publication_id === params[4] && item.org_id === params[5]);
      if (row) {
        row.grantee_department_id = params[0];
        row.grantee_identity_id = params[1];
      }
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (normalized.startsWith('UPDATE pub_view_rules SET updated_at')) return [{ affectedRows: 1 }];
    if (normalized.startsWith('DELETE FROM pub_view_rule_clauses')) {
      state.viewClauses = state.viewClauses.filter((row) => row.rule_id !== params[0] || row.org_id !== params[1]);
      state.gradeBands = state.gradeBands.filter((band) => state.viewClauses.some((clause) => clause.id === band.clause_id));
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('INSERT INTO pub_view_rule_clauses')) {
      state.viewClauses.push({
        id: params[0], rule_id: params[1], scope_type: params[2],
        target_identity_id: params[3], display_mode: params[4], org_id: params[6]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('INSERT INTO pub_grade_bands')) {
      state.gradeBands.push({ id: params[0], clause_id: params[1], org_id: params[6] });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('DELETE FROM pub_view_rules')) {
      if (params[0] === failDeleteViewId) throw new Error('模拟查看规则第二条删除失败');
      state.viewRules = state.viewRules.filter((row) => row.id !== params[0] || row.org_id !== params[1]);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('SELECT id FROM pub_merit_rules WHERE id =')) {
      return [state.meritRules.filter((row) => row.id === params[0]
        && (!normalized.includes('publication_id = ?') || row.publication_id === params[1])
        && row.org_id === params[normalized.includes('publication_id = ?') ? 2 : 1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('SELECT id FROM pub_merit_rules WHERE publication_id')) {
      return [matchingRule(state.meritRules, params).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('INSERT INTO pub_merit_rules')) {
      if (params[2] === failMeritDepartment) throw new Error('模拟评优规则第二条写入失败');
      state.meritRules.push({
        id: params[0], publication_id: params[1], grantee_department_id: params[2],
        grantee_identity_id: params[3], org_id: params[4]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('UPDATE pub_merit_rules SET grantee_department_id')) {
      if (params[0] === failMeritDepartment) throw new Error('模拟评优规则第二条写入失败');
      const row = state.meritRules.find((item) => item.id === params[3] && item.publication_id === params[4] && item.org_id === params[5]);
      if (row) {
        row.grantee_department_id = params[0];
        row.grantee_identity_id = params[1];
      }
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (normalized.startsWith('UPDATE pub_merit_rules SET updated_at')) return [{ affectedRows: 1 }];
    if (normalized.startsWith('SELECT id, scope_type, target_identity_id FROM pub_merit_rule_clauses')) {
      return [state.meritClauses.filter((row) => row.rule_id === params[0] && row.org_id === params[1])];
    }
    if (normalized.startsWith('SELECT id FROM pub_merit_rule_clauses')) {
      return [state.meritClauses.filter((row) => row.rule_id === params[0] && row.org_id === params[1]).map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('INSERT INTO pub_merit_rule_clauses')) {
      state.meritClauses.push({
        id: params[0], rule_id: params[1], scope_type: params[2],
        target_identity_id: params[3], quota_limit: params[4], org_id: params[7]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('UPDATE pub_merit_rule_clauses')) {
      const row = state.meritClauses.find((item) => item.id === params[5] && item.rule_id === params[6] && item.org_id === params[7]);
      if (row) row.quota_limit = params[0];
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (normalized.startsWith('SELECT id FROM merit_list_designations')) {
      const orgId = params[params.length - 1];
      const clauseIds = params.slice(0, -1);
      return [state.designations
        .filter((row) => clauseIds.includes(row.clause_id) && row.org_id === orgId)
        .slice(0, 1)
        .map((row) => ({ id: row.id }))];
    }
    if (normalized.startsWith('DELETE FROM pub_merit_rule_clauses WHERE id')) {
      state.meritClauses = state.meritClauses.filter((row) => row.id !== params[0] || row.rule_id !== params[1] || row.org_id !== params[2]);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('DELETE FROM pub_merit_rule_clauses WHERE rule_id')) {
      state.meritClauses = state.meritClauses.filter((row) => row.rule_id !== params[0] || row.org_id !== params[1]);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('DELETE FROM pub_merit_rules')) {
      if (params[0] === failDeleteMeritId) throw new Error('模拟评优规则第二条删除失败');
      state.meritRules = state.meritRules.filter((row) => row.id !== params[0] || row.org_id !== params[1]);
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
    throw new Error('批量公示规则不得绕过事务连接');
  }
};

const emptyDependency = new Proxy({}, { get() { return async () => null; } });
const mocks = {
  '../../../utils/helpers': Object.assign({}, actualHelpers, {
    generateId() { return 'publication-generated-' + nextId++; }
  }),
  '../../../utils/dateTime': { nowMysqlUtc() { return '2026-08-30 00:00:00'; } },
  '../../../utils/logger': { logger: { debug() {}, error() {}, warn() {}, info() {} } },
  '../../../core/models/adminInfo': { async getByOpenid() { return { id: 'admin-1' }; } },
  '../../audit/models/notificationOutbox': emptyDependency,
  '../models/resultPublication': emptyDependency,
  '../models/meritListDesignation': emptyDependency,
  '../models/pubGradeBand': emptyDependency,
  '../../../core/models/department': emptyDependency,
  '../../../core/models/identity': emptyDependency,
  '../../../core/models/workGroup': emptyDependency,
  '../models/scoreActivity': emptyDependency,
  '../../../utils/excelFile': { buildWorkbookBuffer() { return Buffer.alloc(0); } },
  '../../../config/db': database,
  '../../../utils/orgContext': { async getCurrentOrgId() { return 'org-1'; } },
  '../utils/pubCache': emptyDependency,
  '../../../core/services/currentActor': { async resolveCurrentActor() { return { ok: false }; } },
  '../services/participants': emptyDependency,
  '../services/publicationAssignments': emptyDependency,
  '../../../core/services/dictionaryUsage': {
    async assertDictionaryReferences(options) {
      assert.strictEqual(options.organizationId, 'org-1');
      assert.strictEqual(options.connection, connection);
      if ((options.departmentIds || []).some((id) => !state.departments.some((row) => row.id === id && row.org_id === 'org-1'))) {
        const error = new Error('invalid_department_reference');
        error.code = 'invalid_department_reference';
        throw error;
      }
      if ((options.identityCategoryIds || []).filter(Boolean).some((id) => !state.identities.some((row) => row.id === id && row.org_id === 'org-1'))) {
        const error = new Error('invalid_identity_reference');
        error.code = 'invalid_identity_reference';
        throw error;
      }
    }
  },
  '../../../core/models/unifiedIdentity': emptyDependency
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const router = require(path.resolve(__dirname, '../src/modules/scoring/routes/publications.js'));
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

function viewRule(departmentId, overrides = {}) {
  return Object.assign({
    publicationId: 'publication-1',
    granteeDepartmentId: departmentId,
    granteeIdentityId: 'identity-grantee',
    clauses: [{
      scopeType: 'same_department_identity',
      targetIdentityId: 'identity-target',
      displayMode: 'score',
      gradeBands: []
    }]
  }, overrides);
}

function meritRule(departmentId, overrides = {}) {
  return Object.assign({
    publicationId: 'publication-1',
    granteeDepartmentId: departmentId,
    granteeIdentityId: 'identity-grantee',
    clauses: [{
      scopeType: 'same_department_identity',
      targetIdentityId: 'identity-target',
      quotaLimit: 2,
      requireExactQuota: false
    }]
  }, overrides);
}

(async function run() {
  let result = await invoke('/batchSavePubViewRules', { rules: [] });
  assert.strictEqual(result.status, 'invalid_params');
  result = await invoke('/batchSavePubViewRules', { rules: Array.from({ length: 201 }, () => viewRule('department-1')) });
  assert.strictEqual(result.status, 'batch_limit_exceeded');

  result = await invoke('/batchSavePubViewRules', { rules: [viewRule('department-1'), viewRule('department-1')] });
  assert.strictEqual(result.status, 'duplicate_batch_item');
  assert.strictEqual(state.viewRules.length, 0);

  result = await invoke('/batchSavePubViewRules', { rules: [viewRule('department-1', { publicationId: 'publication-other' })] });
  assert.strictEqual(result.status, 'invalid_params');
  assert.strictEqual(state.viewRules.length, 0, '跨组织公示不得产生查看规则');

  failViewDepartment = 'department-2';
  result = await invoke('/batchSavePubViewRules', { rules: [viewRule('department-1'), viewRule('department-2')] });
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(state.viewRules.length, 0, '查看规则第二条失败后必须整体回滚');
  failViewDepartment = '';

  const viewRequest = { rules: [viewRule('department-1'), viewRule('department-2')] };
  const firstView = await invoke('/batchSavePubViewRules', viewRequest);
  assert.strictEqual(firstView.status, 'success');
  assert.strictEqual(firstView.count, 2);
  const secondView = await invoke('/batchSavePubViewRules', viewRequest);
  assert.deepStrictEqual(secondView.ids, firstView.ids, '查看规则重复请求应复用原 ID');
  assert.strictEqual(state.viewRules.length, 2);

  failMeritDepartment = 'department-2';
  result = await invoke('/batchSavePubMeritRules', { rules: [meritRule('department-1'), meritRule('department-2')] });
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(state.meritRules.length, 0, '评优规则第二条失败后必须整体回滚');
  failMeritDepartment = '';

  const meritRequest = { rules: [meritRule('department-1'), meritRule('department-2')] };
  const firstMerit = await invoke('/batchSavePubMeritRules', meritRequest);
  assert.strictEqual(firstMerit.status, 'success');
  assert.strictEqual(firstMerit.count, 2);
  const secondMerit = await invoke('/batchSavePubMeritRules', meritRequest);
  assert.deepStrictEqual(secondMerit.ids, firstMerit.ids, '评优规则重复请求应复用原 ID');
  assert.strictEqual(state.meritRules.length, 2);

  state.meritRules.push({
    id: 'merit-rule-other-org', publication_id: 'publication-other',
    grantee_department_id: 'department-1', grantee_identity_id: 'identity-grantee', org_id: 'org-2'
  });
  result = await invoke('/batchDeletePubMeritRules', { ruleIds: [firstMerit.ids[0], 'missing-merit-rule'] });
  assert.strictEqual(result.status, 'rule_not_found');
  assert(state.meritRules.some((row) => row.id === firstMerit.ids[0]), '缺失 ID 必须回滚已删除的评优规则');
  result = await invoke('/batchDeletePubMeritRules', { ruleIds: [firstMerit.ids[0], 'merit-rule-other-org'] });
  assert.strictEqual(result.status, 'rule_not_found');
  assert(state.meritRules.some((row) => row.id === firstMerit.ids[0]), '跨组织 ID 必须回滚已删除的评优规则');

  failDeleteMeritId = firstMerit.ids[1];
  result = await invoke('/batchDeletePubMeritRules', { ruleIds: firstMerit.ids });
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(state.meritRules.filter((row) => row.org_id === 'org-1').length, 2, '评优规则第二条删除失败后必须恢复第一条');
  failDeleteMeritId = '';

  const protectedRuleId = firstMerit.ids[0];
  const protectedClause = state.meritClauses.find((row) => row.rule_id === protectedRuleId);
  state.designations.push({ id: 'designation-protected', clause_id: protectedClause.id, org_id: 'org-1' });
  result = await invoke('/batchDeletePubMeritRules', { ruleIds: [protectedRuleId] });
  assert.strictEqual(result.status, 'rule_has_designations');
  assert(state.meritRules.some((row) => row.id === protectedRuleId), '已有评优名单时必须保留规则');
  assert(state.meritClauses.some((row) => row.id === protectedClause.id), '已有评优名单时必须保留规则条款');
  assert(state.designations.some((row) => row.id === 'designation-protected'), '规则操作不得删除历史评优名单');
  state.designations = [];

  result = await invoke('/batchDeletePubMeritRules', { ruleIds: [firstMerit.ids[0], firstMerit.ids[0]] });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.count, 1, '重复删除 ID 只处理一次');
  result = await invoke('/batchDeletePubMeritRules', { ruleIds: [firstMerit.ids[0]] });
  assert.strictEqual(result.status, 'rule_not_found', '严格批量删除重试应明确返回规则已不存在');

  state.viewRules.push({
    id: 'view-rule-other-org', publication_id: 'publication-other',
    grantee_department_id: 'department-1', grantee_identity_id: 'identity-grantee', org_id: 'org-2'
  });
  result = await invoke('/batchDeletePubViewRules', { ruleIds: [firstView.ids[0], 'missing-view-rule'] });
  assert.strictEqual(result.status, 'rule_not_found');
  assert(state.viewRules.some((row) => row.id === firstView.ids[0]), '缺失 ID 必须回滚已删除的查看规则');
  result = await invoke('/batchDeletePubViewRules', { ruleIds: [firstView.ids[0], 'view-rule-other-org'] });
  assert.strictEqual(result.status, 'rule_not_found');
  assert(state.viewRules.some((row) => row.id === firstView.ids[0]), '跨组织 ID 必须回滚已删除的查看规则');

  result = await invoke('/batchDeletePubViewRules', { ruleIds: [firstView.ids[1]] });
  assert.strictEqual(result.status, 'rule_in_use', '评优规则仍依赖授权类别时不得删除查看规则');
  assert(state.viewRules.some((row) => row.id === firstView.ids[1]), '依赖检查失败后必须保留查看规则');
  result = await invoke('/batchDeletePubMeritRules', { ruleIds: [firstMerit.ids[1]] });
  assert.strictEqual(result.status, 'success');

  failDeleteViewId = firstView.ids[1];
  result = await invoke('/batchDeletePubViewRules', { ruleIds: firstView.ids });
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(state.viewRules.filter((row) => row.org_id === 'org-1').length, 2, '查看规则第二条删除失败后必须恢复第一条');
  failDeleteViewId = '';

  result = await invoke('/batchDeletePubViewRules', { ruleIds: [firstView.ids[0], firstView.ids[0]] });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.count, 1);
  result = await invoke('/batchDeletePubViewRules', { ruleIds: [firstView.ids[0]] });
  assert.strictEqual(result.status, 'rule_not_found');

  console.log('公示规则批量保存删除原子性、组织隔离、上限、重复项与幂等测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
