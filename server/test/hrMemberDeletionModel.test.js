const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hr-member-deletion-model-test-secret';
process.env.AUTH_IDENTITY_SECRET = process.env.AUTH_IDENTITY_SECRET || 'hr-member-deletion-model-identity-secret';
const model = require('../src/core/models/hrMemberDeletion');
const { encryptOpenid } = require('../src/core/services/identityCrypto');

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

async function testVenueScopeAndLegacyAdminBlockers() {
  const calls = [];
  const blockers = await model.scanBusinessBlockers({
    async query(sql, params) {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, params });
      if (normalized.includes('FROM venue_bookings')) return [[{ id: 'venue-legacy-admin' }]];
      if (normalized.includes('FROM hr_profile_records')
        && normalized.includes("audit_status IN ('approved', 'rejected')")) {
        return [[{ id: 'reviewed-profile' }]];
      }
      return [[]];
    }
  }, {
    personId: 'person-target',
    organizationId: 'org-a',
    legacyHrIds: ['hr-target'],
    assignmentIds: ['assignment-target'],
    adminGrantIds: ['grant-target'],
    legacyAdminIds: ['admin-target']
  }, true);

  const venueCall = calls.find((item) => item.sql.includes('FROM venue_bookings'));
  assert(venueCall.sql.includes('creator_org_id = ?'));
  assert(venueCall.sql.includes('approval_org_id = ?'));
  assert(venueCall.sql.includes('creator_admin_grant_id IN (?)'));
  assert(venueCall.sql.includes('creator_admin_id IN (?)'));
  assert(venueCall.params.includes('grant-target'));
  assert(venueCall.params.includes('admin-target'));
  assert(blockers.some((item) => item.category === 'venue_bookings' && item.count === 1));
  assert(blockers.some((item) => item.category === 'reviewed_profile_records' && item.count === 1));
  blockers.forEach((item) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(item, 'sampleIds'), false);
  });
}

async function testDistinctEffectiveSuperAdmins() {
  const calls = [];
  const result = await model.lockSuperAdminState({
    async query(sql) {
      const normalized = normalizeSql(sql);
      calls.push(normalized);
      if (calls.length === 1) return [[{ id: 'target-grant' }]];
      return [[
        { person_id: 'person-target' },
        { person_id: 'person-target' },
        { person_id: 'person-other' }
      ]];
    }
  }, 'person-target', true);
  assert.deepStrictEqual(result, { targetIsSuperAdmin: true, activeCount: 2 });
  assert(calls[1].includes('SELECT grant_row.person_id'));
  assert(calls.every((sql) => sql.includes("login_credential.method = 'passphrase'")));
  assert(calls.every((sql) => sql.includes('OR EXISTS') && sql.includes('login_policy.allow_passphrase = 1')));
}

async function testGlobalSuperAdminGovernanceLock() {
  const calls = [];
  const result = await model.acquireSuperAdminGovernanceLock({
    async query(sql, params) {
      calls.push({ sql: normalizeSql(sql), params });
      return [[{ acquired: 1 }]];
    }
  }, 10);
  assert.deepStrictEqual(result, { key: 'hr-delete:super-admin-governance', acquired: true });
  assert(calls[0].sql.includes('GET_LOCK'));
  assert.strictEqual(calls[0].params[0], 'hr-delete:super-admin-governance');
}

async function testPersonDeletionLockFitsMysqlLimit() {
  const calls = [];
  const longPersonId = 'a'.repeat(64);
  const result = await model.acquireDeletionLock({
    async query(sql, params) {
      calls.push({ sql: normalizeSql(sql), params });
      return [[{ acquired: 1 }]];
    }
  }, longPersonId, 10);
  assert.strictEqual(result.acquired, true);
  assert.strictEqual(result.key.length, 64);
  assert.strictEqual(calls[0].params[0], result.key);
  assert(!result.key.includes(longPersonId), '锁名不得直接拼接完整人员 ID');
}

async function testAbsoluteTimeReviewCleanupIsExactAndBackwardCompatible() {
  const calls = [];
  const removed = await model.deleteAbsoluteTimeReviewsForRows({
    async query(sql, params) {
      calls.push({ sql: normalizeSql(sql), params });
      return [{ affectedRows: 2 }];
    }
  }, 'signature_templates', ['signature-a', 'signature-b']);
  assert.strictEqual(removed, 2);
  assert(calls[0].sql.includes('table_name = ?'));
  assert(calls[0].sql.includes('primary_record_id IN (?, ?)'));
  assert.deepStrictEqual(calls[0].params, ['signature_templates', 'signature-a', 'signature-b']);

  const skipped = await model.deleteAbsoluteTimeReviewsForRows({
    async query() {
      const error = new Error('missing table');
      error.code = 'ER_NO_SUCH_TABLE';
      throw error;
    }
  }, 'hr_info', ['hr-a']);
  assert.strictEqual(skipped, 0);

  await assert.rejects(
    model.deleteAbsoluteTimeReviewsForRows({
      async query() {
        const error = new Error('permission denied');
        error.code = 'ER_TABLEACCESS_DENIED_ERROR';
        throw error;
      }
    }, 'hr_info', ['hr-a']),
    (error) => error.code === 'ER_TABLEACCESS_DENIED_ERROR'
  );

  const scopedCalls = [];
  const scopedRemoved = await model.cleanupMembershipAbsoluteTimeReviews({
    async query(sql, params) {
      const normalized = normalizeSql(sql);
      scopedCalls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT id FROM signature_templates')) {
        assert.strictEqual(params[0], 'org-a');
        return [[{ id: 'signature-org-a' }]];
      }
      if (normalized.startsWith('DELETE FROM absolute_time_record_reviews')) {
        return [{ affectedRows: params.includes('signature-org-a') ? 1 : 0 }];
      }
      if (normalized.startsWith('SELECT')) return [[]];
      return [{ affectedRows: 0 }];
    }
  }, {
    personId: 'person-target', organizationId: 'org-a', legacyHrIds: ['hr-a']
  });
  assert.strictEqual(scopedRemoved, 1);
  const scopedDelete = scopedCalls.find((item) => (
    item.sql.startsWith('DELETE FROM absolute_time_record_reviews')
    && item.params[0] === 'signature_templates'
  ));
  assert.deepStrictEqual(scopedDelete.params, ['signature_templates', 'signature-org-a']);
  assert(!JSON.stringify(scopedCalls).includes('signature-org-b'));
}

async function testCompleteCleanupImpactContract() {
  const impact = await model.scanCleanupImpact({
    async query() { return [[{ count: 1 }]]; }
  }, {
    personId: 'person-target',
    organizationId: 'org-a',
    organizationIds: ['org-a'],
    legacyHrIds: ['hr-target'],
    assignmentIds: ['assignment-target'],
    adminGrantIds: ['grant-target'],
    legacyAdminIds: ['admin-target']
  });
  const categories = new Set(impact.map((item) => item.category));
  [
    'legacy_hr_records',
    'profile_records',
    'profile_values',
    'audit_verification_permissions',
    'notification_outbox',
    'legacy_user_bindings',
    'global_profile_values',
    'global_profile_history',
    'admin_grants',
    'admin_permission_overrides',
    'identity_invites_for_member',
    'active_identity_invites_issued',
    'active_identity_tokens_issued',
    'identity_tokens_for_member_claims',
    'identity_claims',
    'account_recovery_requests',
    'account_recovery_approvals',
    'auth_sessions',
    'assignments',
    'memberships',
    'scoring_caches'
  ].forEach((category) => assert(categories.has(category), `预检缺少统计：${category}`));
}

function cleanupConnection(calls, options) {
  const config = options || {};
  return {
    async query(sql, params) {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT condition_row.id')) return [[]];
      if (normalized.startsWith('SELECT id, template_id, approver_type')) return [[]];
      if (normalized.startsWith('SELECT id, starter_type')) return [[]];
      if (normalized.startsWith('SELECT id, rule_type')) return [[]];
      if (normalized.startsWith('SELECT id FROM hr_profile_records')) return [[]];
      if (normalized.startsWith('SELECT * FROM person_profile_values')) return [[]];
      if (normalized.startsWith('SELECT * FROM person_profile_value_history')) return [[]];
      if (normalized.startsWith('SELECT id, legacy_admin_id FROM admin_grants')) {
        return config.membershipAdminRows || [[]];
      }
      if (normalized.startsWith('SELECT legacy_admin_id FROM admin_grants')) return [[]];
      if (normalized.startsWith('SELECT openid_hash FROM account_wechat_bindings')) return [[]];
      if (normalized.startsWith('SELECT COUNT(*) AS count')) return [[{ count: 2 }]];
      if (normalized.startsWith('SELECT')) return [[]];
      return [{ affectedRows: 1 }];
    }
  };
}

async function testMembershipCleanupRevokesCredentialsPreservesAuditAndInvalidatesCache() {
  const calls = [];
  const result = await model.cleanupMembershipArtifacts(cleanupConnection(calls, {
    membershipAdminRows: [[{ id: 'grant-target', legacy_admin_id: 'admin-target' }]]
  }), {
    personId: 'person-target',
    organizationId: 'org-a',
    legacyHrIds: ['hr-target'],
    assignmentIds: ['assignment-target']
  });
  assert(calls.some((item) => item.sql.startsWith('UPDATE identity_verification_tokens token_row')));
  assert(calls.some((item) => item.sql.startsWith('UPDATE identity_verification_invites')));
  assert(calls.some((item) => item.sql.startsWith('UPDATE account_recovery_requests')));
  assert(calls.some((item) => item.sql.startsWith('DELETE FROM _shared_cache')));
  assert(!calls.some((item) => item.sql.startsWith('DELETE FROM admin_permission_audit_logs')));
  assert.strictEqual(result.cleanupCounts.adminPermissionAuditPreserved, 2);
}

async function testPersonCleanupRedactsAdminAudit() {
  const calls = [];
  await model.cleanupGlobalPersonArtifacts(cleanupConnection(calls), {
    personId: 'person-target',
    accountId: '',
    organizationIds: [],
    legacyAdminIds: ['admin-target'],
    legacyHrIds: ['hr-target'],
    assignmentIds: ['assignment-target'],
    legacyOpenids: ['openid-target']
  }, 'a'.repeat(64));
  const redaction = calls.find((item) => item.sql.startsWith('UPDATE admin_permission_audit_logs'));
  assert(redaction);
  assert(calls.some((item) => item.sql.startsWith('UPDATE admin_permission_overrides')));
  assert(redaction.sql.includes("JSON_OBJECT('redacted', TRUE, 'deletionDigest', ?)"));
  assert(!calls.some((item) => item.sql.startsWith('DELETE FROM admin_permission_audit_logs')));
  const meritRedaction = calls.find((item) => item.sql.startsWith('UPDATE merit_list_designations'));
  const migrationRedaction = calls.find((item) => item.sql.startsWith('UPDATE personnel_migration_audit'));
  assert(meritRedaction);
  assert(migrationRedaction);
  assert(meritRedaction.params.includes('openid-target'));
  assert(migrationRedaction.sql.includes("JSON_OBJECT('redacted', TRUE, 'deletionDigest', ?)"));
}

async function testLegacyOpenidIsResolvedOnlyForInternalBlockerMatching() {
  const encrypted = encryptOpenid('openid-encrypted');
  const openids = await model.listPersonOpenidReferences({
    async query() {
      return [[
        { openid_ciphertext: encrypted, legacy_openid: null },
        { openid_ciphertext: null, legacy_openid: 'openid-legacy' }
      ]];
    }
  }, 'account-target', true);
  assert.deepStrictEqual(openids.sort(), ['openid-encrypted', 'openid-legacy']);

  const calls = [];
  const blocker = await model.scanScoringDesignationReferences({
    async query(sql, params) {
      calls.push({ sql: normalizeSql(sql), params });
      return [params.includes('openid-encrypted') ? [{ id: 'designation-old' }] : []];
    }
  }, {
    personId: 'person-target', organizationId: '', legacyHrIds: [], assignmentIds: [],
    legacyOpenids: openids
  }, true);
  assert.strictEqual(blocker.count, 1);
  assert(/designated_by IN \(\?,\s*\?\)/.test(calls[0].sql));
}

function inactiveFallbackCandidateConnection(calls, preview) {
  return {
    async query(sql, params) {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT condition_row.id')) return [[]];
      if (normalized.includes('FROM audit_flow_template_step_conditions')
        && normalized.startsWith('SELECT person_hr_ids')) return [[]];
      if (normalized.startsWith('SELECT id, template_id, approver_type')) {
        return [[{
          id: 'step-a', template_id: 'template-a', approver_type: 'person',
          approver_hr_id: 'hr-active-a,hr-former-b'
        }]];
      }
      if (normalized.startsWith('SELECT step_row.id')) {
        return [[{
          id: 'step-a', template_id: 'template-a', approver_type: 'person',
          approver_hr_id: 'hr-active-a,hr-former-b', template_name: '审核模板',
          step_name: '第一步', sort_order: 1
        }]];
      }
      if (normalized.startsWith('SELECT id, starter_type')
        || normalized.startsWith('SELECT id, name, starter_type')) return [[]];
      if (normalized.startsWith('SELECT id, rule_type')) {
        return [[{ id: 'venue-rule-a', rule_type: 'person', approver_hr_id: 'hr-active-a,hr-former-b' }]];
      }
      if (normalized.startsWith('SELECT rule_row.id')) {
        return [[{
          id: 'venue-rule-a', rule_type: 'person', approver_hr_id: 'hr-active-a,hr-former-b',
          sort_order: 1, venue_name: '测试场地'
        }]];
      }
      if (normalized.startsWith('SELECT membership_row.id')) return [[]];
      if (normalized.startsWith('UPDATE')) return [{ affectedRows: 1 }];
      throw new Error(`${preview ? '预检' : '执行'}测试遇到未处理 SQL：${normalized}`);
    }
  };
}

async function testInactiveFallbackCandidateDisablesRulesInPreviewAndExecution() {
  const target = {
    personId: 'person-a', organizationId: 'org-a',
    legacyHrIds: ['hr-active-a'], assignmentIds: ['assignment-a']
  };
  const previewCalls = [];
  const impact = await model.scanRuleImpact(
    inactiveFallbackCandidateConnection(previewCalls, true), target, false
  );
  assert(impact.some((item) => item.type === 'audit_template' && item.wouldDisable));
  assert(impact.some((item) => item.type === 'venue_rule' && item.wouldDisable));

  const executionCalls = [];
  const disabled = await model.cleanupRuleReferences(
    inactiveFallbackCandidateConnection(executionCalls, false), target
  );
  assert(disabled.some((item) => item.type === 'audit_template' && item.id === 'template-a'));
  assert(disabled.some((item) => item.type === 'venue_rule' && item.id === 'venue-rule-a'));
  const candidateQueries = executionCalls.filter((item) => item.sql.startsWith('SELECT membership_row.id'));
  assert(candidateQueries.length >= 2);
  candidateQueries.forEach((item) => {
    assert(item.sql.includes("membership_row.status = 'active'"));
    assert(item.sql.includes("assignment_row.status = 'active'"));
  });
}

(async () => {
  await testVenueScopeAndLegacyAdminBlockers();
  await testDistinctEffectiveSuperAdmins();
  await testGlobalSuperAdminGovernanceLock();
  await testPersonDeletionLockFitsMysqlLimit();
  await testAbsoluteTimeReviewCleanupIsExactAndBackwardCompatible();
  await testCompleteCleanupImpactContract();
  await testMembershipCleanupRevokesCredentialsPreservesAuditAndInvalidatesCache();
  await testPersonCleanupRedactsAdminAudit();
  await testLegacyOpenidIsResolvedOnlyForInternalBlockerMatching();
  await testInactiveFallbackCandidateDisablesRulesInPreviewAndExecution();
  console.log('永久删除模型 SQL 与契约测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
