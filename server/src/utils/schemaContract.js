const localeCopy = require('../locales/zh-CN/generated/utils/schemaContract');
const REQUIRED_COLUMNS = [
  ['admin_info', 'invite_code'],
  ['admin_info', 'invite_expires_at'],
  ['admin_info', 'invite_consumed_at'],
  ['venue_bookings', 'creator_org_id'],
  ['venue_bookings', 'approval_org_id'],
  ['notifications', 'org_id'],
  ['notifications', 'recipient_type'],
  ['notifications', 'recipient_id'],
  ['notifications', 'event_key'],
  ['venue_approval_flow_steps', 'approval_mode'],
  ['audit_read_cursors', 'org_id'],
  ['hr_profile_templates', 'name'],
  ['org_hr_profile_template_snapshots', 'created_at'],
  ['org_hr_profile_template_snapshots', 'updated_at'],
  ['org_hr_profile_template_snapshot_fields', 'is_active'],
  ['org_hr_profile_template_switches', 'snapshot_id'],
  ['hr_profile_records', 'template_snapshot_id'],
  ['hr_profile_record_values', 'updated_at'],
  ['auth_sessions', 'device_key_hash'],
  ['auth_sessions', 'device_platform'],
  ['auth_sessions', 'device_model'],
  ['auth_sessions', 'binding_mode'],
  ['auth_sessions', 'openid_ciphertext']
  ,['score_activities', 'participant_granularity']
  ,['score_question_templates', 'org_id']
  ,['score_records', 'scorer_person_id']
  ,['score_records', 'scorer_assignment_id']
  ,['score_records', 'scorer_subject_key']
  ,['score_records', 'target_person_id']
  ,['score_records', 'target_assignment_id']
  ,['score_records', 'target_subject_key']
  ,['score_records', 'calculation_context_snapshot']
  ,['score_records', 'revision_number']
  ,['score_records', 'updated_at']
  ,['audit_events', 'operator_person_id']
  ,['audit_events', 'operator_assignment_id']
  ,['audit_events', 'operator_admin_grant_id']
  ,['audit_events', 'operator_context_snapshot']
  ,['audit_submission_files', 'revision_round']
  ,['audit_submission_files', 'is_current']
  ,['audit_submission_files', 'signing_key_encryption_version']
  ,['audit_signing_evidence', 'identity_ciphertext']
  ,['audit_signing_evidence', 'cms_base64']
  ,['audit_signing_evidence', 'event_id']
  ,['audit_signing_evidence', 'output_digest_type']
  ,['audit_signing_certificates', 'certificate_fingerprint']
  ,['venue_bookings', 'creator_person_id']
  ,['venue_bookings', 'creator_assignment_id']
  ,['venue_bookings', 'creator_admin_grant_id']
  ,['venue_bookings', 'creator_context_snapshot']
  ,['venue_bookings', 'approver_person_id']
  ,['venue_bookings', 'approver_assignment_id']
  ,['venue_bookings', 'approver_admin_grant_id']
  ,['venue_bookings', 'approver_context_snapshot']
  ,['venue_bookings', 'approval_flow_snapshot_json']
  ,['venue_booking_rules', 'approver_assignment_id']
  ,['security_rate_limit_buckets', 'expires_at']
  ,['audit_temp_uploads', 'organization_id']
  ,['system_config', 'timezone_config_version']
  ,['absolute_time_record_reviews', 'materialization_token']
  ,['absolute_time_record_reviews', 'primary_record_id']
];

const FORBIDDEN_COLUMNS = [
  ['org_hr_profile_template_snapshots', 'version'],
  ['org_hr_profile_template_snapshots', 'source_template_id'],
  ['org_hr_profile_template_snapshots', 'source_template_name'],
  ['org_hr_profile_template_snapshot_fields', 'source_template_field_id'],
  ['org_hr_profile_template_switches', 'from_snapshot_id'],
  ['org_hr_profile_template_switches', 'to_snapshot_id'],
  ['org_hr_profile_template_switches', 'target_template_name']
];

const FORBIDDEN_TABLES = [
  'org_hr_profile_template_settings',
  'score_record_revisions'
];

const REQUIRED_TABLES = [
  'auth_challenges',
  'audit_number_sequences',
  'request_deduplication',
  '_shared_cache',
  'notification_outbox',
  'admin_permission_overrides',
  'admin_permission_audit_logs',
  'org_hr_profile_template_snapshots',
  'org_hr_profile_template_snapshot_fields',
  'org_hr_profile_template_switches',
  'org_hr_profile_template_switch_actions'
  ,'identity_migration_guards'
  ,'persons'
  ,'organization_memberships'
  ,'membership_assignments'
  ,'accounts'
  ,'account_wechat_bindings'
  ,'admin_grants'
  ,'auth_sessions'
  ,'auth_bootstrap_sessions'
  ,'identity_claim_requests'
  ,'identity_verification_tokens'
  ,'identity_verification_invites'
  ,'account_recovery_credentials'
  ,'account_recovery_requests'
  ,'auth_policy'
  ,'auth_audit_events'
  ,'venue_booking_policies'
  ,'person_profile_values'
  ,'person_profile_value_history'
  ,'absolute_time_source_registry'
  ,'absolute_time_record_reviews'
  ,'absolute_time_migration_audit'
  ,'absolute_time_cutovers'
  ,'security_rate_limit_buckets'
  ,'audit_temp_uploads'
  ,'score_snapshot_backfill_audits'
];

const REQUIRED_INDEXES = [
  ['score_records', 'uk_sr_business'],
  ['score_question_templates', 'idx_sqt_org'],
  ['score_answers', 'uk_sa_record_question'],
  ['score_snapshot_backfill_audits', 'idx_score_snapshot_audit_status'],
  ['audit_read_cursors', 'uk_arc_org_hr_submission'],
  ['notifications', 'uk_notification_event'],
  ['notifications', 'idx_notification_recipient_page'],
  ['notification_outbox', 'uk_notification_outbox_event'],
  ['admin_permission_overrides', 'uk_admin_permission'],
  ['admin_info', 'uk_ai_invite_code'],
  ['hr_profile_templates', 'idx_hpt_name'],
  ['org_hr_profile_template_snapshots', 'uk_ohpts_org'],
  ['hr_profile_record_values', 'uk_hprv_value']
  ,['persons', 'uk_person_student']
  ,['organization_memberships', 'uk_membership_person_org']
  ,['account_wechat_bindings', 'idx_wechat_openid_hash']
  ,['account_wechat_bindings', 'uk_wechat_active_openid']
  ,['account_wechat_bindings', 'uk_wechat_active_account']
  ,['auth_sessions', 'idx_auth_session_account']
  ,['auth_sessions', 'idx_auth_session_device']
  ,['person_profile_values', 'uk_person_profile_value']
  ,['identity_claim_requests', 'idx_claim_org_status']
  ,['identity_verification_invites', 'idx_identity_invite_org_status']
  ,['auth_audit_events', 'idx_auth_audit_type']
  ,['venue_booking_policies', 'uk_vbp_venue_org']
  ,['absolute_time_record_reviews', 'idx_absolute_time_presentation_record']
  ,['absolute_time_record_reviews', 'idx_absolute_time_presentation_raw']
  ,['venue_booking_rules', 'idx_vbr_approver_assignment']
  ,['security_rate_limit_buckets', 'idx_security_rate_limit_expiry']
  ,['audit_temp_uploads', 'idx_audit_temp_upload_owner']
  ,['audit_submission_files', 'idx_asf_current_revision']
];

async function verifySchemaContract(pool) {
  const [columns, tables, indexes] = await Promise.all([
    pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()`
    ),
    pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()`
    ),
    pool.query(
      `SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()`
    )
  ]);
  const columnSet = new Set(columns[0].map((row) => row.TABLE_NAME + '.' + row.COLUMN_NAME));
  const tableSet = new Set(tables[0].map((row) => row.TABLE_NAME));
  const indexSet = new Set(indexes[0].map((row) => row.TABLE_NAME + '.' + row.INDEX_NAME));
  const missing = [];
  for (const [table, column] of REQUIRED_COLUMNS) {
    if (!columnSet.has(table + '.' + column)) missing.push('column:' + table + '.' + column);
  }
  for (const table of REQUIRED_TABLES) {
    if (!tableSet.has(table)) missing.push('table:' + table);
  }
  for (const [table, index] of REQUIRED_INDEXES) {
    if (!indexSet.has(table + '.' + index)) missing.push('index:' + table + '.' + index);
  }
  for (const [table, column] of FORBIDDEN_COLUMNS) {
    if (columnSet.has(table + '.' + column)) missing.push('legacy-column:' + table + '.' + column);
  }
  for (const table of FORBIDDEN_TABLES) {
    if (tableSet.has(table)) missing.push('legacy-table:' + table);
  }
  if (missing.length) {
    const error = new Error(localeCopy.copy_973bd5883b + missing.join(', '));
    error.code = 'schema_contract_failed';
    error.missing = missing;
    throw error;
  }
  const [invalidAdmins] = await pool.query(
    `SELECT id FROM admin_info
      WHERE admin_level NOT IN ('super_admin', 'admin')
         OR (admin_level = 'super_admin' AND org_id != '')
      LIMIT 1`
  );
  if (invalidAdmins.length) {
    const error = new Error(localeCopy.copy_31b25fc434);
    error.code = 'schema_contract_failed';
    error.missing = ['data:admin_info.two_level_admins'];
    throw error;
  }
  const [invalidHrProfiles] = await pool.query(
    `SELECT
       (SELECT COUNT(*)
          FROM hr_profile_records record_row
          LEFT JOIN org_hr_profile_template_snapshots snapshot ON snapshot.id = record_row.template_snapshot_id
         WHERE record_row.template_snapshot_id IS NOT NULL
           AND (snapshot.id IS NULL OR snapshot.org_id <> record_row.org_id)) AS invalid_records,
       (SELECT COUNT(*)
          FROM hr_profile_record_values value_row
          LEFT JOIN org_hr_profile_template_snapshot_fields field_row ON field_row.id = value_row.field_id
          LEFT JOIN org_hr_profile_template_snapshots snapshot ON snapshot.id = field_row.snapshot_id
         WHERE field_row.id IS NULL OR snapshot.id IS NULL OR snapshot.org_id <> value_row.org_id) AS invalid_values`
  );
  const hrIntegrity = invalidHrProfiles[0] || {};
  if (Number(hrIntegrity.invalid_records) || Number(hrIntegrity.invalid_values)) {
    const error = new Error(localeCopy.copy_6d870b69a4);
    error.code = 'schema_contract_failed';
    error.missing = ['data:hr_profile_snapshot_integrity'];
    throw error;
  }
  const [identityIntegrityRows] = await pool.query(
    `SELECT
       (SELECT 0) AS verified_accounts_without_login_method,
       (SELECT COUNT(*)
          FROM account_wechat_bindings b
         WHERE b.status = 'active'
         GROUP BY b.account_id
        HAVING COUNT(*) > 1
         LIMIT 1) AS account_multi_binding,
       (SELECT COUNT(*)
          FROM account_wechat_bindings b
         WHERE b.status = 'active'
           AND (b.hash_version <> 'hmac_sha256_v1'
                OR b.openid_ciphertext IS NULL
                OR b.legacy_openid IS NOT NULL)) AS insecure_active_bindings,
       (SELECT COUNT(*)
          FROM hr_info h
          LEFT JOIN organization_memberships om
            ON om.legacy_hr_id = h.id AND om.org_id = h.org_id
         WHERE om.id IS NULL) AS unmapped_hr_records,
       (SELECT COUNT(*)
          FROM admin_info ai
          LEFT JOIN admin_grants ag
            ON ag.legacy_admin_id = ai.id AND ag.status = 'active'
         WHERE ag.id IS NULL) AS unmapped_admin_records`
  );
  const identityIntegrity = identityIntegrityRows[0] || {};
  // 自然人是跨组织主体。永久删除最后一条组织成员关系后，仍需保留自然人和
  // 全局账号，因此“暂不属于任何组织”是合法状态，不能阻止服务启动。
  if (Number(identityIntegrity.verified_accounts_without_login_method)
    || Number(identityIntegrity.account_multi_binding)
    || Number(identityIntegrity.insecure_active_bindings)
    || Number(identityIntegrity.unmapped_hr_records)
    || Number(identityIntegrity.unmapped_admin_records)) {
    const error = new Error(localeCopy.copy_5c60f991c0);
    error.code = 'schema_contract_failed';
    error.missing = ['data:unified_identity_integrity'];
    throw error;
  }
  const [signingKeyIntegrityRows] = await pool.query(
    `SELECT COUNT(*) AS invalid_count
       FROM audit_submission_files
      WHERE signing_key_private IS NOT NULL
        AND signing_key_private <> ''
        AND (signing_key_encryption_version IS NULL
             OR signing_key_private NOT REGEXP '^enc:v1:[A-Za-z0-9._-]{1,32}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:gcm$'
             OR signing_key_private NOT LIKE CONCAT('enc:v1:', signing_key_encryption_version, ':%'))`
  );
  if (Number(signingKeyIntegrityRows[0] && signingKeyIntegrityRows[0].invalid_count)) {
    const error = new Error(localeCopy.copy_2f34ed57e0);
    error.code = 'schema_contract_failed';
    error.missing = ['data:audit_signing_key_encryption'];
    throw error;
  }
  const [boundSuperAdmins] = await pool.query(
    `SELECT
       COUNT(DISTINCT ag.id) AS total,
       COUNT(DISTINCT CASE WHEN a.status = 'verified' AND b.status = 'active' THEN ag.id END) AS bound_count
       FROM admin_grants ag
       LEFT JOIN accounts a ON a.person_id = ag.person_id
       LEFT JOIN account_wechat_bindings b ON b.account_id = a.id AND b.status = 'active'
      WHERE ag.admin_level = 'super_admin' AND ag.status = 'active'`
  );
  const superAdminState = boundSuperAdmins[0] || {};
  if (Number(superAdminState.total) > 0 && Number(superAdminState.bound_count) < 1) {
    const error = new Error(localeCopy.copy_c2f32234c0);
    error.code = 'schema_contract_failed';
    error.missing = ['data:unified_identity_bound_super_admin'];
    throw error;
  }
  return { status: 'ok', revision: '2026-07-unified-identity-v1' };
}

module.exports = {
  verifySchemaContract,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  REQUIRED_INDEXES,
  FORBIDDEN_COLUMNS,
  FORBIDDEN_TABLES
};
