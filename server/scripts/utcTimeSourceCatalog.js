'use strict';

// 旧版本同时存在 mysql2 时区转换、SQL NOW/CURRENT_TIMESTAMP 和手工 Date 写入。
// 在没有逐记录证明时，字段名或表名只能证明“这是绝对时间候选”，不能证明应统一平移。
const NON_USER_VISIBLE_TABLES = new Set([
  'schema_migrations',
  'organization_dictionary_locks',
  'request_deduplication',
  '_shared_cache',
  'identity_migration_guards',
  'personnel_migration_audit',
  'absolute_time_source_registry',
  'absolute_time_record_reviews',
  'absolute_time_migration_audit',
  'absolute_time_cutovers',
  'score_snapshot_backfill_audits',
  'score_snapshot_normalization_audits',
  'security_rate_limit_buckets',
  'audit_temp_uploads'
]);

// 这两张内部安全表只会在 UTC 体系切换完成后创建，写入连接也固定为 UTC。
// 必须逐列显式登记，避免 fresh schema 预检把 CURRENT_TIMESTAMP 误判成历史 +08:00 墙上时间。
const NATIVE_UTC_INTERNAL_COLUMNS = new Map([
  ['audit_signing_evidence', new Set(['signed_at'])],
  ['audit_signing_certificates', new Set(['created_at'])],
  ['security_rate_limit_buckets', new Set([
    'window_started_at',
    'expires_at',
    'created_at',
    'updated_at'
  ])],
  ['audit_temp_uploads', new Set([
    'expires_at',
    'created_at'
  ])],
  ['score_snapshot_backfill_audits', new Set([
    'reconstructed_at',
    'applied_at'
  ])],
  ['score_snapshot_normalization_audits', new Set([
    'normalized_at'
  ])],
  ['score_records', new Set([
    'updated_at'
  ])]
]);

// 这些旧生产字段已有迁移账本、迁移前备份和行级因果关系的组合证据，
// 可以证明写入源是数据库/mysql2 +08:00 墙上时间。仅这些精确字段允许整列平移；
// 其他用户可见字段即使具有 CURRENT_TIMESTAMP 默认值，也必须逐记录核对。
const PROVEN_LEGACY_WALL_TIME_COLUMNS = new Map([
  ['accounts', new Set(['created_at', 'updated_at'])],
  ['persons', new Set(['created_at', 'updated_at'])],
  ['organization_memberships', new Set(['created_at', 'updated_at'])],
  ['membership_assignments', new Set(['created_at', 'updated_at'])],
  ['identity_migration_guards', new Set(['checked_at'])],
  ['personnel_migration_audit', new Set(['created_at'])],
  ['organization_dictionary_locks', new Set(['touched_at'])],
  ['hr_profile_record_values', new Set(['updated_at'])]
]);

// 这些表在旧版本中同时存在手工 UTC 字符串和 mysql2 +08:00/数据库墙上时间写入。
// 表内历史记录来源无法仅凭字段判断，必须逐记录核对，禁止整列平移。
const MIXED_SOURCE_TABLES = new Set([
  'departments',
  'identities',
  'work_groups',
  'hr_info',
  'user_info',
  'system_config',
  'score_activities',
  'score_question_templates',
  'rate_target_rules',
  'score_records',
  'hr_profile_records',
  'person_profile_values',
  'person_profile_value_history',
  'result_publications',
  'pub_view_rules',
  'pub_view_rule_clauses',
  'pub_merit_rules',
  'pub_merit_rule_clauses'
]);

const ABSOLUTE_COLUMN_PATTERN = /(?:^|_)(?:created|updated|processed|signed|expires|approved|rejected|reviewed|submitted|completed|deleted|joined|left|revoked|bound|verified|consumed|read|published|requested|required|available|checked|touched|invited|selected|seen|locked|used|start|starts|end|ends)(?:_at|_until)?$/;

function isAbsoluteColumnName(columnName) {
  return columnName === 'time_start' || columnName === 'time_end' || ABSOLUTE_COLUMN_PATTERN.test(columnName);
}

function hasDatabaseWallClockDefault(column) {
  return /CURRENT_TIMESTAMP/i.test(String(column && column.columnDefault || ''));
}

function classifyColumn(tableName, columnName, column) {
  const nativeUtcColumns = NATIVE_UTC_INTERNAL_COLUMNS.get(tableName);
  if (nativeUtcColumns && nativeUtcColumns.has(columnName)) {
    return {
      sourceType: 'post_cutover_native_utc',
      migrationAction: 'keep_utc',
      evidence: 'UTC 体系切换后创建的内部表，由 UTC 数据库会话原生写入；保持原值，禁止历史时区平移'
    };
  }
  if (isAbsoluteColumnName(columnName)) {
    const provenColumns = PROVEN_LEGACY_WALL_TIME_COLUMNS.get(tableName);
    if (provenColumns && provenColumns.has(columnName) && hasDatabaseWallClockDefault(column)) {
      return {
        sourceType: 'legacy_wall_utc_plus_8',
        migrationAction: 'shift_minus_480',
        evidence: '迁移账本、迁移前备份与行级因果关系共同证明该字段由旧 +08:00 墙上时间写入'
      };
    }
    // 用户可见历史表即使存在 CURRENT_TIMESTAMP 默认值，也可能被应用显式写入。
    // 没有逐记录证明时一律进入核对账本，禁止仅凭列默认值整列平移。
    if (!isUserVisibleTable(tableName)
      && !MIXED_SOURCE_TABLES.has(tableName)
      && hasDatabaseWallClockDefault(column)) {
      return {
        sourceType: 'legacy_wall_utc_plus_8',
        migrationAction: 'shift_minus_480',
        evidence: '旧连接固定 +08:00，且字段由数据库 CURRENT_TIMESTAMP 生成；整列减 480 分钟转为 UTC'
      };
    }
    return {
      sourceType: 'legacy_unverified',
      migrationAction: 'record_review',
      evidence: '未取得逐记录写入来源证明；保持原值并建立逐记录待核对记录'
    };
  }
  return {
    sourceType: 'unclassified',
    migrationAction: 'block_release',
    evidence: '未登记绝对时间语义或逐记录写入来源'
  };
}

function isUserVisibleTable(tableName) {
  return !NON_USER_VISIBLE_TABLES.has(tableName);
}

module.exports = {
  NON_USER_VISIBLE_TABLES,
  NATIVE_UTC_INTERNAL_COLUMNS,
  PROVEN_LEGACY_WALL_TIME_COLUMNS,
  MIXED_SOURCE_TABLES,
  ABSOLUTE_COLUMN_PATTERN,
  isAbsoluteColumnName,
  hasDatabaseWallClockDefault,
  classifyColumn,
  isUserVisibleTable
};
