-- 印章仅在所属组织内按自然人和具体岗位授权；旧身份类别授权保留但不再放行。
CREATE TABLE IF NOT EXISTS stamp_assignment_grants (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  stamp_id VARCHAR(64) NOT NULL,
  assignment_id VARCHAR(64) NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_stamp_assignment (org_id, stamp_id, assignment_id),
  KEY idx_stamp_grant_assignment (assignment_id),
  KEY idx_stamp_grant_person (person_id, org_id),
  CONSTRAINT fk_stamp_grant_stamp FOREIGN KEY (stamp_id) REFERENCES stamps(id) ON DELETE CASCADE,
  CONSTRAINT fk_stamp_grant_assignment FOREIGN KEY (assignment_id) REFERENCES membership_assignments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
