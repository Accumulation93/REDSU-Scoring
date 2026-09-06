-- ============================================================
-- WHUSU Smart Workspace - MySQL Database Schema
-- Converted from WeChat Cloud NoSQL to MySQL Relational
-- Date: 2026-05-01
-- ============================================================

-- ============================================================
-- 1. 基础组织表
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_org_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_config (
  id VARCHAR(32) NOT NULL PRIMARY KEY DEFAULT 'default',
  timezone INT NOT NULL DEFAULT 8,
  timezone_config_version BIGINT NOT NULL DEFAULT 1,
  current_organization VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed data
INSERT IGNORE INTO system_config (id, timezone) VALUES ('default', 8);

CREATE TABLE IF NOT EXISTS organization_dictionary_locks (
  org_id VARCHAR(64) NOT NULL PRIMARY KEY,
  touched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. 组织架构表 (org-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dep_org (org_id),
  UNIQUE INDEX idx_dept_name (name, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identities (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_idt_org (org_id),
  UNIQUE INDEX idx_ident_name (name, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_groups (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  department_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_wg_department (department_id),
  INDEX idx_wg_org (org_id),
  UNIQUE INDEX idx_wg_dept_name (department_id, name, org_id),
  CONSTRAINT fk_wg_department FOREIGN KEY (department_id)
    REFERENCES departments(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. 人事表 (org-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS hr_info (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  student_id VARCHAR(32) NOT NULL,
  department_id VARCHAR(64) DEFAULT NULL,
  identity_id VARCHAR(64) DEFAULT NULL,
  work_group_id VARCHAR(64) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_hr_dept (department_id),
  INDEX idx_hr_identity (identity_id),
  INDEX idx_hr_wg (work_group_id),
  INDEX idx_hr_org (org_id),
  UNIQUE INDEX idx_hr_student (student_id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. 用户绑定表 (org-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_info (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  openid VARCHAR(128) NOT NULL,
  hr_id VARCHAR(64) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ui_hr (hr_id),
  INDEX idx_ui_org (org_id),
  UNIQUE INDEX idx_ui_openid (openid, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_info (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  student_id VARCHAR(32) DEFAULT NULL,
  openid VARCHAR(128) DEFAULT NULL,
  admin_level VARCHAR(32) NOT NULL DEFAULT 'admin',
  bind_status VARCHAR(16) NOT NULL DEFAULT 'invited',
  invite_code VARCHAR(32) DEFAULT NULL,
  invited_at DATETIME DEFAULT NULL,
  invite_expires_at DATETIME DEFAULT NULL,
  invite_consumed_at DATETIME DEFAULT NULL,
  bound_at DATETIME DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_openid (openid),
  INDEX idx_ai_level (admin_level),
  INDEX idx_ai_bind (bind_status),
  INDEX idx_ai_org (org_id),
  UNIQUE INDEX uk_ai_invite_code (invite_code),
  UNIQUE INDEX idx_ai_student (student_id, org_id),
  CONSTRAINT chk_admin_level_two_tier CHECK (admin_level IN ('super_admin', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_challenges (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  challenge_type VARCHAR(32) NOT NULL,
  openid_hash CHAR(64) NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ac_expiry (expires_at),
  INDEX idx_ac_owner (openid_hash, challenge_type, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_permission_overrides (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  admin_id VARCHAR(64) NOT NULL,
  permission_key VARCHAR(100) NOT NULL,
  granted TINYINT(1) NOT NULL DEFAULT 0,
  configured_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_admin_permission (org_id, admin_id, permission_key),
  INDEX idx_admin_permission_target (admin_id, org_id),
  INDEX idx_admin_permission_operator (configured_by, created_at),
  CONSTRAINT fk_admin_permission_target FOREIGN KEY (admin_id) REFERENCES admin_info(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_permission_audit_logs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  operator_admin_id VARCHAR(64) NOT NULL,
  target_admin_id VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,
  snapshot_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_permission_audit_org_time (org_id, created_at),
  INDEX idx_permission_audit_target_time (target_admin_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. 评分活动与模板
-- ============================================================

CREATE TABLE IF NOT EXISTS score_activities (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  start_date DATE DEFAULT NULL,
  end_date DATE DEFAULT NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 0,
  participant_granularity VARCHAR(16) NOT NULL DEFAULT 'assignment',
  is_paused TINYINT(1) NOT NULL DEFAULT 0,
  created_by VARCHAR(64) DEFAULT NULL,
  updated_by VARCHAR(64) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sa_current (is_current),
  INDEX idx_sa_org (org_id),
  UNIQUE INDEX idx_sa_name (name, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS score_question_templates (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  created_by VARCHAR(64) DEFAULT NULL,
  updated_by VARCHAR(64) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sqt_org (org_id),
  UNIQUE INDEX idx_sqt_name (name, org_id),
  CONSTRAINT fk_sqt_org FOREIGN KEY (org_id)
    REFERENCES organizations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 从 templates.questions JSON 拆出，有顺序
CREATE TABLE IF NOT EXISTS score_questions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  template_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  question TEXT,
  score_label TEXT,
  min_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  start_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  max_value DECIMAL(10,2) NOT NULL DEFAULT 5.00,
  step_value DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  INDEX idx_sq_template (template_id),
  CONSTRAINT fk_sq_template FOREIGN KEY (template_id)
    REFERENCES score_question_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. 评分规则（JSON 拆表, org-scoped）
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_target_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  activity_id VARCHAR(64) NOT NULL,
  scorer_department_id VARCHAR(64) NOT NULL,
  scorer_identity_id VARCHAR(64) NOT NULL,
  scorer_key VARCHAR(256) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  allow_self_assessment TINYINT(1) NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rtr_activity (activity_id),
  INDEX idx_rtr_key (scorer_key),
  INDEX idx_rtr_active (is_active),
  INDEX idx_rtr_org (org_id),
  CONSTRAINT fk_rtr_activity FOREIGN KEY (activity_id)
    REFERENCES score_activities(id) ON DELETE CASCADE,
  CONSTRAINT fk_rtr_scorer_department FOREIGN KEY (scorer_department_id)
    REFERENCES departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rtr_scorer_identity FOREIGN KEY (scorer_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 从 rules.clauses JSON 拆出
CREATE TABLE IF NOT EXISTS rate_rule_clauses (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  rule_id VARCHAR(64) NOT NULL,
  scope_type VARCHAR(50) NOT NULL,
  target_identity_id VARCHAR(64) DEFAULT NULL,
  require_all_complete TINYINT(1) NOT NULL DEFAULT 0,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  INDEX idx_rrc_rule (rule_id),
  INDEX idx_rrc_org (org_id),
  CONSTRAINT fk_rrc_rule FOREIGN KEY (rule_id)
    REFERENCES rate_target_rules(id) ON DELETE CASCADE,
  CONSTRAINT fk_rrc_target_identity FOREIGN KEY (target_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 从 clauses[].templateConfigs 拆出，有顺序
CREATE TABLE IF NOT EXISTS clause_template_configs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  clause_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  template_id VARCHAR(64) NOT NULL,
  weight DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  calculation_method VARCHAR(32) NOT NULL DEFAULT 'weighted_average',
  trim_high_count INT NOT NULL DEFAULT 0,
  trim_low_count INT NOT NULL DEFAULT 0,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  INDEX idx_ctc_clause (clause_id),
  INDEX idx_ctc_template (template_id),
  INDEX idx_ctc_org (org_id),
  CONSTRAINT fk_ctc_clause FOREIGN KEY (clause_id)
    REFERENCES rate_rule_clauses(id) ON DELETE CASCADE,
  CONSTRAINT fk_ctc_template FOREIGN KEY (template_id)
    REFERENCES score_question_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS score_template_order (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  activity_id VARCHAR(64) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  INDEX idx_sto_activity (activity_id),
  INDEX idx_sto_template (template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. 评分记录（JSON 拆表, org-scoped）
-- ============================================================

CREATE TABLE IF NOT EXISTS score_records (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  activity_id VARCHAR(64) NOT NULL,
  rule_id VARCHAR(64) NOT NULL,
  scorer_id VARCHAR(64) NOT NULL,
  scorer_person_id VARCHAR(64) DEFAULT NULL,
  scorer_assignment_id VARCHAR(64) DEFAULT NULL,
  scorer_context_snapshot JSON DEFAULT NULL,
  scorer_subject_key VARCHAR(96) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  target_person_id VARCHAR(64) DEFAULT NULL,
  target_assignment_id VARCHAR(64) DEFAULT NULL,
  target_context_snapshot JSON DEFAULT NULL,
  target_subject_key VARCHAR(96) NOT NULL,
  template_config_signature TEXT,
  calculation_context_snapshot JSON DEFAULT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision_number INT NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  INDEX idx_sr_activity (activity_id),
  INDEX idx_sr_rule (rule_id),
  INDEX idx_sr_scorer (scorer_id),
  INDEX idx_sr_scorer_person (scorer_person_id),
  INDEX idx_sr_target (target_id),
  INDEX idx_sr_target_person (target_person_id),
  INDEX idx_sr_scorer_target (scorer_id, target_id),
  INDEX idx_sr_org (org_id),
  UNIQUE INDEX uk_sr_business (org_id, activity_id, scorer_subject_key, target_subject_key),
  CONSTRAINT fk_sr_activity FOREIGN KEY (activity_id)
    REFERENCES score_activities(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_rule FOREIGN KEY (rule_id)
    REFERENCES rate_target_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 从 records.answers JSON 拆出，有顺序
CREATE TABLE IF NOT EXISTS score_answers (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  record_id VARCHAR(64) NOT NULL,
  question_index INT NOT NULL DEFAULT 1,
  score DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  INDEX idx_sa_record (record_id),
  INDEX idx_sa_org (org_id),
  UNIQUE INDEX uk_sa_record_question (record_id, question_index),
  CONSTRAINT fk_sa_record FOREIGN KEY (record_id)
    REFERENCES score_records(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 8. 人事扩展资料（全局模板 + 组织快照）
-- ============================================================

CREATE TABLE IF NOT EXISTS hr_profile_templates (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  edit_mode VARCHAR(32) NOT NULL DEFAULT 'direct',
  created_by VARCHAR(64) DEFAULT NULL,
  updated_by VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_hpt_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_profile_template_fields (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  template_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  label VARCHAR(200) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'text',
  required TINYINT(1) NOT NULL DEFAULT 0,
  min_length INT DEFAULT NULL,
  max_length INT DEFAULT NULL,
  number_rule VARCHAR(32) DEFAULT 'value_range',
  allow_decimal TINYINT(1) NOT NULL DEFAULT 1,
  min_digits INT DEFAULT NULL,
  max_digits INT DEFAULT NULL,
  min_value DECIMAL(20,4) DEFAULT NULL,
  max_value DECIMAL(20,4) DEFAULT NULL,
  options_json TEXT,
  INDEX idx_hptf_template (template_id),
  CONSTRAINT fk_hptf_template FOREIGN KEY (template_id)
    REFERENCES hr_profile_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS org_hr_profile_template_snapshots (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  description TEXT,
  edit_mode VARCHAR(32) NOT NULL DEFAULT 'direct',
  created_by VARCHAR(64) DEFAULT NULL,
  updated_by VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_ohpts_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS org_hr_profile_template_snapshot_fields (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  snapshot_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  label VARCHAR(200) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'text',
  required TINYINT(1) NOT NULL DEFAULT 0,
  min_length INT DEFAULT NULL,
  max_length INT DEFAULT NULL,
  number_rule VARCHAR(32) DEFAULT 'value_range',
  allow_decimal TINYINT(1) NOT NULL DEFAULT 1,
  min_digits INT DEFAULT NULL,
  max_digits INT DEFAULT NULL,
  min_value DECIMAL(20,4) DEFAULT NULL,
  max_value DECIMAL(20,4) DEFAULT NULL,
  options_json TEXT,
  INDEX idx_ohptsf_snapshot (snapshot_id),
  INDEX idx_ohptsf_active (snapshot_id, is_active, sort_order),
  CONSTRAINT fk_ohptsf_snapshot FOREIGN KEY (snapshot_id)
    REFERENCES org_hr_profile_template_snapshots(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS org_hr_profile_template_switches (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  snapshot_id VARCHAR(64) NOT NULL,
  operated_by VARCHAR(64) DEFAULT NULL,
  moved_value_count INT NOT NULL DEFAULT 0,
  hidden_value_count INT NOT NULL DEFAULT 0,
  deleted_value_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ohptswitch_org (org_id),
  CONSTRAINT fk_ohptswitch_snapshot FOREIGN KEY (snapshot_id)
    REFERENCES org_hr_profile_template_snapshots(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS org_hr_profile_template_switch_actions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  switch_id VARCHAR(64) NOT NULL,
  source_snapshot_field_id VARCHAR(64) NOT NULL,
  action VARCHAR(16) NOT NULL,
  target_snapshot_field_id VARCHAR(64) DEFAULT NULL,
  current_value_count INT NOT NULL DEFAULT 0,
  pending_value_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ohptswitcha_switch (switch_id),
  CONSTRAINT fk_ohptswitcha_switch FOREIGN KEY (switch_id)
    REFERENCES org_hr_profile_template_switches(id) ON DELETE CASCADE,
  CONSTRAINT fk_ohptswitcha_source FOREIGN KEY (source_snapshot_field_id)
    REFERENCES org_hr_profile_template_snapshot_fields(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ohptswitcha_target FOREIGN KEY (target_snapshot_field_id)
    REFERENCES org_hr_profile_template_snapshot_fields(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_profile_records (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  hr_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) DEFAULT NULL,
  openid VARCHAR(128) DEFAULT NULL,
  template_snapshot_id VARCHAR(64) DEFAULT NULL,
  audit_status VARCHAR(16) NOT NULL DEFAULT 'none',
  rejection_reason TEXT,
  requested_at DATETIME DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_hpr_hr (hr_id),
  INDEX idx_hpr_openid (openid),
  INDEX idx_hpr_status (audit_status),
  INDEX idx_hpr_org (org_id),
  INDEX idx_hpr_snapshot (template_snapshot_id),
  UNIQUE INDEX uk_hr_profile_record_member_org (hr_id, org_id),
  CONSTRAINT fk_hpr_snapshot FOREIGN KEY (template_snapshot_id)
    REFERENCES org_hr_profile_template_snapshots(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 从 records.values / pendingValues JSON 拆出
CREATE TABLE IF NOT EXISTS hr_profile_record_values (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  record_id VARCHAR(64) NOT NULL,
  is_pending TINYINT(1) NOT NULL DEFAULT 0,
  field_id VARCHAR(64) NOT NULL,
  field_value TEXT,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_hprv_record (record_id),
  INDEX idx_hprv_field (field_id),
  INDEX idx_hprv_org (org_id),
  UNIQUE INDEX uk_hprv_value (record_id, field_id, is_pending),
  CONSTRAINT fk_hprv_record FOREIGN KEY (record_id)
    REFERENCES hr_profile_records(id) ON DELETE CASCADE,
  CONSTRAINT fk_hprv_field FOREIGN KEY (field_id)
    REFERENCES org_hr_profile_template_snapshot_fields(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. 结果公示与评优名单

CREATE TABLE IF NOT EXISTS result_publications (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  activity_id VARCHAR(64) NOT NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  published_at DATETIME DEFAULT NULL,
  published_by VARCHAR(64) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rp_activity (activity_id),
  INDEX idx_rp_org (org_id),
  UNIQUE INDEX idx_rp_activity_org (activity_id, org_id),
  CONSTRAINT fk_rp_activity FOREIGN KEY (activity_id)
    REFERENCES score_activities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pub_view_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  publication_id VARCHAR(64) NOT NULL,
  grantee_department_id VARCHAR(64) NOT NULL,
  grantee_identity_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pvr_publication (publication_id),
  INDEX idx_pvr_org (org_id),
  UNIQUE INDEX idx_pvr_pub_dept_ident_org (publication_id, grantee_department_id, grantee_identity_id, org_id),
  CONSTRAINT fk_pvr_publication FOREIGN KEY (publication_id)
    REFERENCES result_publications(id) ON DELETE CASCADE,
  CONSTRAINT fk_pvr_grantee_department FOREIGN KEY (grantee_department_id)
    REFERENCES departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pvr_grantee_identity FOREIGN KEY (grantee_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pub_view_rule_clauses (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  rule_id VARCHAR(64) NOT NULL,
  scope_type VARCHAR(50) NOT NULL,
  target_identity_id VARCHAR(64) DEFAULT NULL,
  display_mode VARCHAR(16) NOT NULL DEFAULT 'score',
  sort_order INT NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pvrc_rule (rule_id),
  INDEX idx_pvrc_org (org_id),
  CONSTRAINT fk_pvrc_rule FOREIGN KEY (rule_id)
    REFERENCES pub_view_rules(id) ON DELETE CASCADE,
  CONSTRAINT fk_pvrc_target_identity FOREIGN KEY (target_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pub_grade_bands (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  clause_id VARCHAR(64) NOT NULL,
  min_score DECIMAL(10,2) NOT NULL,
  max_score DECIMAL(10,2) NOT NULL,
  grade_name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pgb_clause (clause_id),
  INDEX idx_pgb_org (org_id),
  CONSTRAINT fk_pgb_clause FOREIGN KEY (clause_id)
    REFERENCES pub_view_rule_clauses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pub_merit_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  publication_id VARCHAR(64) NOT NULL,
  grantee_department_id VARCHAR(64) NOT NULL,
  grantee_identity_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pmr_publication (publication_id),
  INDEX idx_pmr_org (org_id),
  UNIQUE INDEX idx_pmr_pub_dept_ident_org (publication_id, grantee_department_id, grantee_identity_id, org_id),
  CONSTRAINT fk_pmr_publication FOREIGN KEY (publication_id)
    REFERENCES result_publications(id) ON DELETE CASCADE,
  CONSTRAINT fk_pmr_grantee_department FOREIGN KEY (grantee_department_id)
    REFERENCES departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pmr_grantee_identity FOREIGN KEY (grantee_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pub_merit_rule_clauses (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  rule_id VARCHAR(64) NOT NULL,
  scope_type VARCHAR(50) NOT NULL DEFAULT 'all_people',
  target_identity_id VARCHAR(64) NOT NULL,
  quota_limit INT NOT NULL DEFAULT 0,
  require_exact_quota TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pmrc_rule (rule_id),
  INDEX idx_pmrc_org (org_id),
  CONSTRAINT fk_pmrc_rule FOREIGN KEY (rule_id)
    REFERENCES pub_merit_rules(id) ON DELETE CASCADE,
  CONSTRAINT fk_pmrc_target_identity FOREIGN KEY (target_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merit_list_designations (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  publication_id VARCHAR(64) NOT NULL,
  clause_id VARCHAR(64) NOT NULL,
  target_hr_id VARCHAR(64) NOT NULL,
  target_assignment_id VARCHAR(64) DEFAULT NULL,
  target_context_snapshot JSON DEFAULT NULL,
  designated_by VARCHAR(64) NOT NULL,
  designated_by_person_id VARCHAR(64) DEFAULT NULL,
  designated_by_assignment_id VARCHAR(64) DEFAULT NULL,
  designated_by_context_snapshot JSON DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mld_publication (publication_id),
  INDEX idx_mld_clause (clause_id),
  INDEX idx_mld_org (org_id),
  INDEX idx_mld_target_hr (publication_id, target_hr_id, org_id),
  UNIQUE INDEX idx_mld_pub_assignment (publication_id, target_assignment_id, org_id),
  CONSTRAINT fk_mld_publication FOREIGN KEY (publication_id)
    REFERENCES result_publications(id) ON DELETE CASCADE,
  CONSTRAINT fk_mld_clause FOREIGN KEY (clause_id)
    REFERENCES pub_merit_rule_clauses(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 10. 审核工作流系统 (org-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_flow_templates (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  starter_type VARCHAR(20) NOT NULL DEFAULT 'self',
  starter_identity_id VARCHAR(64) DEFAULT NULL,
  starter_hr_id VARCHAR(64) DEFAULT NULL,
  starter_conditions_json TEXT DEFAULT NULL COMMENT '发起条件 JSON 数组',
  resubmit_mode VARCHAR(20) NOT NULL DEFAULT 'fresh',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_by VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_aft_org (org_id),
  INDEX idx_aft_active (is_active),
  CONSTRAINT fk_aft_starter_identity FOREIGN KEY (starter_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_flow_template_steps (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  template_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  approver_type VARCHAR(20) NOT NULL DEFAULT 'identity',
  approver_identity_id VARCHAR(64) DEFAULT NULL,
  approver_hr_id VARCHAR(64) DEFAULT NULL,
  related_relation VARCHAR(20) DEFAULT NULL,
  action_type VARCHAR(20) NOT NULL DEFAULT 'sign',
  allow_approver_designation TINYINT(1) NOT NULL DEFAULT 0 COMMENT '允许进入本步骤前指定审批人',
  name VARCHAR(128) DEFAULT '' COMMENT '步骤名称',
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_afts_template (template_id),
  INDEX idx_afts_org (org_id),
  CONSTRAINT fk_afts_template FOREIGN KEY (template_id)
    REFERENCES audit_flow_templates(id) ON DELETE CASCADE,
  CONSTRAINT fk_afts_approver_identity FOREIGN KEY (approver_identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS signature_templates (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  hr_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) DEFAULT NULL,
  image_data LONGTEXT,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_st_hr (hr_id),
  INDEX idx_st_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stamps (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  image_data LONGTEXT,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_by VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stamp_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_stamp_assignments (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  stamp_id VARCHAR(64) NOT NULL,
  identity_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_isa_stamp (stamp_id),
  INDEX idx_isa_identity (identity_id),
  INDEX idx_isa_org (org_id),
  UNIQUE INDEX idx_isa_unique (stamp_id, identity_id, org_id),
  CONSTRAINT fk_isa_stamp FOREIGN KEY (stamp_id)
    REFERENCES stamps(id) ON DELETE CASCADE,
  CONSTRAINT fk_isa_identity FOREIGN KEY (identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_submissions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  submission_number VARCHAR(32) NOT NULL,
  submitted_by VARCHAR(64) NOT NULL,
  submitted_person_id VARCHAR(64) DEFAULT NULL,
  submitted_assignment_id VARCHAR(64) DEFAULT NULL,
  submitted_context_snapshot JSON DEFAULT NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'template',
  template_id VARCHAR(64) DEFAULT NULL,
  title VARCHAR(200) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  current_step_index INT NOT NULL DEFAULT 0,
  resubmit_mode VARCHAR(20) NOT NULL DEFAULT 'fresh',
  previous_reject_step_index INT DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_as_submitter (submitted_by),
  INDEX idx_audit_submission_assignment (submitted_assignment_id, org_id),
  INDEX idx_as_status (status),
  INDEX idx_as_template (template_id),
  INDEX idx_as_org (org_id),
  UNIQUE INDEX idx_as_number (submission_number, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_submission_files (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  submission_id VARCHAR(64) NOT NULL,
  file_name VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) DEFAULT NULL,
  file_path VARCHAR(1000) NOT NULL,
  file_size INT DEFAULT NULL,
  file_hash VARCHAR(64) NOT NULL,
  signing_key_private TEXT NULL COMMENT 'PDF电子签名私钥（AES-256-GCM版本密文，仅服务端）',
  signing_key_encryption_version VARCHAR(32) NULL COMMENT 'PDF签名私钥主密钥版本',
  signing_key_public TEXT NULL COMMENT 'PDF电子签名公钥',
  signing_cert TEXT NULL COMMENT 'PDF电子签名最近证书（PEM）',
  signing_cert_chain TEXT NULL COMMENT 'PDF电子签名中间证书链（PEM）',
  signing_trust_status VARCHAR(32) NOT NULL DEFAULT 'self_signed' COMMENT 'self_signed | certificate_configured | chain_configured',
  signing_algorithm VARCHAR(32) NOT NULL DEFAULT 'RSA-SHA256',
  signing_created_at DATETIME NULL,
  revision_round INT NOT NULL DEFAULT 1,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_asf_submission (submission_id),
  INDEX idx_asf_current_revision (submission_id, is_current, revision_round, sort_order),
  INDEX idx_asf_org (org_id),
  CONSTRAINT fk_asf_submission FOREIGN KEY (submission_id)
    REFERENCES audit_submissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_submission_steps (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  submission_id VARCHAR(64) NOT NULL,
  template_step_id VARCHAR(64) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  approver_type VARCHAR(20) NOT NULL DEFAULT 'identity',
  approver_hr_id VARCHAR(64) DEFAULT NULL,
  approver_identity_id VARCHAR(64) DEFAULT NULL,
  scope_type VARCHAR(32) DEFAULT NULL COMMENT 'all | same_department | same_work_group | specific_department | specific_work_group',
  scope_department_id VARCHAR(64) DEFAULT NULL,
  scope_work_group_id VARCHAR(64) DEFAULT NULL,
  step_conditions_json TEXT DEFAULT NULL COMMENT '步骤审批条件 JSON 数组',
  action_type VARCHAR(20) NOT NULL DEFAULT 'sign',
  allow_approver_designation TINYINT(1) NOT NULL DEFAULT 0 COMMENT '允许进入本步骤前指定审批人',
  step_name VARCHAR(128) DEFAULT '' COMMENT '步骤名称',
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  comment TEXT,
  rejection_reason TEXT,
  round INT NOT NULL DEFAULT 1,
  processed_at DATETIME DEFAULT NULL,
  processed_person_id VARCHAR(64) DEFAULT NULL,
  processed_assignment_id VARCHAR(64) DEFAULT NULL,
  processed_context_snapshot JSON DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ass_step_submission (submission_id),
  INDEX idx_ass_step_approver (approver_hr_id),
  INDEX idx_ass_step_status (status),
  INDEX idx_ass_step_round (round),
  INDEX idx_audit_step_assignment (processed_assignment_id, org_id),
  INDEX idx_ass_step_org (org_id),
  CONSTRAINT fk_ass_step_submission FOREIGN KEY (submission_id)
    REFERENCES audit_submissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_submission_signatures (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  submission_id VARCHAR(64) NOT NULL,
  step_id VARCHAR(64) NOT NULL,
  file_id VARCHAR(64) NOT NULL,
  signature_type VARCHAR(16) NOT NULL DEFAULT 'signature',
  image_data LONGTEXT,
  position_x DECIMAL(10,4) NOT NULL DEFAULT 0,
  position_y DECIMAL(10,4) NOT NULL DEFAULT 0,
  signature_size DECIMAL(6,3) NOT NULL DEFAULT 1,
  rotation_degrees DECIMAL(7,2) NOT NULL DEFAULT 0,
  page INT NOT NULL DEFAULT 1,
  signer_hr_id VARCHAR(64) NOT NULL,
  round INT NOT NULL DEFAULT 1,
  previous_signature_hash VARCHAR(64) DEFAULT NULL,
  document_hash_at_signing VARCHAR(64) NOT NULL,
  signature_data_hash VARCHAR(64) NOT NULL,
  signed_at DATETIME NOT NULL,
  material_image_hash VARCHAR(64) NOT NULL DEFAULT '',
  stamp_id VARCHAR(64) DEFAULT NULL,
  signer_assignment_id VARCHAR(64) DEFAULT NULL,
  signer_context_snapshot JSON DEFAULT NULL,
  hash_version SMALLINT NOT NULL DEFAULT 1,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_assin_submission (submission_id),
  INDEX idx_assin_step (step_id),
  INDEX idx_assin_file (file_id),
  INDEX idx_assin_signer (signer_hr_id),
  INDEX idx_assin_round (round),
  INDEX idx_assin_stamp (stamp_id, org_id),
  INDEX idx_assin_assignment (signer_assignment_id, org_id),
  INDEX idx_assin_org (org_id),
  CONSTRAINT fk_assin_submission FOREIGN KEY (submission_id)
    REFERENCES audit_submissions(id) ON DELETE CASCADE,
  CONSTRAINT fk_assin_step FOREIGN KEY (step_id)
    REFERENCES audit_submission_steps(id) ON DELETE CASCADE,
  CONSTRAINT fk_assin_file FOREIGN KEY (file_id)
    REFERENCES audit_submission_files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_verification_permissions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  grantee_hr_id VARCHAR(64) NOT NULL,
  granted_by VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_avp_grantee (grantee_hr_id),
  INDEX idx_avp_org (org_id),
  UNIQUE INDEX idx_avp_unique (grantee_hr_id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 15. 场地借用（场地资源全局，审批配置按组织隔离）
-- ============================================================

CREATE TABLE IF NOT EXISTS venues (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  location VARCHAR(500) DEFAULT NULL,
  description TEXT,
  image_url VARCHAR(1000) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_venues_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_open_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  venue_id VARCHAR(64) NOT NULL,
  name VARCHAR(200) DEFAULT NULL,
  cycle_type VARCHAR(16) NOT NULL DEFAULT 'weekly',
  cycle_values JSON DEFAULT NULL,
  time_start TIME NOT NULL DEFAULT '09:00:00',
  time_end TIME NOT NULL DEFAULT '18:00:00',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vor_venue (venue_id),
  INDEX idx_vor_active (is_active),
  CONSTRAINT fk_vor_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_activity_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  venue_id VARCHAR(64) NOT NULL,
  activity_name VARCHAR(200) DEFAULT NULL,
  cycle_type VARCHAR(16) NOT NULL DEFAULT 'weekly',
  cycle_values JSON DEFAULT NULL,
  time_start TIME NOT NULL DEFAULT '09:00:00',
  time_end TIME NOT NULL DEFAULT '18:00:00',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_var_venue (venue_id),
  INDEX idx_var_active (is_active),
  CONSTRAINT fk_var_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_booking_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  venue_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  rule_type VARCHAR(16) NOT NULL DEFAULT 'admin',
  approver_identity_id VARCHAR(64) DEFAULT NULL,
  approver_hr_id VARCHAR(64) DEFAULT NULL,
  approver_assignment_id VARCHAR(64) DEFAULT NULL,
  scope_department_id VARCHAR(64) DEFAULT NULL,
  scope_work_group_id VARCHAR(64) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vbr_venue (venue_id),
  INDEX idx_vbr_org (org_id),
  INDEX idx_vbr_active (is_active),
  INDEX idx_vbr_approver_assignment (approver_assignment_id, org_id, is_active),
  CONSTRAINT fk_vbr_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS score_snapshot_backfill_audits (
  activity_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  total_record_count BIGINT NOT NULL DEFAULT 0,
  eligible_record_count BIGINT NOT NULL DEFAULT 0,
  blocked_record_count BIGINT NOT NULL DEFAULT 0,
  reasons_json JSON NOT NULL,
  evidence_fingerprint CHAR(64) NOT NULL,
  reconstructed_at DATETIME(3) NOT NULL,
  applied_at DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (activity_id, org_id),
  INDEX idx_score_snapshot_audit_status (status, reconstructed_at),
  CONSTRAINT chk_score_snapshot_audit_status
    CHECK (status IN ('ready', 'applied', 'isolated', 'already_applied'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS score_snapshot_normalization_audits (
  snapshot_version TINYINT UNSIGNED NOT NULL,
  total_record_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  normalized_record_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  evidence_fingerprint CHAR(64) NOT NULL,
  normalized_at DATETIME(3) NOT NULL,
  PRIMARY KEY (snapshot_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_profile_review_events (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  record_id VARCHAR(64) NOT NULL,
  action VARCHAR(24) NOT NULL,
  reason TEXT DEFAULT NULL,
  reviewer_person_id VARCHAR(64) DEFAULT NULL,
  reviewer_context_id VARCHAR(160) DEFAULT NULL,
  effective_values_snapshot JSON DEFAULT NULL,
  pending_values_snapshot JSON DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_profile_review_record (record_id, created_at),
  INDEX idx_profile_review_org (org_id, created_at),
  CONSTRAINT fk_profile_review_record FOREIGN KEY (record_id)
    REFERENCES hr_profile_records(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_booking_policies (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  venue_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  open_advance_mode VARCHAR(16) DEFAULT NULL,
  open_advance_days INT UNSIGNED DEFAULT NULL,
  open_advance_minutes INT UNSIGNED DEFAULT NULL,
  deadline_advance_mode VARCHAR(16) DEFAULT NULL,
  deadline_advance_days INT UNSIGNED DEFAULT NULL,
  deadline_advance_minutes INT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_vbp_venue_org (venue_id, org_id),
  INDEX idx_vbp_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_approval_flows (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  venue_id VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL DEFAULT '',
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  allow_user_select TINYINT(1) NOT NULL DEFAULT 0,
  allow_designate_first TINYINT(1) NOT NULL DEFAULT 0,
  allow_designate_next TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vaf_venue (venue_id, org_id),
  INDEX idx_vaf_org (org_id),
  CONSTRAINT fk_vaf_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_approval_flow_steps (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  flow_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  name VARCHAR(200) NOT NULL DEFAULT '',
  approval_mode VARCHAR(16) NOT NULL DEFAULT 'hr_rule',
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vafs_flow (flow_id, org_id),
  INDEX idx_vafs_org (org_id),
  CONSTRAINT fk_vafs_flow FOREIGN KEY (flow_id) REFERENCES venue_approval_flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_approval_flow_step_rules (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  step_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  department_scope VARCHAR(16) NOT NULL DEFAULT 'all',
  specific_department_id VARCHAR(1000) DEFAULT NULL,
  work_group_scope VARCHAR(16) NOT NULL DEFAULT 'all',
  specific_work_group_id VARCHAR(1000) DEFAULT NULL,
  identity_scope VARCHAR(16) NOT NULL DEFAULT 'all',
  specific_identity_id VARCHAR(1000) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vafsr_step (step_id, org_id),
  INDEX idx_vafsr_org (org_id),
  CONSTRAINT fk_vafsr_step FOREIGN KEY (step_id) REFERENCES venue_approval_flow_steps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_bookings (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  venue_id VARCHAR(64) NOT NULL,
  user_hr_id VARCHAR(64) DEFAULT NULL,
  creator_person_id VARCHAR(64) DEFAULT NULL,
  creator_assignment_id VARCHAR(64) DEFAULT NULL,
  creator_admin_grant_id VARCHAR(64) DEFAULT NULL,
  creator_context_snapshot TEXT DEFAULT NULL,
  creator_type VARCHAR(16) NOT NULL DEFAULT 'user',
  creator_admin_id VARCHAR(64) DEFAULT NULL,
  creator_org_id VARCHAR(64) NOT NULL DEFAULT '',
  approval_org_id VARCHAR(64) NOT NULL DEFAULT '',
  title VARCHAR(200) DEFAULT NULL,
  description TEXT,
  time_start DATETIME NOT NULL,
  time_end DATETIME NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  approval_flow_id VARCHAR(64) DEFAULT NULL,
  approval_flow_state_json TEXT DEFAULT NULL,
  approval_flow_snapshot_json MEDIUMTEXT DEFAULT NULL,
  approval_current_step INT NOT NULL DEFAULT 0,
  approval_total_steps INT NOT NULL DEFAULT 0,
  approval_reject_step INT DEFAULT NULL,
  approval_snapshots_json TEXT DEFAULT NULL,
  approver_hr_id VARCHAR(64) DEFAULT NULL,
  approver_person_id VARCHAR(64) DEFAULT NULL,
  approver_assignment_id VARCHAR(64) DEFAULT NULL,
  approver_admin_grant_id VARCHAR(64) DEFAULT NULL,
  approver_context_snapshot TEXT DEFAULT NULL,
  approval_comment TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vb_venue (venue_id),
  INDEX idx_vb_user (user_hr_id),
  INDEX idx_vb_creator_admin (creator_admin_id),
  INDEX idx_vb_status (status),
  INDEX idx_vb_time_start (time_start),
  INDEX idx_vb_venue_time (venue_id, time_start),
  INDEX idx_vb_venue_status_time (venue_id, status, time_start),
  INDEX idx_vb_creator_org (creator_org_id, status, time_start),
  INDEX idx_vb_approval_org (approval_org_id, status, time_start),
  CONSTRAINT fk_vb_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venue_booking_purposes (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  text VARCHAR(200) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_vbp_text (text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 12. 运行时一致性、消息中心与审计补充表
-- 这些表属于当前服务启动契约；全新部署不得依赖历史迁移补建。
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_flow_template_step_conditions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  template_step_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  condition_type VARCHAR(20) NOT NULL DEFAULT 'identity_scope',
  person_hr_ids TEXT DEFAULT NULL,
  assignment_ids TEXT DEFAULT NULL COMMENT '指定人员对应的岗位 ID，逗号分隔；授权必须同时匹配人员与岗位',
  department_scope VARCHAR(16) DEFAULT 'all',
  specific_department_id VARCHAR(1000) DEFAULT NULL COMMENT '指定部门 ID 集合，逗号分隔',
  work_group_scope VARCHAR(16) DEFAULT 'all',
  specific_work_group_id VARCHAR(1000) DEFAULT NULL COMMENT '指定职能组 ID 集合，逗号分隔',
  identity_scope VARCHAR(16) DEFAULT 'all',
  specific_identity_id VARCHAR(1000) DEFAULT NULL COMMENT '指定身份类别 ID 集合，逗号分隔',
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_aftsc_step (template_step_id),
  INDEX idx_aftsc_org (org_id),
  CONSTRAINT fk_aftsc_step FOREIGN KEY (template_step_id)
    REFERENCES audit_flow_template_steps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  submission_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  step_index INT DEFAULT NULL,
  round INT NOT NULL DEFAULT 1,
  operator_hr_id VARCHAR(64) DEFAULT NULL,
  operator_person_id VARCHAR(64) DEFAULT NULL,
  operator_assignment_id VARCHAR(64) DEFAULT NULL,
  operator_admin_grant_id VARCHAR(64) DEFAULT NULL,
  operator_name VARCHAR(128) DEFAULT NULL,
  operator_context_snapshot TEXT DEFAULT NULL,
  comment TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  INDEX idx_ae_submission (submission_id),
  INDEX idx_ae_submission_time (submission_id, created_at),
  INDEX idx_ae_org (org_id),
  CONSTRAINT fk_ae_submission FOREIGN KEY (submission_id)
    REFERENCES audit_submissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_read_cursors (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hr_id VARCHAR(64) NOT NULL,
  submission_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  last_read_status VARCHAR(32) NOT NULL DEFAULT '',
  last_read_step_index INT NOT NULL DEFAULT -1,
  read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_arc_org_hr_submission (org_id, hr_id, submission_id),
  INDEX idx_arc_org_hr (org_id, hr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  hr_id VARCHAR(64) DEFAULT NULL,
  recipient_type VARCHAR(16) NOT NULL DEFAULT 'user',
  recipient_id VARCHAR(64) NOT NULL DEFAULT '',
  event_key VARCHAR(255) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  type VARCHAR(32) NOT NULL,
  title VARCHAR(256) NOT NULL,
  description VARCHAR(512) DEFAULT NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'audit',
  target_type VARCHAR(32) DEFAULT NULL,
  target_id VARCHAR(64) DEFAULT NULL,
  target_url VARCHAR(512) DEFAULT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notification_org_hr (org_id, hr_id),
  INDEX idx_notification_org_unread (org_id, hr_id, is_read),
  INDEX idx_notification_recipient_unread (org_id, recipient_type, recipient_id, is_read, created_at),
  INDEX idx_notification_recipient_page (org_id, recipient_type, recipient_id, created_at, id),
  INDEX idx_notification_created (created_at),
  UNIQUE INDEX uk_notification_event (org_id, event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  event_key VARCHAR(255) NOT NULL,
  recipient_type VARCHAR(16) DEFAULT NULL,
  recipient_id VARCHAR(64) DEFAULT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME DEFAULT NULL,
  last_error VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_notification_outbox_event (org_id, event_key),
  INDEX idx_notification_outbox_claim (status, available_at, attempts),
  INDEX idx_notification_outbox_done (status, processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_number_sequences (
  org_id VARCHAR(64) NOT NULL,
  business_date DATE NOT NULL,
  next_value INT NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS request_deduplication (
  org_id VARCHAR(64) NOT NULL,
  actor_key VARCHAR(160) NOT NULL,
  operation_type VARCHAR(48) NOT NULL,
  client_request_id VARCHAR(96) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  response_json TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, actor_key, operation_type, client_request_id),
  INDEX idx_rd_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS _shared_cache (
  cache_key VARCHAR(255) NOT NULL PRIMARY KEY,
  cache_data LONGTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 13. 统一身份认证、会话、认领、恢复与安全审计
-- ============================================================

CREATE TABLE IF NOT EXISTS identity_migration_guards (
  guard_key VARCHAR(64) NOT NULL PRIMARY KEY,
  guard_value TINYINT NOT NULL,
  checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_identity_migration_guard CHECK (guard_value = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS persons (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  student_id VARCHAR(32) NOT NULL,
  normalized_student_id VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  merged_into_person_id VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_person_student (normalized_student_id),
  INDEX idx_person_status (status),
  INDEX idx_person_merged_into (merged_into_person_id),
  CONSTRAINT fk_person_merged_into FOREIGN KEY (merged_into_person_id)
    REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS security_rate_limit_buckets (
  bucket_hash CHAR(64) NOT NULL PRIMARY KEY,
  route_key VARCHAR(96) NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 1,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_security_rate_limit_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_temp_uploads (
  file_id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner_hash CHAR(64) NOT NULL,
  organization_id VARCHAR(64) NOT NULL,
  temp_name VARCHAR(160) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_temp_upload_owner (owner_hash, expires_at),
  INDEX idx_audit_temp_upload_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_memberships (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  legacy_hr_id VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  departure_batch_id VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_membership_person_org (person_id, org_id),
  UNIQUE INDEX uk_membership_legacy_hr (legacy_hr_id),
  INDEX idx_membership_org_status (org_id, status),
  CONSTRAINT fk_membership_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS membership_assignments (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  membership_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  assignment_kind VARCHAR(32) NOT NULL DEFAULT 'staff',
  title VARCHAR(200) DEFAULT NULL,
  department_id VARCHAR(64) DEFAULT NULL,
  identity_id VARCHAR(64) DEFAULT NULL,
  work_group_id VARCHAR(64) DEFAULT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  revoked_by_departure_id VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_assignment_membership (membership_id, status),
  INDEX idx_assignment_departure (membership_id, status, revoked_by_departure_id),
  INDEX idx_assignment_org (org_id, status),
  INDEX idx_assignment_rule (org_id, department_id, identity_id, work_group_id),
  CONSTRAINT chk_assignment_active_dimensions CHECK (
    status <> 'active'
    OR (
      NULLIF(TRIM(COALESCE(department_id, '')), '') IS NOT NULL
      AND NULLIF(TRIM(COALESCE(identity_id, '')), '') IS NOT NULL
    )
  ),
  CONSTRAINT fk_assignment_membership FOREIGN KEY (membership_id)
    REFERENCES organization_memberships(id) ON DELETE CASCADE,
  CONSTRAINT fk_ma_department FOREIGN KEY (department_id)
    REFERENCES departments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ma_identity FOREIGN KEY (identity_id)
    REFERENCES identities(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ma_work_group FOREIGN KEY (work_group_id)
    REFERENCES work_groups(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounts (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'verified',
  token_version INT NOT NULL DEFAULT 1,
  verified_at DATETIME DEFAULT NULL,
  recovery_required_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_account_person (person_id),
  INDEX idx_account_status (status),
  CONSTRAINT fk_account_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_wechat_bindings (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  app_id VARCHAR(64) NOT NULL DEFAULT 'whusu-smart-workspace',
  openid_hash CHAR(64) NOT NULL,
  hash_version VARCHAR(24) NOT NULL DEFAULT 'hmac_sha256_v1',
  openid_ciphertext TEXT DEFAULT NULL,
  legacy_openid VARCHAR(128) DEFAULT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  active_openid_hash CHAR(64)
    GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN openid_hash ELSE NULL END) STORED,
  active_account_id VARCHAR(64) DEFAULT NULL,
  bound_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_wechat_account_app (account_id, app_id, status),
  INDEX idx_wechat_openid_hash (app_id, openid_hash, status),
  INDEX idx_wechat_status (status),
  UNIQUE INDEX uk_wechat_active_openid (app_id, active_openid_hash),
  UNIQUE INDEX uk_wechat_active_account (app_id, active_account_id),
  CONSTRAINT chk_wechat_active_account CHECK (
    (status = 'active' AND active_account_id IS NOT NULL AND active_account_id = account_id)
    OR (status <> 'active' AND active_account_id IS NULL)
  ),
  CONSTRAINT fk_wechat_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_grants (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  admin_level VARCHAR(32) NOT NULL DEFAULT 'admin',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  legacy_admin_id VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_admin_grant_person_org (person_id, org_id),
  UNIQUE INDEX uk_admin_grant_legacy (legacy_admin_id),
  INDEX idx_admin_grant_scope (org_id, admin_level, status),
  CONSTRAINT fk_admin_grant_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT,
  CONSTRAINT chk_admin_grant_level CHECK (admin_level IN ('super_admin', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  openid_hash CHAR(64) NOT NULL,
  context_id VARCHAR(160) DEFAULT NULL,
  context_type VARCHAR(24) DEFAULT NULL,
  context_subject_id VARCHAR(64) DEFAULT NULL,
  organization_id VARCHAR(64) DEFAULT NULL,
  role VARCHAR(16) DEFAULT NULL,
  token_version INT NOT NULL,
  binding_mode VARCHAR(24) NOT NULL DEFAULT 'bound',
  openid_ciphertext TEXT DEFAULT NULL,
  device_key_hash CHAR(64) DEFAULT NULL,
  device_platform VARCHAR(24) DEFAULT NULL,
  device_model VARCHAR(96) DEFAULT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  expires_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_auth_session_account (account_id, status),
  INDEX idx_auth_session_device (account_id, device_key_hash, status),
  INDEX idx_auth_session_expiry (expires_at),
  CONSTRAINT fk_auth_session_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_bootstrap_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  openid_hash CHAR(64) NOT NULL,
  openid_ciphertext TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME DEFAULT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_auth_bootstrap_owner (openid_hash, status),
  INDEX idx_auth_bootstrap_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_claim_requests (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  requested_org_id VARCHAR(64) NOT NULL,
  openid_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME DEFAULT NULL,
  verified_at DATETIME DEFAULT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_claim_org_status (requested_org_id, status, created_at),
  INDEX idx_claim_person (person_id, status),
  INDEX idx_claim_openid (openid_hash, status),
  CONSTRAINT fk_claim_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_verification_tokens (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  claim_request_id VARCHAR(64) NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  issued_by_person_id VARCHAR(64) NOT NULL,
  issued_by_context_id VARCHAR(160) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_identity_token_hash (token_hash),
  INDEX idx_identity_token_claim (claim_request_id, status),
  CONSTRAINT fk_identity_token_claim FOREIGN KEY (claim_request_id)
    REFERENCES identity_claim_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_identity_token_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS person_profile_values (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  normalized_label VARCHAR(200) NOT NULL,
  field_label VARCHAR(200) NOT NULL,
  field_type VARCHAR(32) NOT NULL,
  field_value TEXT,
  value_updated_at DATETIME NOT NULL,
  source_org_id VARCHAR(64) DEFAULT NULL,
  source_record_id VARCHAR(64) DEFAULT NULL,
  source_field_id VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_person_profile_value (person_id, normalized_label, field_type),
  INDEX idx_person_profile_person (person_id),
  CONSTRAINT fk_person_profile_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS person_profile_value_history (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  normalized_label VARCHAR(200) NOT NULL,
  field_label VARCHAR(200) NOT NULL,
  field_type VARCHAR(32) NOT NULL,
  field_value TEXT,
  value_updated_at DATETIME NOT NULL,
  source_org_id VARCHAR(64) DEFAULT NULL,
  source_record_id VARCHAR(64) DEFAULT NULL,
  source_field_id VARCHAR(64) DEFAULT NULL,
  resolution VARCHAR(24) NOT NULL DEFAULT 'selected',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_person_profile_history_key (person_id, normalized_label, field_type, value_updated_at),
  CONSTRAINT fk_person_profile_history_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_verification_invites (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  issued_by_person_id VARCHAR(64) NOT NULL,
  issued_by_context_id VARCHAR(160) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME DEFAULT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_identity_invite_code (code_hash),
  INDEX idx_identity_invite_person (person_id, org_id, status),
  INDEX idx_identity_invite_org_status (org_id, status, expires_at),
  CONSTRAINT fk_identity_invite_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_invite_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_recovery_credentials (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  method VARCHAR(24) NOT NULL,
  credential_hash TEXT NOT NULL,
  salt VARCHAR(128) DEFAULT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  used_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uk_recovery_account_method (account_id, method),
  CONSTRAINT fk_recovery_credential_account FOREIGN KEY (account_id)
    REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_recovery_requests (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  requested_org_id VARCHAR(64) NOT NULL,
  new_openid_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  approved_by_person_id VARCHAR(64) DEFAULT NULL,
  approved_by_context_id VARCHAR(160) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_recovery_org_status (requested_org_id, status, created_at),
  INDEX idx_recovery_account (account_id, status),
  CONSTRAINT fk_recovery_request_person FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recovery_request_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_policy (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  initial_claim_enabled TINYINT(1) NOT NULL DEFAULT 1,
  claim_starts_at DATETIME DEFAULT NULL,
  claim_ends_at DATETIME DEFAULT NULL,
  allow_recovery_code TINYINT(1) NOT NULL DEFAULT 0,
  allow_passphrase TINYINT(1) NOT NULL DEFAULT 0,
  passphrase_min_length INT NOT NULL DEFAULT 12,
  updated_by_person_id VARCHAR(64) DEFAULT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO auth_policy (id) VALUES ('default');

CREATE TABLE IF NOT EXISTS auth_audit_events (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  actor_person_id VARCHAR(64) DEFAULT NULL,
  target_person_id VARCHAR(64) DEFAULT NULL,
  account_id VARCHAR(64) DEFAULT NULL,
  organization_id VARCHAR(64) DEFAULT NULL,
  context_id VARCHAR(160) DEFAULT NULL,
  request_id VARCHAR(64) DEFAULT NULL,
  ip_hash CHAR(64) DEFAULT NULL,
  outcome VARCHAR(24) NOT NULL DEFAULT 'success',
  detail_json TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_auth_audit_target (target_person_id, created_at),
  INDEX idx_auth_audit_type (event_type, created_at),
  INDEX idx_auth_audit_org (organization_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS absolute_time_source_registry (
  table_name VARCHAR(64) NOT NULL,
  column_name VARCHAR(64) NOT NULL,
  source_type VARCHAR(48) NOT NULL,
  migration_action VARCHAR(32) NOT NULL,
  evidence VARCHAR(500) NOT NULL,
  primary_key_json JSON DEFAULT NULL,
  snapshot_non_null_count BIGINT NOT NULL DEFAULT 0,
  user_visible TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (table_name, column_name),
  INDEX idx_time_source_action (migration_action, source_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO absolute_time_source_registry
  (table_name, column_name, source_type, migration_action, evidence, primary_key_json, user_visible)
VALUES (
  'score_snapshot_normalization_audits',
  'normalized_at',
  'post_cutover_native_utc',
  'preserve',
  '全新数据库在 UTC 会话中写入评分快照规范化内部审计时间',
  JSON_ARRAY('snapshot_version'),
  0
)
ON DUPLICATE KEY UPDATE table_name = VALUES(table_name);

CREATE TABLE IF NOT EXISTS absolute_time_record_reviews (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  migration_key VARCHAR(64) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  column_name VARCHAR(64) NOT NULL,
  record_hash CHAR(64) NOT NULL,
  record_key VARCHAR(1000) NOT NULL,
  record_locator JSON NOT NULL,
  primary_record_id VARCHAR(191) DEFAULT NULL,
  materialization_token VARCHAR(64) NOT NULL DEFAULT '',
  raw_value DATETIME(3) NOT NULL,
  source_type VARCHAR(48) NOT NULL,
  proof_type VARCHAR(48) NOT NULL DEFAULT 'none',
  proof_reference VARCHAR(500) DEFAULT NULL,
  review_status VARCHAR(32) NOT NULL DEFAULT 'review_required',
  resolved_value DATETIME(3) DEFAULT NULL,
  resolution_note VARCHAR(500) DEFAULT NULL,
  resolved_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX uk_absolute_time_record (migration_key, table_name, column_name, record_hash),
  INDEX idx_absolute_time_record_lookup (table_name, primary_record_id, review_status),
  INDEX idx_absolute_time_record_status (review_status, table_name, column_name),
  INDEX idx_absolute_time_presentation_record (migration_key, review_status, primary_record_id, raw_value),
  INDEX idx_absolute_time_presentation_raw (migration_key, review_status, raw_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS absolute_time_migration_audit (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  migration_key VARCHAR(64) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  column_name VARCHAR(64) NOT NULL,
  source_type VARCHAR(48) NOT NULL,
  normalization_status VARCHAR(32) NOT NULL,
  affected_rows BIGINT NOT NULL DEFAULT 0,
  before_min DATETIME(3) DEFAULT NULL,
  before_max DATETIME(3) DEFAULT NULL,
  after_min DATETIME(3) DEFAULT NULL,
  after_max DATETIME(3) DEFAULT NULL,
  detail_json JSON DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX uk_absolute_time_migration_field (migration_key, table_name, column_name),
  INDEX idx_absolute_time_review (normalization_status, table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS absolute_time_cutovers (
  migration_key VARCHAR(64) NOT NULL PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  snapshot_started_at DATETIME(3) NOT NULL,
  materialized_at DATETIME(3) DEFAULT NULL,
  verified_at DATETIME(3) DEFAULT NULL,
  detail_json JSON DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO absolute_time_cutovers
  (migration_key, status, snapshot_started_at, materialized_at, verified_at, detail_json)
VALUES (
  '20260823190000', 'verified', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
  JSON_OBJECT(
    'automaticOffsetMinutes', 0,
    'policy', 'fresh_schema_utc',
    'reviewRecordCount', 0,
    'verifiedRecordCount', 0,
    'unresolvedReviewCount', 0
  )
)
ON DUPLICATE KEY UPDATE migration_key = VALUES(migration_key);

-- 新版密码凭证只从真实新操作写入，不为历史动作补造身份声明。
CREATE TABLE IF NOT EXISTS audit_signing_certificates (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  key_version VARCHAR(32) NOT NULL,
  certificate_fingerprint VARCHAR(64) NOT NULL,
  certificate_pem TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_evidence_certificate (org_id, key_version),
  INDEX idx_evidence_certificate_scope (org_id, certificate_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_signing_evidence (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  submission_id VARCHAR(64) NOT NULL,
  step_id VARCHAR(64) NOT NULL,
  step_index INT NOT NULL,
  round INT NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  file_id VARCHAR(64) NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  assignment_id VARCHAR(64) NOT NULL,
  action_type VARCHAR(16) NOT NULL,
  key_version VARCHAR(32) NOT NULL,
  certificate_fingerprint VARCHAR(64) NOT NULL,
  identity_ciphertext TEXT NOT NULL,
  payload_json JSON NOT NULL,
  cms_base64 MEDIUMTEXT NOT NULL,
  receipt_digest VARCHAR(64) NOT NULL,
  previous_digest VARCHAR(64) NOT NULL DEFAULT '',
  input_digest VARCHAR(64) NOT NULL,
  output_digest VARCHAR(64) NOT NULL,
  output_digest_type VARCHAR(32) NOT NULL,
  final_file_digest VARCHAR(64) NOT NULL,
  input_file_path VARCHAR(1000) NOT NULL,
  output_file_path VARCHAR(1000) NOT NULL,
  legacy_prefix TINYINT(1) NOT NULL DEFAULT 0,
  signed_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_evidence_step_file (org_id, step_id, file_id),
  INDEX idx_evidence_file_round (org_id, file_id, round, step_index),
  INDEX idx_evidence_submission (org_id, submission_id),
  INDEX idx_evidence_person (org_id, person_id),
  CONSTRAINT fk_evidence_submission FOREIGN KEY (submission_id) REFERENCES audit_submissions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_evidence_file FOREIGN KEY (file_id) REFERENCES audit_submission_files(id) ON DELETE RESTRICT,
  CONSTRAINT fk_evidence_step FOREIGN KEY (step_id) REFERENCES audit_submission_steps(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
