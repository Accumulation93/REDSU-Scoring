const { generateId, safeString } = require('../../utils/helpers');
const { decryptOpenid } = require('../services/identityCrypto');
const { createHash } = require('crypto');
const { usableLoginCredentialSql } = require('./accountLoginState');

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(safeString).filter(Boolean))];
}

function csvValues(value) {
  return uniqueStrings(safeString(value).split(','));
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function personReferenceWhere(target, options) {
  const config = options || {};
  const parts = [];
  const params = [];
  const personId = safeString(target.personId);
  const legacyHrIds = uniqueStrings(target.legacyHrIds);
  const assignmentIds = uniqueStrings(target.assignmentIds);
  const adminGrantIds = uniqueStrings(target.adminGrantIds);
  const legacyAdminIds = uniqueStrings(target.legacyAdminIds);

  (config.personColumns || []).forEach((column) => {
    if (!personId) return;
    parts.push(`${column} = ?`);
    params.push(personId);
  });
  (config.hrColumns || []).forEach((column) => {
    if (!legacyHrIds.length) return;
    parts.push(`${column} IN (${placeholders(legacyHrIds)})`);
    params.push(...legacyHrIds);
  });
  (config.assignmentColumns || []).forEach((column) => {
    if (!assignmentIds.length) return;
    parts.push(`${column} IN (${placeholders(assignmentIds)})`);
    params.push(...assignmentIds);
  });
  (config.adminGrantColumns || []).forEach((column) => {
    if (!adminGrantIds.length) return;
    parts.push(`${column} IN (${placeholders(adminGrantIds)})`);
    params.push(...adminGrantIds);
  });
  (config.legacyAdminColumns || []).forEach((column) => {
    if (!legacyAdminIds.length) return;
    parts.push(`${column} IN (${placeholders(legacyAdminIds)})`);
    params.push(...legacyAdminIds);
  });
  const textReferenceIds = uniqueStrings([personId].concat(legacyHrIds, assignmentIds));
  (config.textColumns || []).forEach((column) => {
    textReferenceIds.forEach((referenceId) => {
      parts.push(`LOCATE(?, COALESCE(${column}, '')) > 0`);
      params.push(referenceId);
    });
  });
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0 = 1', params };
}

function addOrgScope(target, sql, params, columns) {
  if (!safeString(target.organizationId)) return { sql, params };
  const orgColumns = Array.isArray(columns) && columns.length ? columns : ['org_id'];
  return {
    sql: `(${sql}) AND (${orgColumns.map((column) => `${column} = ?`).join(' OR ')})`,
    params: params.concat(orgColumns.map(() => safeString(target.organizationId)))
  };
}

const BUSINESS_REFERENCES = [
  {
    category: 'scoring_records',
    table: 'score_records',
    columns: {
      personColumns: ['scorer_person_id', 'target_person_id'],
      hrColumns: ['scorer_id', 'target_id'],
      assignmentColumns: ['scorer_assignment_id', 'target_assignment_id'],
      textColumns: ['scorer_context_snapshot', 'target_context_snapshot']
    }
  },
  {
    category: 'scoring_designations',
    table: 'merit_list_designations',
    customScanner: 'scoring_designations',
    columns: {
      personColumns: ['designated_by_person_id'],
      hrColumns: ['target_hr_id'],
      assignmentColumns: ['target_assignment_id', 'designated_by_assignment_id'],
      legacyAdminColumns: ['designated_by'],
      textColumns: ['target_context_snapshot', 'designated_by_context_snapshot']
    }
  },
  {
    category: 'audit_submissions',
    table: 'audit_submissions',
    columns: {
      personColumns: ['submitted_person_id'],
      hrColumns: ['submitted_by'],
      assignmentColumns: ['submitted_assignment_id'],
      textColumns: ['submitted_context_snapshot']
    }
  },
  {
    category: 'audit_steps',
    table: 'audit_submission_steps',
    columns: {
      personColumns: ['processed_person_id'],
      hrColumns: ['approver_hr_id'],
      assignmentColumns: ['processed_assignment_id'],
      textColumns: ['step_conditions_json', 'processed_context_snapshot']
    }
  },
  {
    category: 'audit_signatures',
    table: 'audit_submission_signatures',
    columns: { hrColumns: ['signer_hr_id'] }
  },
  {
    category: 'audit_events',
    table: 'audit_events',
    columns: {
      personColumns: ['operator_person_id'],
      hrColumns: ['operator_hr_id'],
      assignmentColumns: ['operator_assignment_id'],
      textColumns: ['operator_context_snapshot']
    }
  },
  {
    category: 'venue_bookings',
    table: 'venue_bookings',
    organizationScopedReferences: [
      {
        orgColumn: 'creator_org_id',
        columns: {
          personColumns: ['creator_person_id'],
          hrColumns: ['user_hr_id'],
          assignmentColumns: ['creator_assignment_id'],
          adminGrantColumns: ['creator_admin_grant_id'],
          legacyAdminColumns: ['creator_admin_id'],
          textColumns: ['creator_context_snapshot']
        }
      },
      {
        orgColumn: 'approval_org_id',
        columns: {
          personColumns: ['approver_person_id'],
          hrColumns: ['approver_hr_id'],
          assignmentColumns: ['approver_assignment_id'],
          adminGrantColumns: ['approver_admin_grant_id'],
          textColumns: [
            'approver_context_snapshot',
            'approval_flow_state_json',
            'approval_snapshots_json'
          ]
        }
      }
    ],
    columns: {
      personColumns: ['creator_person_id', 'approver_person_id'],
      hrColumns: ['user_hr_id', 'approver_hr_id'],
      assignmentColumns: ['creator_assignment_id', 'approver_assignment_id'],
      adminGrantColumns: ['creator_admin_grant_id', 'approver_admin_grant_id'],
      legacyAdminColumns: ['creator_admin_id'],
      textColumns: [
        'creator_context_snapshot',
        'approver_context_snapshot',
        'approval_flow_state_json',
        'approval_snapshots_json'
      ]
    }
  }
];

async function getTargetByLegacyHrId(connection, legacyHrId, organizationId, lock) {
  const [rows] = await connection.query(
    `SELECT p.id AS person_id, p.name, p.student_id, p.normalized_student_id,
            p.status AS person_status, p.created_at AS person_created_at,
            p.updated_at AS person_updated_at,
            om.id AS membership_id, om.org_id, om.legacy_hr_id,
            om.status AS membership_status, om.created_at AS membership_created_at,
            om.updated_at AS membership_updated_at,
            a.id AS account_id, a.status AS account_status, a.updated_at AS account_updated_at
       FROM organization_memberships om
       JOIN persons p ON p.id = om.person_id
       LEFT JOIN accounts a ON a.person_id = p.id
      WHERE om.legacy_hr_id = ? AND om.org_id = ?
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [safeString(legacyHrId), safeString(organizationId)]
  );
  return rows[0] || null;
}

async function getTargetByPersonId(connection, personId, lock) {
  const [rows] = await connection.query(
    `SELECT p.id AS person_id, p.name, p.student_id, p.normalized_student_id,
            p.status AS person_status, p.created_at AS person_created_at,
            p.updated_at AS person_updated_at,
            a.id AS account_id, a.status AS account_status, a.updated_at AS account_updated_at
       FROM persons p
       LEFT JOIN accounts a ON a.person_id = p.id
      WHERE p.id = ?
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [safeString(personId)]
  );
  return rows[0] || null;
}

async function lockPersonDeletionBarrier(connection, personId) {
  const [rows] = await connection.query(
    'SELECT id FROM persons WHERE id = ? AND status = \'active\' LIMIT 1 FOR UPDATE',
    [safeString(personId)]
  );
  return Boolean(rows[0]);
}

async function listMemberships(connection, personId, lock) {
  const [rows] = await connection.query(
    `SELECT om.id, om.person_id, om.org_id, om.legacy_hr_id, om.status,
            om.created_at, om.updated_at,
            o.name AS organization_name
       FROM organization_memberships om
       LEFT JOIN organizations o ON o.id = om.org_id
      WHERE om.person_id = ?
      ORDER BY om.org_id${lock ? ' FOR UPDATE' : ''}`,
    [safeString(personId)]
  );
  return rows;
}

async function listAssignments(connection, membershipIds, lock) {
  const ids = uniqueStrings(membershipIds);
  if (!ids.length) return [];
  const [rows] = await connection.query(
    `SELECT id, membership_id, org_id, status, updated_at
       FROM membership_assignments
      WHERE membership_id IN (${placeholders(ids)})
      ORDER BY membership_id, id${lock ? ' FOR UPDATE' : ''}`,
    ids
  );
  return rows;
}

async function listAdminReferences(connection, personId, organizationId, lock) {
  const orgId = safeString(organizationId);
  const [rows] = await connection.query(
    `SELECT id, legacy_admin_id, org_id, status, updated_at
       FROM admin_grants
      WHERE person_id = ? AND (? = '' OR org_id = ?)
      ORDER BY org_id, id${lock ? ' FOR UPDATE' : ''}`,
    [safeString(personId), orgId, orgId]
  );
  return rows;
}

async function listPersonOpenidReferences(connection, accountId, lock) {
  const id = safeString(accountId);
  if (!id) return [];
  const [rows] = await connection.query(
    `SELECT openid_hash, hash_version, openid_ciphertext, legacy_openid
       FROM account_wechat_bindings
      WHERE account_id = ?
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return uniqueStrings(rows.map((row) => {
    if (safeString(row.openid_ciphertext)) return decryptOpenid(row.openid_ciphertext);
    return safeString(row.legacy_openid);
  }));
}

function buildTargetScope(person, memberships, assignments, organizationId) {
  const orgId = safeString(organizationId);
  const scopedMemberships = orgId
    ? memberships.filter((item) => safeString(item.org_id) === orgId)
    : memberships;
  const membershipIds = new Set(scopedMemberships.map((item) => safeString(item.id)));
  const scopedAssignments = assignments.filter((item) => membershipIds.has(safeString(item.membership_id)));
  return {
    personId: safeString(person.person_id),
    accountId: safeString(person.account_id),
    organizationId: orgId,
    organizationIds: uniqueStrings(scopedMemberships.map((item) => safeString(item.org_id))),
    legacyHrIds: scopedMemberships.map((item) => safeString(item.legacy_hr_id)),
    assignmentIds: scopedAssignments.map((item) => safeString(item.id))
  };
}

async function scanScoringDesignationReferences(connection, target, lock) {
  const reference = personReferenceWhere(target, {
    personColumns: ['designated_by_person_id'],
    hrColumns: ['target_hr_id'],
    assignmentColumns: ['target_assignment_id', 'designated_by_assignment_id'],
    legacyAdminColumns: ['designated_by'],
    textColumns: ['target_context_snapshot', 'designated_by_context_snapshot']
  });
  const parts = [reference.sql];
  const params = reference.params.slice();
  const legacyOpenids = uniqueStrings(target.legacyOpenids);
  if (legacyOpenids.length) {
    parts.push(`designated_by IN (${placeholders(legacyOpenids)})`);
    params.push(...legacyOpenids);
  }
  const scoped = addOrgScope(target, `(${parts.join(' OR ')})`, params);
  const [rows] = await connection.query(
    `SELECT id FROM merit_list_designations
      WHERE ${scoped.sql}
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    scoped.params
  );
  return { category: 'scoring_designations', count: rows.length };
}

async function scanReference(connection, target, definition, lock) {
  let scoped;
  if (Array.isArray(definition.organizationScopedReferences)) {
    const branches = [];
    const params = [];
    definition.organizationScopedReferences.forEach((entry) => {
      const reference = personReferenceWhere(target, entry.columns);
      if (safeString(target.organizationId)) {
        branches.push(`(${entry.orgColumn} = ? AND ${reference.sql})`);
        params.push(safeString(target.organizationId), ...reference.params);
      } else {
        branches.push(reference.sql);
        params.push(...reference.params);
      }
    });
    scoped = { sql: `(${branches.join(' OR ')})`, params };
  } else {
    const reference = personReferenceWhere(target, definition.columns);
    scoped = addOrgScope(target, reference.sql, reference.params, definition.orgColumns);
  }
  const [rows] = await connection.query(
    `SELECT id FROM ${definition.table}
      WHERE ${scoped.sql}
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    scoped.params
  );
  return {
    category: definition.category,
    count: rows.length
  };
}

async function scanProfileReviewReferences(connection, target, lock) {
  const hrIds = uniqueStrings(target.legacyHrIds);
  const conditions = [];
  const params = [];
  if (hrIds.length) {
    conditions.push(`record.hr_id IN (${placeholders(hrIds)})`);
    params.push(...hrIds);
  }
  if (safeString(target.personId)) {
    conditions.push('event.reviewer_person_id = ?');
    params.push(safeString(target.personId));
  }
  let where = conditions.length ? `(${conditions.join(' OR ')})` : '0 = 1';
  const organizationId = safeString(target.organizationId);
  params.push(organizationId, organizationId);
  const [rows] = await connection.query(
    `SELECT event.id
       FROM hr_profile_review_events event
       JOIN hr_profile_records record ON record.id = event.record_id
      WHERE (${where}) AND (? = '' OR event.org_id = ?)
      ORDER BY event.id${lock ? ' FOR UPDATE' : ''}`,
    params
  );
  return {
    category: 'profile_review_history',
    count: rows.length
  };
}

async function scanReviewedProfileReferences(connection, target, lock) {
  const hrIds = uniqueStrings(target.legacyHrIds);
  if (!hrIds.length) return { category: 'reviewed_profile_records', count: 0 };
  const organizationId = safeString(target.organizationId);
  const [rows] = await connection.query(
    `SELECT id
       FROM hr_profile_records
      WHERE hr_id IN (${placeholders(hrIds)})
        AND (? = '' OR org_id = ?)
        AND (audit_status IN ('approved', 'rejected') OR reviewed_at IS NOT NULL)
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [...hrIds, organizationId, organizationId]
  );
  return { category: 'reviewed_profile_records', count: rows.length };
}

async function scanMergedPersonReferences(connection, target, lock) {
  if (safeString(target.organizationId)) return null;
  const [rows] = await connection.query(
    `SELECT id FROM persons WHERE merged_into_person_id = ? ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [safeString(target.personId)]
  );
  return {
    category: 'merged_person_history',
    count: rows.length
  };
}

async function scanBusinessBlockers(connection, target, lock) {
  const blockers = [];
  for (const definition of BUSINESS_REFERENCES) {
    const result = definition.customScanner === 'scoring_designations'
      ? await scanScoringDesignationReferences(connection, target, lock)
      : await scanReference(connection, target, definition, lock);
    if (result.count) blockers.push(result);
  }
  const profileReview = await scanProfileReviewReferences(connection, target, lock);
  if (profileReview.count) blockers.push(profileReview);
  const reviewedProfiles = await scanReviewedProfileReferences(connection, target, lock);
  if (reviewedProfiles.count) blockers.push(reviewedProfiles);
  const mergedReference = await scanMergedPersonReferences(connection, target, lock);
  if (mergedReference && mergedReference.count) blockers.push(mergedReference);
  return blockers;
}

async function countRows(connection, sql, params) {
  const [rows] = await connection.query(sql, params || []);
  return Number(rows[0] && rows[0].count || 0);
}

async function scanCleanupImpact(connection, target) {
  const orgId = safeString(target.organizationId);
  const personId = safeString(target.personId);
  const hrIds = uniqueStrings(target.legacyHrIds);
  const assignmentIds = uniqueStrings(target.assignmentIds);
  const legacyAdminIds = uniqueStrings(target.legacyAdminIds);
  const impact = [];
  const add = (category, count) => {
    if (count) impact.push({ category, count });
  };

  if (hrIds.length) {
    const inSql = placeholders(hrIds);
    const scopedParams = hrIds.concat([orgId, orgId]);
    add('legacy_hr_records', await countRows(connection,
      `SELECT COUNT(*) AS count FROM hr_info WHERE id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
    add('profile_records', await countRows(connection,
      `SELECT COUNT(*) AS count FROM hr_profile_records WHERE hr_id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
    add('profile_values', await countRows(connection,
      `SELECT COUNT(*) AS count
         FROM hr_profile_record_values value_row
         JOIN hr_profile_records record_row ON record_row.id = value_row.record_id
        WHERE record_row.hr_id IN (${inSql}) AND (? = '' OR record_row.org_id = ?)`, scopedParams));
    add('signature_templates', await countRows(connection,
      `SELECT COUNT(*) AS count FROM signature_templates WHERE hr_id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
    add('notifications', await countRows(connection,
      `SELECT COUNT(*) AS count FROM notifications
        WHERE (hr_id IN (${inSql}) OR recipient_id IN (${inSql})) AND (? = '' OR org_id = ?)`,
      [...hrIds, ...hrIds, orgId, orgId]));
    add('notification_outbox', await countRows(connection,
      `SELECT COUNT(*) AS count FROM notification_outbox
        WHERE recipient_id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
    add('audit_read_cursors', await countRows(connection,
      `SELECT COUNT(*) AS count FROM audit_read_cursors WHERE hr_id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
    add('audit_verification_permissions', await countRows(connection,
      `SELECT COUNT(*) AS count FROM audit_verification_permissions
        WHERE grantee_hr_id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
    add('legacy_user_bindings', await countRows(connection,
      `SELECT COUNT(*) AS count FROM user_info WHERE hr_id IN (${inSql}) AND (? = '' OR org_id = ?)`, scopedParams));
  }

  add('global_profile_values', await countRows(connection,
    `SELECT COUNT(*) AS count FROM person_profile_values
      WHERE person_id = ? AND (? = '' OR source_org_id = ?)`, [personId, orgId, orgId]));
  add('stamp_assignment_grants', await countRows(connection,
    `SELECT COUNT(*) AS count FROM stamp_assignment_grants WHERE person_id = ? AND (? = '' OR org_id = ?)`,
    [personId, orgId, orgId]));
  add('global_profile_history', await countRows(connection,
    `SELECT COUNT(*) AS count FROM person_profile_value_history
      WHERE person_id = ? AND (? = '' OR source_org_id = ?)`, [personId, orgId, orgId]));

  add('admin_grants', await countRows(connection,
    `SELECT COUNT(*) AS count FROM admin_grants WHERE person_id = ? AND (? = '' OR org_id = ?)`,
    [personId, orgId, orgId]));
  if (legacyAdminIds.length) {
    add('legacy_admin_records', await countRows(connection,
      `SELECT COUNT(*) AS count FROM admin_info
        WHERE id IN (${placeholders(legacyAdminIds)}) AND (? = '' OR org_id = ?)`,
      [...legacyAdminIds, orgId, orgId]));
    add('admin_permission_overrides', await countRows(connection,
      `SELECT COUNT(*) AS count FROM admin_permission_overrides
        WHERE admin_id IN (${placeholders(legacyAdminIds)}) AND (? = '' OR org_id = ?)`,
      [...legacyAdminIds, orgId, orgId]));
    if (!orgId) add('admin_permission_override_issuers_redacted', await countRows(connection,
      `SELECT COUNT(*) AS count FROM admin_permission_overrides
        WHERE configured_by IN (${placeholders(legacyAdminIds)}) AND (? = '' OR org_id = ?)`,
      [...legacyAdminIds, orgId, orgId]));
    if (!orgId) add('admin_permission_audit_redacted', await countRows(connection,
      `SELECT COUNT(*) AS count FROM admin_permission_audit_logs
        WHERE (operator_admin_id IN (${placeholders(legacyAdminIds)})
           OR target_admin_id IN (${placeholders(legacyAdminIds)}))
          AND (? = '' OR org_id = ?)`,
      [...legacyAdminIds, ...legacyAdminIds, orgId, orgId]));
  }

  add('identity_invites_for_member', await countRows(connection,
    `SELECT COUNT(*) AS count FROM identity_verification_invites WHERE person_id = ?${orgId ? ' AND org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('active_identity_invites_issued', await countRows(connection,
    `SELECT COUNT(*) AS count FROM identity_verification_invites
      WHERE issued_by_person_id = ? AND status = 'active'${orgId ? ' AND org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('active_identity_tokens_issued', await countRows(connection,
    `SELECT COUNT(*) AS count
       FROM identity_verification_tokens token_row
       JOIN identity_claim_requests claim_row ON claim_row.id = token_row.claim_request_id
      WHERE token_row.issued_by_person_id = ? AND token_row.status = 'active'
        ${orgId ? 'AND claim_row.requested_org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('identity_tokens_for_member_claims', await countRows(connection,
    `SELECT COUNT(*) AS count
       FROM identity_verification_tokens token_row
       JOIN identity_claim_requests claim_row ON claim_row.id = token_row.claim_request_id
      WHERE claim_row.person_id = ?${orgId ? ' AND claim_row.requested_org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('identity_claims', await countRows(connection,
    `SELECT COUNT(*) AS count FROM identity_claim_requests
      WHERE person_id = ?${orgId ? ' AND requested_org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('account_recovery_requests', await countRows(connection,
    `SELECT COUNT(*) AS count FROM account_recovery_requests
      WHERE person_id = ?${orgId ? ' AND requested_org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('account_recovery_approvals', await countRows(connection,
    `SELECT COUNT(*) AS count FROM account_recovery_requests
      WHERE approved_by_person_id = ?${orgId ? ' AND requested_org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  add('auth_sessions', await countRows(connection,
    `SELECT COUNT(*) AS count
       FROM auth_sessions session_row
       JOIN accounts account_row ON account_row.id = session_row.account_id
      WHERE account_row.person_id = ?${orgId ? ' AND session_row.organization_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));

  if (assignmentIds.length) {
    add('assignments', assignmentIds.length);
  }
  add('memberships', await countRows(connection,
    `SELECT COUNT(*) AS count FROM organization_memberships
      WHERE person_id = ?${orgId ? ' AND org_id = ?' : ''}`,
    orgId ? [personId, orgId] : [personId]));
  const cacheOrganizationIds = uniqueStrings(orgId ? [orgId] : target.organizationIds);
  if (cacheOrganizationIds.length) {
    const cacheClauses = [];
    const cacheParams = [];
    cacheOrganizationIds.forEach((organizationId) => {
      cacheClauses.push('(cache_key LIKE ? OR cache_key LIKE ?)');
      cacheParams.push(`overview_${organizationId}_%`, `pubCache:%:${organizationId}`);
    });
    add('scoring_caches', await countRows(connection,
      `SELECT COUNT(*) AS count FROM _shared_cache WHERE ${cacheClauses.join(' OR ')}`,
      cacheParams));
  }

  if (!orgId) {
    add('accounts', await countRows(connection,
      'SELECT COUNT(*) AS count FROM accounts WHERE person_id = ?', [personId]));
    add('wechat_bindings', await countRows(connection,
      `SELECT COUNT(*) AS count FROM account_wechat_bindings binding_row
        JOIN accounts account_row ON account_row.id = binding_row.account_id
       WHERE account_row.person_id = ?`, [personId]));
    add('recovery_credentials', await countRows(connection,
      `SELECT COUNT(*) AS count FROM account_recovery_credentials credential_row
        JOIN accounts account_row ON account_row.id = credential_row.account_id
       WHERE account_row.person_id = ?`, [personId]));
    add('auth_audit_events_redacted', await countRows(connection,
      `SELECT COUNT(*) AS count FROM auth_audit_events
        WHERE actor_person_id = ? OR target_person_id = ?
           OR account_id IN (SELECT id FROM accounts WHERE person_id = ?)`,
      [personId, personId, personId]));
    const migrationAuditIds = uniqueStrings([personId].concat(hrIds, assignmentIds));
    if (migrationAuditIds.length) {
      const clauses = migrationAuditIds.map(() => (
        '(record_id = ? OR LOCATE(?, COALESCE(CAST(detail_json AS CHAR), \'\')) > 0)'
      ));
      const params = [];
      migrationAuditIds.forEach((id) => params.push(id, id));
      add('personnel_migration_audit_redacted', await countRows(connection,
        `SELECT COUNT(*) AS count FROM personnel_migration_audit WHERE ${clauses.join(' OR ')}`,
        params));
    }
    add('persons', await countRows(connection,
      'SELECT COUNT(*) AS count FROM persons WHERE id = ?', [personId]));
  }
  return impact;
}

function removePairedReferences(personValue, assignmentValue, targetHrIds, targetAssignmentIds) {
  // person_hr_ids 与 assignment_ids 是分别去重保存的候选集合，不是位置一一对应的数组。
  // 删除时必须分别做集合差集，否则同一人员多岗位时会误删其他人员的合法岗位。
  const keptPeople = csvValues(personValue).filter((person) => !targetHrIds.has(person));
  const keptAssignments = csvValues(assignmentValue)
    .filter((assignment) => !targetAssignmentIds.has(assignment));
  return {
    people: uniqueStrings(keptPeople),
    assignments: uniqueStrings(keptAssignments)
  };
}

function removePersonFromStarterJson(value, targetHrIds, targetAssignmentIds) {
  let source;
  try { source = JSON.parse(safeString(value) || '[]'); } catch (_) {
    return { value, changed: false, personCount: 0, candidateCount: 0 };
  }
  let changed = false;
  let personCount = 0;
  let candidateCount = 0;

  function visit(node) {
    if (Array.isArray(node)) {
      const next = node.map(visit).filter((item) => item !== null);
      if (next.length !== node.length) changed = true;
      return next;
    }
    if (!node || typeof node !== 'object') return node;
    const next = Object.assign({}, node);
    const personKey = Object.prototype.hasOwnProperty.call(next, 'personHrIds')
      ? 'personHrIds' : (Object.prototype.hasOwnProperty.call(next, 'person_hr_ids') ? 'person_hr_ids' : '');
    const assignmentKey = Object.prototype.hasOwnProperty.call(next, 'assignmentIds')
      ? 'assignmentIds' : (Object.prototype.hasOwnProperty.call(next, 'assignment_ids') ? 'assignment_ids' : '');
    if (personKey || assignmentKey) {
      const personSource = Array.isArray(next[personKey]) ? next[personKey].join(',') : next[personKey];
      const assignmentSource = Array.isArray(next[assignmentKey]) ? next[assignmentKey].join(',') : next[assignmentKey];
      const filtered = removePairedReferences(
        personSource,
        assignmentSource,
        targetHrIds,
        targetAssignmentIds
      );
      personCount += filtered.people.length;
      candidateCount += assignmentKey
        ? (filtered.people.length && filtered.assignments.length ? filtered.assignments.length : 0)
        : filtered.people.length;
      if (personKey) {
        const replacement = Array.isArray(next[personKey]) ? filtered.people : filtered.people.join(',');
        if (JSON.stringify(replacement) !== JSON.stringify(next[personKey])) changed = true;
        next[personKey] = replacement;
      }
      if (assignmentKey) {
        const replacement = Array.isArray(next[assignmentKey]) ? filtered.assignments : filtered.assignments.join(',');
        if (JSON.stringify(replacement) !== JSON.stringify(next[assignmentKey])) changed = true;
        next[assignmentKey] = replacement;
      }
      const conditionType = safeString(next.conditionType || next.condition_type || next.type);
      if ((conditionType === 'person' || conditionType === 'specific_person') && !filtered.people.length) {
        changed = true;
        return null;
      }
    }
    Object.keys(next).forEach((key) => {
      if (key === personKey || key === assignmentKey) return;
      next[key] = visit(next[key]);
    });
    return next;
  }

  const next = visit(source);
  return { value: JSON.stringify(next || []), changed, personCount, candidateCount };
}

function collectPersonCandidateGroups(value) {
  let source;
  try { source = typeof value === 'string' ? JSON.parse(value || '[]') : value; } catch (_) { return []; }
  const groups = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const conditionType = safeString(node.conditionType || node.condition_type || node.type);
    const people = csvValues(node.personHrIds || node.person_hr_ids);
    const assignments = csvValues(node.assignmentIds || node.assignment_ids);
    if ((conditionType === 'person' || conditionType === 'specific_person') && people.length) {
      groups.push({ people, assignments, requireAssignmentMatch: assignments.length > 0 });
    }
    Object.keys(node).forEach((key) => {
      if (['personHrIds', 'person_hr_ids', 'assignmentIds', 'assignment_ids'].includes(key)) return;
      visit(node[key]);
    });
  };
  visit(source);
  return groups;
}

async function hasActivePersonCandidate(connection, organizationId, people, assignments, lock) {
  const personIds = uniqueStrings(people);
  const assignmentIds = uniqueStrings(assignments);
  if (!safeString(organizationId) || !personIds.length) return false;
  const params = [safeString(organizationId), ...personIds];
  let assignmentFilter = '';
  if (assignmentIds.length) {
    assignmentFilter = ` AND assignment_row.id IN (${placeholders(assignmentIds)})`;
    params.push(...assignmentIds);
  }
  const [rows] = await connection.query(
    `SELECT membership_row.id
       FROM organization_memberships membership_row
       JOIN membership_assignments assignment_row
         ON assignment_row.membership_id = membership_row.id
        AND assignment_row.org_id = membership_row.org_id
        AND assignment_row.status = 'active'
      WHERE membership_row.org_id = ? AND membership_row.status = 'active'
        AND membership_row.legacy_hr_id IN (${placeholders(personIds)})${assignmentFilter}
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    params
  );
  return Boolean(rows[0]);
}

async function hasActiveCandidateGroup(connection, organizationId, group, lock) {
  const people = uniqueStrings(group && group.people);
  const assignments = uniqueStrings(group && group.assignments);
  if (group && group.requireAssignmentMatch && !assignments.length) return false;
  return hasActivePersonCandidate(connection, organizationId, people, assignments, lock);
}

async function hasAnyActiveCandidateGroup(connection, organizationId, groups, lock) {
  for (const group of Array.isArray(groups) ? groups : []) {
    if (await hasActiveCandidateGroup(connection, organizationId, group, lock)) return true;
  }
  return false;
}

async function hasActiveAuditStepCandidate(connection, organizationId, stepId, directPeople, lock) {
  if (await hasActivePersonCandidate(connection, organizationId, directPeople, [], lock)) return true;
  const [conditionRows] = await connection.query(
    `SELECT person_hr_ids, assignment_ids
       FROM audit_flow_template_step_conditions
      WHERE template_step_id = ? AND org_id = ? AND condition_type = 'person'${lock ? ' FOR UPDATE' : ''}`,
    [safeString(stepId), safeString(organizationId)]
  );
  return hasAnyActiveCandidateGroup(connection, organizationId, conditionRows.map((row) => ({
    people: csvValues(row.person_hr_ids),
    assignments: csvValues(row.assignment_ids),
    requireAssignmentMatch: true
  })), lock);
}

async function cleanupAuditTemplateReferences(connection, target) {
  const orgId = safeString(target.organizationId);
  const targetHrIds = new Set(uniqueStrings(target.legacyHrIds));
  const targetAssignmentIds = new Set(uniqueStrings(target.assignmentIds));
  const disabled = [];
  if (!orgId || (!targetHrIds.size && !targetAssignmentIds.size)) return disabled;

  const [conditions] = await connection.query(
    `SELECT condition_row.id, condition_row.template_step_id, condition_row.person_hr_ids,
            condition_row.assignment_ids, step_row.template_id,
            step_row.name AS step_name, step_row.sort_order,
            template_row.name AS template_name
       FROM audit_flow_template_step_conditions condition_row
       JOIN audit_flow_template_steps step_row ON step_row.id = condition_row.template_step_id
       JOIN audit_flow_templates template_row ON template_row.id = step_row.template_id
      WHERE condition_row.org_id = ? AND condition_row.condition_type = 'person'
      FOR UPDATE`,
    [orgId]
  );
  const affectedStepIds = new Set();
  for (const row of conditions) {
    const filtered = removePairedReferences(
      row.person_hr_ids,
      row.assignment_ids,
      targetHrIds,
      targetAssignmentIds
    );
    if (filtered.people.join(',') === csvValues(row.person_hr_ids).join(',')
      && filtered.assignments.join(',') === csvValues(row.assignment_ids).join(',')) continue;
    affectedStepIds.add(safeString(row.template_step_id));
    if (!filtered.people.length || !filtered.assignments.length) {
      await connection.query('DELETE FROM audit_flow_template_step_conditions WHERE id = ? AND org_id = ?', [row.id, orgId]);
    } else {
      await connection.query(
        `UPDATE audit_flow_template_step_conditions
            SET person_hr_ids = ?, assignment_ids = ?, updated_at = NOW()
          WHERE id = ? AND org_id = ?`,
        [filtered.people.join(','), filtered.assignments.join(','), row.id, orgId]
      );
    }
  }

  const [steps] = await connection.query(
    `SELECT id, template_id, approver_type, approver_hr_id
       FROM audit_flow_template_steps
      WHERE org_id = ?
      FOR UPDATE`,
    [orgId]
  );
  for (const step of steps) {
    const currentPeople = csvValues(step.approver_hr_id);
    const remaining = currentPeople.filter((id) => !targetHrIds.has(id));
    const directChanged = remaining.length !== currentPeople.length;
    if (directChanged) {
      affectedStepIds.add(safeString(step.id));
      await connection.query(
        'UPDATE audit_flow_template_steps SET approver_hr_id = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
        [remaining.join(',') || null, step.id, orgId]
      );
    }
    if (safeString(step.approver_type) !== 'person' || !affectedStepIds.has(safeString(step.id))) continue;
    if (await hasActiveAuditStepCandidate(connection, orgId, step.id, remaining, true)) continue;
    await connection.query(
      'UPDATE audit_flow_templates SET is_active = 0, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [step.template_id, orgId]
    );
    disabled.push({ type: 'audit_template', id: safeString(step.template_id) });
  }

  const [templates] = await connection.query(
    `SELECT id, starter_type, starter_hr_id, starter_conditions_json
       FROM audit_flow_templates
      WHERE org_id = ?
      FOR UPDATE`,
    [orgId]
  );
  for (const template of templates) {
    const currentPeople = csvValues(template.starter_hr_id);
    const remaining = currentPeople.filter((id) => !targetHrIds.has(id));
    const jsonResult = removePersonFromStarterJson(
      template.starter_conditions_json,
      targetHrIds,
      targetAssignmentIds
    );
    const changed = remaining.length !== currentPeople.length || jsonResult.changed;
    if (!changed) continue;
    const hasActiveDirectCandidate = await hasActivePersonCandidate(
      connection, orgId, remaining, [], true
    );
    const hasActiveJsonCandidate = await hasAnyActiveCandidateGroup(
      connection, orgId, collectPersonCandidateGroups(jsonResult.value), true
    );
    const mustDisable = safeString(template.starter_type) === 'specific_person'
      && !hasActiveDirectCandidate && !hasActiveJsonCandidate;
    await connection.query(
      `UPDATE audit_flow_templates
          SET starter_hr_id = ?, starter_conditions_json = ?,
              is_active = IF(?, 0, is_active), updated_at = NOW()
        WHERE id = ? AND org_id = ?`,
      [remaining.join(',') || null, jsonResult.value, mustDisable ? 1 : 0, template.id, orgId]
    );
    if (mustDisable) disabled.push({ type: 'audit_template', id: safeString(template.id) });
  }
  return disabled;
}

async function cleanupVenueRuleReferences(connection, target) {
  const orgId = safeString(target.organizationId);
  const targetHrIds = new Set(uniqueStrings(target.legacyHrIds));
  const targetAssignmentIds = new Set(uniqueStrings(target.assignmentIds));
  if (!orgId || (!targetHrIds.size && !targetAssignmentIds.size)) return [];
  const [rules] = await connection.query(
    `SELECT id, rule_type, approver_hr_id, approver_assignment_id
       FROM venue_booking_rules
      WHERE org_id = ?
      FOR UPDATE`,
    [orgId]
  );
  const disabled = [];
  for (const rule of rules) {
    const filtered = removePairedReferences(
      rule.approver_hr_id,
      rule.approver_assignment_id,
      targetHrIds,
      targetAssignmentIds
    );
    const changed = filtered.people.join(',') !== csvValues(rule.approver_hr_id).join(',')
      || filtered.assignments.join(',') !== csvValues(rule.approver_assignment_id).join(',');
    if (!changed) continue;
    const hasActiveCandidate = await hasActivePersonCandidate(connection, orgId,
      filtered.people, filtered.assignments, true);
    const mustDisable = safeString(rule.rule_type) === 'person' && !hasActiveCandidate;
    await connection.query(
      `UPDATE venue_booking_rules
          SET approver_hr_id = ?, approver_assignment_id = ?,
              is_active = IF(?, 0, is_active), updated_at = NOW()
        WHERE id = ? AND org_id = ?`,
      [filtered.people.join(',') || null, filtered.assignments.join(',') || null,
        mustDisable ? 1 : 0, rule.id, orgId]
    );
    if (mustDisable) disabled.push({ type: 'venue_rule', id: safeString(rule.id) });
  }
  return disabled;
}

async function scanRuleImpact(connection, target, lock) {
  const orgId = safeString(target.organizationId);
  const targetHrIds = new Set(uniqueStrings(target.legacyHrIds));
  const targetAssignmentIds = new Set(uniqueStrings(target.assignmentIds));
  if (!orgId || (!targetHrIds.size && !targetAssignmentIds.size)) return [];
  const lockSql = lock ? ' FOR UPDATE' : '';
  const impact = [];

  const [conditions] = await connection.query(
    `SELECT condition_row.id, condition_row.template_step_id, condition_row.person_hr_ids,
            condition_row.assignment_ids, step_row.template_id,
            step_row.name AS step_name, step_row.sort_order,
            template_row.name AS template_name
       FROM audit_flow_template_step_conditions condition_row
       JOIN audit_flow_template_steps step_row ON step_row.id = condition_row.template_step_id
       JOIN audit_flow_templates template_row ON template_row.id = step_row.template_id
      WHERE condition_row.org_id = ? AND condition_row.condition_type = 'person'${lockSql}`,
    [orgId]
  );
  const conditionCandidatesByStep = new Map();
  const affectedConditionStepIds = new Set();
  for (const row of conditions) {
    const filtered = removePairedReferences(
      row.person_hr_ids,
      row.assignment_ids,
      targetHrIds,
      targetAssignmentIds
    );
    const changed = filtered.people.join(',') !== csvValues(row.person_hr_ids).join(',')
      || filtered.assignments.join(',') !== csvValues(row.assignment_ids).join(',');
    if (await hasActiveCandidateGroup(connection, orgId, {
      people: filtered.people,
      assignments: filtered.assignments,
      requireAssignmentMatch: true
    }, lock)) {
      conditionCandidatesByStep.set(safeString(row.template_step_id), true);
    }
    if (!changed) continue;
    affectedConditionStepIds.add(safeString(row.template_step_id));
    impact.push({
      type: 'audit_template',
      id: safeString(row.template_id),
      name: safeString(row.template_name),
      stepName: safeString(row.step_name),
      stepOrder: Number(row.sort_order || 0),
      reference: 'step_condition',
      wouldDisable: false
    });
  }

  const [steps] = await connection.query(
    `SELECT step_row.id, step_row.template_id, step_row.approver_type, step_row.approver_hr_id,
            step_row.name AS step_name, step_row.sort_order,
            template_row.name AS template_name
       FROM audit_flow_template_steps step_row
       JOIN audit_flow_templates template_row ON template_row.id = step_row.template_id
      WHERE step_row.org_id = ?${lockSql}`,
    [orgId]
  );
  for (const step of steps) {
    const currentPeople = csvValues(step.approver_hr_id);
    const remaining = currentPeople.filter((id) => !targetHrIds.has(id));
    const directlyAffected = remaining.length !== currentPeople.length;
    const conditionAffected = affectedConditionStepIds.has(safeString(step.id));
    if (!directlyAffected && !conditionAffected) continue;
    const directCandidateActive = await hasActivePersonCandidate(
      connection, orgId, remaining, [], lock
    );
    const wouldDisable = safeString(step.approver_type) === 'person'
      && !directCandidateActive
      && !conditionCandidatesByStep.get(safeString(step.id));
    impact.push({
      type: 'audit_template',
      id: safeString(step.template_id),
      name: safeString(step.template_name),
      stepName: safeString(step.step_name),
      stepOrder: Number(step.sort_order || 0),
      reference: 'approval_step',
      wouldDisable
    });
  }

  const [templates] = await connection.query(
    `SELECT id, name, starter_type, starter_hr_id, starter_conditions_json
       FROM audit_flow_templates
      WHERE org_id = ?${lockSql}`,
    [orgId]
  );
  for (const template of templates) {
    const currentPeople = csvValues(template.starter_hr_id);
    const remaining = currentPeople.filter((id) => !targetHrIds.has(id));
    const jsonResult = removePersonFromStarterJson(
      template.starter_conditions_json,
      targetHrIds,
      targetAssignmentIds
    );
    if (remaining.length === currentPeople.length && !jsonResult.changed) continue;
    const directCandidateActive = await hasActivePersonCandidate(
      connection, orgId, remaining, [], lock
    );
    const jsonCandidateActive = await hasAnyActiveCandidateGroup(
      connection, orgId, collectPersonCandidateGroups(jsonResult.value), lock
    );
    impact.push({
      type: 'audit_template',
      id: safeString(template.id),
      name: safeString(template.name),
      reference: 'starter_condition',
      wouldDisable: safeString(template.starter_type) === 'specific_person'
        && !directCandidateActive && !jsonCandidateActive
    });
  }

  const [venueRules] = await connection.query(
    `SELECT rule_row.id, rule_row.rule_type, rule_row.approver_hr_id,
            rule_row.approver_assignment_id,
            rule_row.sort_order, venue_row.name AS venue_name
       FROM venue_booking_rules rule_row
       JOIN venues venue_row ON venue_row.id = rule_row.venue_id
      WHERE rule_row.org_id = ?${lockSql}`,
    [orgId]
  );
  for (const rule of venueRules) {
    const filtered = removePairedReferences(
      rule.approver_hr_id,
      rule.approver_assignment_id,
      targetHrIds,
      targetAssignmentIds
    );
    const changed = filtered.people.join(',') !== csvValues(rule.approver_hr_id).join(',')
      || filtered.assignments.join(',') !== csvValues(rule.approver_assignment_id).join(',');
    if (!changed) continue;
    const activeCandidate = await hasActivePersonCandidate(connection, orgId,
      filtered.people, filtered.assignments, lock);
    impact.push({
      type: 'venue_rule',
      id: safeString(rule.id),
      name: safeString(rule.venue_name),
      stepOrder: Number(rule.sort_order || 0),
      reference: 'approver',
      wouldDisable: safeString(rule.rule_type) === 'person' && !activeCandidate
    });
  }
  return impact;
}

async function cleanupRuleReferences(connection, target) {
  const audit = await cleanupAuditTemplateReferences(connection, target);
  const venue = await cleanupVenueRuleReferences(connection, target);
  const seen = new Set();
  return audit.concat(venue).filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function deleteAdminScope(connection, personId, organizationId) {
  const [grants] = await connection.query(
    'SELECT id, legacy_admin_id FROM admin_grants WHERE person_id = ? AND org_id = ? FOR UPDATE',
    [safeString(personId), safeString(organizationId)]
  );
  const adminIds = uniqueStrings(grants.map((item) => item.legacy_admin_id));
  let preservedAuditLogs = 0;
  if (adminIds.length) preservedAuditLogs = await countRows(connection,
    `SELECT COUNT(*) AS count FROM admin_permission_audit_logs
      WHERE org_id = ? AND (operator_admin_id IN (${placeholders(adminIds)})
        OR target_admin_id IN (${placeholders(adminIds)}))`,
    [safeString(organizationId), ...adminIds, ...adminIds]);
  await connection.query('DELETE FROM admin_grants WHERE person_id = ? AND org_id = ?', [safeString(personId), safeString(organizationId)]);
  if (adminIds.length) {
    await connection.query(`DELETE FROM admin_info WHERE id IN (${placeholders(adminIds)}) AND org_id = ?`, [...adminIds, safeString(organizationId)]);
  }
  return { adminRecords: adminIds.length, preservedAuditLogs };
}

async function revokeIssuedCredentials(connection, personId, organizationId) {
  const orgId = safeString(organizationId);
  const counts = {};
  let result;
  [result] = await connection.query(
    `UPDATE identity_verification_tokens token_row
       JOIN identity_claim_requests claim_row ON claim_row.id = token_row.claim_request_id
        SET token_row.status = 'revoked'
      WHERE token_row.issued_by_person_id = ? AND token_row.status = 'active'
        AND claim_row.requested_org_id = ?`,
    [safeString(personId), orgId]
  );
  counts.issuedIdentityTokensRevoked = Number(result.affectedRows || 0);
  [result] = await connection.query(
    `UPDATE identity_verification_invites
        SET status = 'revoked', updated_at = NOW()
      WHERE issued_by_person_id = ? AND org_id = ? AND status = 'active'`,
    [safeString(personId), orgId]
  );
  counts.issuedIdentityInvitesRevoked = Number(result.affectedRows || 0);
  [result] = await connection.query(
    `UPDATE account_recovery_requests
        SET approved_by_person_id = NULL, approved_by_context_id = NULL, updated_at = NOW()
      WHERE approved_by_person_id = ? AND requested_org_id = ?`,
    [safeString(personId), orgId]
  );
  counts.recoveryApprovalsRedacted = Number(result.affectedRows || 0);
  return counts;
}

async function invalidateScoringCaches(connection, organizationId) {
  const orgId = safeString(organizationId);
  if (!orgId) return 0;
  const [result] = await connection.query(
    `DELETE FROM _shared_cache
      WHERE cache_key LIKE ? OR cache_key LIKE ?`,
    [`overview_${orgId}_%`, `pubCache:%:${orgId}`]
  );
  return Number(result.affectedRows || 0);
}

async function removeOrganizationGlobalProfileValues(connection, personId, organizationId) {
  const [currentRows] = await connection.query(
    `SELECT * FROM person_profile_values
      WHERE person_id = ? AND source_org_id = ?
      FOR UPDATE`,
    [safeString(personId), safeString(organizationId)]
  );
  let removedCurrent = 0;
  let restoredCurrent = 0;
  for (const current of currentRows) {
    const [removeResult] = await connection.query(
      'DELETE FROM person_profile_values WHERE id = ? AND person_id = ?',
      [current.id, safeString(personId)]
    );
    removedCurrent += Number(removeResult.affectedRows || 0);
    const [historyRows] = await connection.query(
      `SELECT * FROM person_profile_value_history
        WHERE person_id = ? AND normalized_label = ? AND field_type = ?
          AND (source_org_id IS NULL OR source_org_id <> ?)
        ORDER BY value_updated_at DESC, created_at DESC, id DESC
        LIMIT 1 FOR UPDATE`,
      [safeString(personId), current.normalized_label, current.field_type, safeString(organizationId)]
    );
    const fallback = historyRows[0];
    if (!fallback) continue;
    const [restoreResult] = await connection.query(
      `INSERT INTO person_profile_values
        (id, person_id, normalized_label, field_label, field_type, field_value,
         value_updated_at, source_org_id, source_record_id, source_field_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        safeString(personId),
        fallback.normalized_label,
        fallback.field_label,
        fallback.field_type,
        fallback.field_value,
        fallback.value_updated_at,
        fallback.source_org_id,
        fallback.source_record_id,
        fallback.source_field_id
      ]
    );
    restoredCurrent += Number(restoreResult.affectedRows || 0);
  }
  const [historyResult] = await connection.query(
    'DELETE FROM person_profile_value_history WHERE person_id = ? AND source_org_id = ?',
    [safeString(personId), safeString(organizationId)]
  );
  return {
    removedCurrent,
    restoredCurrent,
    removedHistory: Number(historyResult.affectedRows || 0)
  };
}

async function deleteAbsoluteTimeReviewsForRows(connection, tableName, recordIds) {
  const ids = uniqueStrings(recordIds);
  if (!ids.length) return 0;
  try {
    const [result] = await connection.query(
      `DELETE FROM absolute_time_record_reviews
        WHERE table_name = ? AND primary_record_id IN (${placeholders(ids)})`,
      [safeString(tableName), ...ids]
    );
    return Number(result.affectedRows || 0);
  } catch (error) {
    if (safeString(error && error.code) === 'ER_NO_SUCH_TABLE' || Number(error && error.errno) === 1146) {
      return 0;
    }
    throw error;
  }
}

async function collectSourceIds(connection, sql, params) {
  const [rows] = await connection.query(sql, params || []);
  return uniqueStrings(rows.map((row) => row.id));
}

async function cleanupMembershipAbsoluteTimeReviews(connection, target) {
  const orgId = safeString(target.organizationId);
  const personId = safeString(target.personId);
  const hrIds = uniqueStrings(target.legacyHrIds);
  const groups = [];
  const add = async (tableName, sql, params) => {
    groups.push({ tableName, ids: await collectSourceIds(connection, sql, params) });
  };
  if (hrIds.length) {
    const inSql = placeholders(hrIds);
    await add('hr_info', `SELECT id FROM hr_info WHERE org_id = ? AND id IN (${inSql})`, [orgId, ...hrIds]);
    await add('signature_templates', `SELECT id FROM signature_templates WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    await add('audit_read_cursors', `SELECT CAST(id AS CHAR) AS id FROM audit_read_cursors WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    await add('audit_verification_permissions', `SELECT id FROM audit_verification_permissions WHERE org_id = ? AND grantee_hr_id IN (${inSql})`, [orgId, ...hrIds]);
    await add('notifications', `SELECT id FROM notifications WHERE org_id = ? AND (hr_id IN (${inSql}) OR recipient_id IN (${inSql}))`, [orgId, ...hrIds, ...hrIds]);
    await add('notification_outbox', `SELECT id FROM notification_outbox WHERE org_id = ? AND recipient_id IN (${inSql})`, [orgId, ...hrIds]);
    await add('user_info', `SELECT id FROM user_info WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    await add('hr_profile_records', `SELECT id FROM hr_profile_records WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    await add(
      'hr_profile_record_values',
      `SELECT value_row.id
         FROM hr_profile_record_values value_row
         JOIN hr_profile_records record_row ON record_row.id = value_row.record_id
        WHERE record_row.org_id = ? AND record_row.hr_id IN (${inSql})`,
      [orgId, ...hrIds]
    );
  }
  await add('person_profile_values', 'SELECT id FROM person_profile_values WHERE person_id = ? AND source_org_id = ?', [personId, orgId]);
  await add('person_profile_value_history', 'SELECT id FROM person_profile_value_history WHERE person_id = ? AND source_org_id = ?', [personId, orgId]);
  await add('admin_grants', 'SELECT id FROM admin_grants WHERE person_id = ? AND org_id = ?', [personId, orgId]);
  await add(
    'admin_info',
    `SELECT admin_row.id
       FROM admin_info admin_row
       JOIN admin_grants grant_row ON grant_row.legacy_admin_id = admin_row.id
      WHERE grant_row.person_id = ? AND grant_row.org_id = ? AND admin_row.org_id = ?`,
    [personId, orgId, orgId]
  );
  await add(
    'admin_permission_overrides',
    `SELECT override_row.id
       FROM admin_permission_overrides override_row
       JOIN admin_grants grant_row ON grant_row.legacy_admin_id = override_row.admin_id
      WHERE grant_row.person_id = ? AND grant_row.org_id = ? AND override_row.org_id = ?`,
    [personId, orgId, orgId]
  );
  await add('identity_verification_invites', 'SELECT id FROM identity_verification_invites WHERE person_id = ? AND org_id = ?', [personId, orgId]);
  await add('identity_claim_requests', 'SELECT id FROM identity_claim_requests WHERE person_id = ? AND requested_org_id = ?', [personId, orgId]);
  await add(
    'identity_verification_tokens',
    `SELECT token_row.id
       FROM identity_verification_tokens token_row
       JOIN identity_claim_requests claim_row ON claim_row.id = token_row.claim_request_id
      WHERE claim_row.person_id = ? AND claim_row.requested_org_id = ?`,
    [personId, orgId]
  );
  await add('account_recovery_requests', 'SELECT id FROM account_recovery_requests WHERE person_id = ? AND requested_org_id = ?', [personId, orgId]);
  await add(
    'auth_sessions',
    `SELECT session_row.id
       FROM auth_sessions session_row
       JOIN accounts account_row ON account_row.id = session_row.account_id
      WHERE account_row.person_id = ? AND session_row.organization_id = ?`,
    [personId, orgId]
  );
  await add(
    'membership_assignments',
    `SELECT assignment_row.id
       FROM membership_assignments assignment_row
       JOIN organization_memberships membership_row ON membership_row.id = assignment_row.membership_id
      WHERE membership_row.person_id = ? AND membership_row.org_id = ?`,
    [personId, orgId]
  );
  await add('organization_memberships', 'SELECT id FROM organization_memberships WHERE person_id = ? AND org_id = ?', [personId, orgId]);

  let removed = 0;
  for (const group of groups) {
    removed += await deleteAbsoluteTimeReviewsForRows(connection, group.tableName, group.ids);
  }
  return removed;
}

async function cleanupPersonAbsoluteTimeReviews(connection, target) {
  const personId = safeString(target.personId);
  const accountId = safeString(target.accountId);
  const groups = [];
  const add = async (tableName, sql, params) => {
    groups.push({ tableName, ids: await collectSourceIds(connection, sql, params) });
  };
  await add('identity_verification_tokens', 'SELECT id FROM identity_verification_tokens WHERE person_id = ? OR issued_by_person_id = ?', [personId, personId]);
  await add(
    'identity_verification_invites',
    `SELECT id FROM identity_verification_invites
      WHERE (person_id = ? OR issued_by_person_id = ?) AND (? = '' OR org_id = ?)`,
    [personId, personId, '', '']
  );
  await add('identity_claim_requests', 'SELECT id FROM identity_claim_requests WHERE person_id = ?', [personId]);
  await add('account_recovery_requests', 'SELECT id FROM account_recovery_requests WHERE person_id = ?', [personId]);
  await add('person_profile_values', 'SELECT id FROM person_profile_values WHERE person_id = ?', [personId]);
  await add('person_profile_value_history', 'SELECT id FROM person_profile_value_history WHERE person_id = ?', [personId]);
  await add(
    'admin_grants',
    `SELECT id FROM admin_grants
      WHERE person_id = ? AND (? = '' OR org_id = ?)`,
    [personId, '', '']
  );
  await add(
    'admin_info',
    `SELECT admin_row.id
       FROM admin_info admin_row
       JOIN admin_grants grant_row ON grant_row.legacy_admin_id = admin_row.id
      WHERE grant_row.person_id = ? AND (? = '' OR grant_row.org_id = ?)`,
    [personId, '', '']
  );
  await add(
    'admin_permission_overrides',
    `SELECT override_row.id
       FROM admin_permission_overrides override_row
       JOIN admin_grants grant_row ON grant_row.legacy_admin_id = override_row.admin_id
      WHERE grant_row.person_id = ? AND (? = '' OR override_row.org_id = ?)`,
    [personId, '', '']
  );
  if (accountId) {
    await add('accounts', 'SELECT id FROM accounts WHERE id = ? AND person_id = ?', [accountId, personId]);
    await add('account_wechat_bindings', 'SELECT id FROM account_wechat_bindings WHERE account_id = ?', [accountId]);
    await add('auth_sessions', 'SELECT id FROM auth_sessions WHERE account_id = ?', [accountId]);
    await add('account_recovery_credentials', 'SELECT id FROM account_recovery_credentials WHERE account_id = ?', [accountId]);
    await add(
      'auth_bootstrap_sessions',
      `SELECT bootstrap_row.id
         FROM auth_bootstrap_sessions bootstrap_row
         JOIN account_wechat_bindings binding_row ON binding_row.openid_hash = bootstrap_row.openid_hash
        WHERE binding_row.account_id = ?`,
      [accountId]
    );
    await add(
      'auth_challenges',
      `SELECT challenge_row.id
         FROM auth_challenges challenge_row
         JOIN account_wechat_bindings binding_row ON binding_row.openid_hash = challenge_row.openid_hash
        WHERE binding_row.account_id = ?`,
      [accountId]
    );
  }
  await add('persons', 'SELECT id FROM persons WHERE id = ?', [personId]);
  let removed = 0;
  for (const group of groups) {
    removed += await deleteAbsoluteTimeReviewsForRows(connection, group.tableName, group.ids);
  }
  return removed;
}

async function cleanupMembershipArtifacts(connection, target) {
  const orgId = safeString(target.organizationId);
  const personId = safeString(target.personId);
  const hrIds = uniqueStrings(target.legacyHrIds);
  const counts = {};
  const record = (key, result) => { counts[key] = Number(result && result.affectedRows || 0); };
  counts.absoluteTimeReviews = await cleanupMembershipAbsoluteTimeReviews(connection, target);

  const disabledRules = await cleanupRuleReferences(connection, target);
  const [stampGrantsRemoved] = await connection.query(
    'DELETE FROM stamp_assignment_grants WHERE person_id = ? AND org_id = ?', [personId, orgId]);
  record('stampAssignmentGrants', stampGrantsRemoved);
  if (hrIds.length) {
    const inSql = placeholders(hrIds);
    let result;
    [result] = await connection.query(`DELETE FROM audit_verification_permissions WHERE org_id = ? AND grantee_hr_id IN (${inSql})`, [orgId, ...hrIds]);
    record('verificationPermissions', result);
    [result] = await connection.query(`DELETE FROM signature_templates WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    record('signatureTemplates', result);
    [result] = await connection.query(`DELETE FROM audit_read_cursors WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    record('readCursors', result);
    [result] = await connection.query(`DELETE FROM notifications WHERE org_id = ? AND (hr_id IN (${inSql}) OR recipient_id IN (${inSql}))`, [orgId, ...hrIds, ...hrIds]);
    record('notifications', result);
    [result] = await connection.query(`DELETE FROM notification_outbox WHERE org_id = ? AND recipient_id IN (${inSql})`, [orgId, ...hrIds]);
    record('notificationOutbox', result);
    [result] = await connection.query(`DELETE FROM user_info WHERE org_id = ? AND hr_id IN (${inSql})`, [orgId, ...hrIds]);
    record('legacyUserBindings', result);

    const [records] = await connection.query(
      `SELECT id FROM hr_profile_records WHERE org_id = ? AND hr_id IN (${inSql}) FOR UPDATE`,
      [orgId, ...hrIds]
    );
    const recordIds = uniqueStrings(records.map((item) => item.id));
    if (recordIds.length) {
      [result] = await connection.query(`DELETE FROM hr_profile_record_values WHERE org_id = ? AND record_id IN (${placeholders(recordIds)})`, [orgId, ...recordIds]);
      record('profileValues', result);
      [result] = await connection.query(`DELETE FROM hr_profile_records WHERE org_id = ? AND id IN (${placeholders(recordIds)})`, [orgId, ...recordIds]);
      record('profileRecords', result);
    }
  }

  let result;
  const issuedCredentialCleanup = await revokeIssuedCredentials(connection, personId, orgId);
  Object.assign(counts, issuedCredentialCleanup);
  const globalProfileCleanup = await removeOrganizationGlobalProfileValues(connection, personId, orgId);
  counts.globalProfileValues = globalProfileCleanup.removedCurrent;
  counts.globalProfileValuesRestored = globalProfileCleanup.restoredCurrent;
  counts.globalProfileHistory = globalProfileCleanup.removedHistory;
  [result] = await connection.query('DELETE FROM identity_verification_invites WHERE person_id = ? AND org_id = ?', [personId, orgId]);
  record('identityInvites', result);
  [result] = await connection.query('DELETE FROM identity_claim_requests WHERE person_id = ? AND requested_org_id = ?', [personId, orgId]);
  record('identityClaims', result);
  [result] = await connection.query('DELETE FROM account_recovery_requests WHERE person_id = ? AND requested_org_id = ?', [personId, orgId]);
  record('recoveryRequests', result);
  [result] = await connection.query(
    `DELETE session_row FROM auth_sessions session_row
       JOIN accounts account_row ON account_row.id = session_row.account_id
      WHERE account_row.person_id = ? AND session_row.organization_id = ?`,
    [personId, orgId]
  );
  record('sessions', result);
  const adminCleanup = await deleteAdminScope(connection, personId, orgId);
  counts.adminRecords = adminCleanup.adminRecords;
  counts.adminPermissionAuditPreserved = adminCleanup.preservedAuditLogs;
  counts.scoringCaches = await invalidateScoringCaches(connection, orgId);

  if (hrIds.length) {
    [result] = await connection.query(`DELETE FROM hr_info WHERE org_id = ? AND id IN (${placeholders(hrIds)})`, [orgId, ...hrIds]);
    record('legacyHrRecords', result);
  }
  [result] = await connection.query('DELETE FROM organization_memberships WHERE person_id = ? AND org_id = ?', [personId, orgId]);
  record('memberships', result);
  return { cleanupCounts: counts, disabledRules };
}

async function lockSuperAdminState(connection, personId, lock) {
  const lockSql = lock ? ' FOR UPDATE' : '';
  const [targetRows] = await connection.query(
    `SELECT grant_row.id
       FROM admin_grants grant_row
       JOIN persons person_row ON person_row.id = grant_row.person_id AND person_row.status = 'active'
       JOIN accounts account_row ON account_row.person_id = person_row.id AND account_row.status = 'verified'
      WHERE grant_row.person_id = ?
        AND grant_row.admin_level = 'super_admin' AND grant_row.org_id = '' AND grant_row.status = 'active'
        AND ${usableLoginCredentialSql('account_row')}${lockSql}`,
    [safeString(personId)]
  );
  if (!targetRows.length) return { targetIsSuperAdmin: false, activeCount: 0 };
  const [activeRows] = await connection.query(
    `SELECT grant_row.person_id
       FROM admin_grants grant_row
       JOIN persons person_row ON person_row.id = grant_row.person_id AND person_row.status = 'active'
       JOIN accounts account_row ON account_row.person_id = person_row.id AND account_row.status = 'verified'
       WHERE grant_row.admin_level = 'super_admin' AND grant_row.org_id = '' AND grant_row.status = 'active'
         AND ${usableLoginCredentialSql('account_row')}${lockSql}`
  );
  return {
    targetIsSuperAdmin: true,
    activeCount: new Set(activeRows.map((row) => safeString(row.person_id)).filter(Boolean)).size
  };
}

async function acquireDeletionLock(connection, personId, timeoutSeconds) {
  // MySQL user-level lock names are limited to 64 characters. Person IDs can
  // themselves be 64-character digests, so never concatenate the raw ID.
  const digest = createHash('sha256').update(safeString(personId)).digest('hex');
  const key = `hr-delete:${digest.slice(0, 54)}`;
  const timeout = Math.max(1, Math.min(Number.parseInt(timeoutSeconds, 10) || 10, 30));
  const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [key, timeout]);
  return { key, acquired: Number(rows[0] && rows[0].acquired) === 1 };
}

async function acquireSuperAdminGovernanceLock(connection, timeoutSeconds) {
  const key = 'hr-delete:super-admin-governance';
  const timeout = Math.max(1, Math.min(Number.parseInt(timeoutSeconds, 10) || 10, 30));
  const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [key, timeout]);
  return { key, acquired: Number(rows[0] && rows[0].acquired) === 1 };
}

async function releaseDeletionLock(connection, key) {
  if (!safeString(key)) return false;
  const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [safeString(key)]);
  return Number(rows[0] && rows[0].released) === 1;
}

async function cleanupGlobalPersonArtifacts(connection, target, deletionDigest) {
  const personId = safeString(target.personId);
  const accountId = safeString(target.accountId);
  const counts = {};
  const record = (key, result) => { counts[key] = Number(result && result.affectedRows || 0); };
  let result;
  counts.absoluteTimeReviews = await cleanupPersonAbsoluteTimeReviews(connection, target);
  let invalidatedCaches = 0;
  for (const organizationId of uniqueStrings(target.organizationIds)) {
    invalidatedCaches += await invalidateScoringCaches(connection, organizationId);
  }
  counts.scoringCaches = invalidatedCaches;

  const legacyOpenids = uniqueStrings(target.legacyOpenids);
  if (legacyOpenids.length) {
    const redactedDesignator = `deleted:${safeString(deletionDigest).slice(0, 56)}`;
    [result] = await connection.query(
      `UPDATE merit_list_designations
          SET designated_by = ?, designated_by_person_id = NULL,
              designated_by_assignment_id = NULL,
              designated_by_context_snapshot = JSON_OBJECT('redacted', TRUE, 'deletionDigest', ?)
        WHERE designated_by IN (${placeholders(legacyOpenids)})
           OR designated_by_person_id = ?`,
      [redactedDesignator, safeString(deletionDigest), ...legacyOpenids, personId]
    );
    record('redactedLegacyMeritDesignators', result);
  }

  let bindingHashes = [];
  if (accountId) {
    const [bindingRows] = await connection.query(
      'SELECT openid_hash FROM account_wechat_bindings WHERE account_id = ? FOR UPDATE',
      [accountId]
    );
    bindingHashes = uniqueStrings(bindingRows.map((item) => item.openid_hash));
  }
  if (bindingHashes.length) {
    [result] = await connection.query(
      `DELETE FROM auth_bootstrap_sessions WHERE openid_hash IN (${placeholders(bindingHashes)})`,
      bindingHashes
    );
    record('bootstrapSessions', result);
    [result] = await connection.query(
      `DELETE FROM auth_challenges WHERE openid_hash IN (${placeholders(bindingHashes)})`,
      bindingHashes
    );
    record('legacyAuthChallenges', result);
  }

  [result] = await connection.query('UPDATE auth_policy SET updated_by_person_id = NULL WHERE updated_by_person_id = ?', [personId]);
  record('authPolicyReferences', result);
  [result] = await connection.query('UPDATE account_recovery_requests SET approved_by_person_id = NULL, approved_by_context_id = NULL WHERE approved_by_person_id = ?', [personId]);
  record('recoveryApproverReferences', result);
  [result] = await connection.query('DELETE FROM identity_verification_tokens WHERE issued_by_person_id = ? OR person_id = ?', [personId, personId]);
  record('identityTokens', result);
  [result] = await connection.query('DELETE FROM identity_verification_invites WHERE issued_by_person_id = ? OR person_id = ?', [personId, personId]);
  record('identityInvites', result);
  [result] = await connection.query('DELETE FROM identity_claim_requests WHERE person_id = ?', [personId]);
  record('identityClaims', result);
  [result] = await connection.query('DELETE FROM account_recovery_requests WHERE person_id = ?', [personId]);
  record('recoveryRequests', result);
  [result] = await connection.query('DELETE FROM person_profile_values WHERE person_id = ?', [personId]);
  record('globalProfileValues', result);
  [result] = await connection.query('DELETE FROM person_profile_value_history WHERE person_id = ?', [personId]);
  record('globalProfileHistory', result);

  const [grants] = await connection.query('SELECT legacy_admin_id FROM admin_grants WHERE person_id = ? FOR UPDATE', [personId]);
  const adminIds = uniqueStrings(
    uniqueStrings(target.legacyAdminIds).concat(grants.map((item) => item.legacy_admin_id))
  );
  if (adminIds.length) {
    const redactedAdminId = `deleted:${safeString(deletionDigest).slice(0, 56)}`;
    [result] = await connection.query(
      `UPDATE admin_permission_overrides
          SET configured_by = ?
        WHERE configured_by IN (${placeholders(adminIds)})`,
      [redactedAdminId, ...adminIds]
    );
    record('redactedAdminPermissionOverrideIssuers', result);
    [result] = await connection.query(
      `UPDATE admin_permission_audit_logs
          SET operator_admin_id = IF(operator_admin_id IN (${placeholders(adminIds)}), ?, operator_admin_id),
              target_admin_id = IF(target_admin_id IN (${placeholders(adminIds)}), ?, target_admin_id),
              snapshot_json = JSON_OBJECT('redacted', TRUE, 'deletionDigest', ?)
        WHERE operator_admin_id IN (${placeholders(adminIds)})
           OR target_admin_id IN (${placeholders(adminIds)})`,
      [
        ...adminIds, redactedAdminId,
        ...adminIds, redactedAdminId,
        safeString(deletionDigest),
        ...adminIds, ...adminIds
      ]
    );
    record('redactedAdminPermissionAudit', result);
    [result] = await connection.query(`DELETE FROM admin_info WHERE id IN (${placeholders(adminIds)})`, adminIds);
    record('legacyAdminRecords', result);
  }
  [result] = await connection.query('DELETE FROM admin_grants WHERE person_id = ?', [personId]);
  record('adminGrants', result);

  [result] = await connection.query(
    `UPDATE auth_audit_events
        SET actor_person_id = IF(actor_person_id = ?, NULL, actor_person_id),
            target_person_id = IF(target_person_id = ?, NULL, target_person_id),
            account_id = IF(account_id = ?, NULL, account_id),
            context_id = NULL,
            detail_json = JSON_OBJECT('redacted', TRUE, 'deletionDigest', ?)
      WHERE actor_person_id = ? OR target_person_id = ? OR account_id = ?`,
    [personId, personId, accountId || '__none__', deletionDigest,
      personId, personId, accountId || '__none__']
  );
  record('redactedAuditEvents', result);
  const migrationReferenceIds = uniqueStrings(
    [personId].concat(target.legacyHrIds || [], target.assignmentIds || [])
  );
  if (migrationReferenceIds.length) {
    const clauses = migrationReferenceIds.map(() => (
      '(record_id = ? OR LOCATE(?, COALESCE(CAST(detail_json AS CHAR), \'\')) > 0)'
    ));
    const params = [];
    migrationReferenceIds.forEach((id) => params.push(id, id));
    [result] = await connection.query(
      `UPDATE personnel_migration_audit
          SET record_id = CONCAT('deleted:', SUBSTRING(SHA2(CONCAT(id, ?), 256), 1, 56)),
              detail_json = JSON_OBJECT('redacted', TRUE, 'deletionDigest', ?)
        WHERE ${clauses.join(' OR ')}`,
      [safeString(deletionDigest), safeString(deletionDigest), ...params]
    );
    record('redactedPersonnelMigrationAudit', result);
  }
  if (accountId) {
    [result] = await connection.query('DELETE FROM accounts WHERE id = ? AND person_id = ?', [accountId, personId]);
    record('accounts', result);
  }
  [result] = await connection.query('DELETE FROM persons WHERE id = ?', [personId]);
  record('persons', result);
  return counts;
}

module.exports = {
  BUSINESS_REFERENCES,
  uniqueStrings,
  getTargetByLegacyHrId,
  getTargetByPersonId,
  lockPersonDeletionBarrier,
  listMemberships,
  listAssignments,
  listAdminReferences,
  listPersonOpenidReferences,
  scanScoringDesignationReferences,
  buildTargetScope,
  scanBusinessBlockers,
  scanCleanupImpact,
  scanRuleImpact,
  cleanupRuleReferences,
  cleanupMembershipArtifacts,
  cleanupGlobalPersonArtifacts,
  removeOrganizationGlobalProfileValues,
  deleteAbsoluteTimeReviewsForRows,
  cleanupMembershipAbsoluteTimeReviews,
  cleanupPersonAbsoluteTimeReviews,
  lockSuperAdminState,
  acquireDeletionLock,
  acquireSuperAdminGovernanceLock,
  releaseDeletionLock,
  removePairedReferences,
  removePersonFromStarterJson,
  collectPersonCandidateGroups,
  hasActivePersonCandidate
};
