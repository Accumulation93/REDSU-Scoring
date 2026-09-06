const localeCopy = require('../../locales/zh-CN/generated/core/models/unifiedIdentity');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const securityCopy = require('../../locales/zh-CN/core/security');
const pool = require('../../config/db');
const crypto = require('crypto');
const { usableLoginCredentialSql } = require('./accountLoginState');
const { generateId, safeString } = require('../../utils/helpers');
const { normalizeAssignmentNature } = require('../services/hrDomainPolicy');
const {
  hmac,
  legacyHmac,
  legacyHash,
  encryptOpenid,
  decryptOpenid,
  randomCode,
  hashPassphrase,
  verifyPassphrase,
  secureEqualHex
} = require('../services/identityCrypto');

const APP_ID = 'whusu-smart-workspace';
const SESSION_MINUTES = 7 * 24 * 60;
const BOOTSTRAP_MINUTES = 15;
const CLAIM_HOURS = 48;
const VERIFY_TOKEN_HOURS = 24;
const RECOVERY_HOURS = 24;
const MAX_VERIFY_ATTEMPTS = 8;
const MAX_RECOVERY_ATTEMPTS = 8;
const PASSPHRASE_MIN_CHARACTERS = 12;
const PASSPHRASE_MAX_CHARACTERS = 128;
// 管理端需要一次取得当前权限范围内的完整人员目录，再在本地完成即时筛选。
// 该上限只对已通过管理员权限校验的接口开放，避免旧的 100/200 条截断。
const MAX_AUTH_DIRECTORY_LIMIT = 2000;

class IdentityError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.httpStatus = httpStatus || 400;
  }
}

function contextId(type, subjectId, orgId) {
  return 'ctx_' + hmac([type, subjectId, orgId].join('|')).slice(0, 40);
}

function authIdentityId(type, subjectId) {
  return 'idn_' + hmac([type, subjectId].join('|')).slice(0, 40);
}

function normalizeStudentId(value) {
  return safeString(value).toLowerCase();
}

function normalizeName(value) {
  return safeString(value);
}

function normalizePolicyDate(value, label) {
  const text = safeString(value);
  if (!text) return null;
  const parsed = new Date(text.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    throw new IdentityError('invalid_policy_time', localeCopy.copy_014ac651ad + label, 400);
  }
  return text;
}

function policyTimestamp(value) {
  if (!value) return 0;
  const parsed = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? -1 : parsed.getTime();
}

function buildAssignmentLabel(row) {
  const parts = [
    safeString(row.identity_name),
    safeString(row.department_name),
    safeString(row.work_group_name)
  ].filter(Boolean);
  return parts.join(' · ') || personnelCopy.unassignedPosition;
}

function passphraseCharacterLength(value) {
  return Array.from(String(value || '')).length;
}

function normalizePassphrase(value) {
  return safeString(value);
}

function isPassphraseLengthValid(value) {
  const length = passphraseCharacterLength(value);
  return length >= PASSPHRASE_MIN_CHARACTERS && length <= PASSPHRASE_MAX_CHARACTERS;
}

async function lockActiveBusinessSubjects(connection, subjects) {
  const normalized = [];
  for (const source of Array.isArray(subjects) ? subjects : []) {
    const organizationId = safeString(source && (source.organizationId || source.orgId));
    const legacyHrId = safeString(source && (source.legacyHrId || source.hrId));
    const assignmentId = safeString(source && source.assignmentId);
    let personId = safeString(source && source.personId);
    if (!personId && assignmentId) {
      const [assignmentRows] = await connection.query(
        `SELECT om.person_id
           FROM membership_assignments ma
           JOIN organization_memberships om ON om.id = ma.membership_id AND om.org_id = ma.org_id
          WHERE ma.id = ? AND (? = '' OR ma.org_id = ?)
          LIMIT 1`,
        [assignmentId, organizationId, organizationId]
      );
      personId = safeString(assignmentRows[0] && assignmentRows[0].person_id);
    }
    if (!personId && legacyHrId) {
      const [membershipRows] = await connection.query(
        `SELECT person_id
           FROM organization_memberships
          WHERE legacy_hr_id = ? AND (? = '' OR org_id = ?)
          LIMIT 1`,
        [legacyHrId, organizationId, organizationId]
      );
      personId = safeString(membershipRows[0] && membershipRows[0].person_id);
    }
    if (!personId) {
      throw new IdentityError('work_context_required', personnelCopy.organizationSelectionExpired, 409);
    }
    normalized.push({
      personId,
      organizationId,
      legacyHrId,
      assignmentId,
      requireMembership: !(source && source.requireMembership === false)
    });
  }
  const personIds = [...new Set(normalized.map((item) => item.personId))].sort();
  if (!personIds.length) return [];
  const [personRows] = await connection.query(
    `SELECT id, status FROM persons
      WHERE id IN (${personIds.map(() => '?').join(', ')})
      ORDER BY id FOR UPDATE`,
    personIds
  );
  const activePersonIds = new Set(personRows
    .filter((row) => safeString(row.status) === 'active')
    .map((row) => safeString(row.id)));
  if (activePersonIds.size !== personIds.length) {
    throw new IdentityError('work_context_required', personnelCopy.organizationSelectionExpired, 409);
  }

  const orderedSubjects = normalized.slice().sort((left, right) => (
    [left.personId, left.organizationId, left.assignmentId, left.legacyHrId].join(':')
      .localeCompare([right.personId, right.organizationId, right.assignmentId, right.legacyHrId].join(':'))
  ));
  for (const subject of orderedSubjects) {
    if (!subject.organizationId || !subject.requireMembership) continue;
    let assignmentSql = '';
    if (subject.assignmentId) {
      assignmentSql = `
        JOIN membership_assignments ma
          ON ma.membership_id = om.id AND ma.org_id = om.org_id
         AND ma.id = ? AND ma.status = 'active'`;
    }
    const legacySql = subject.legacyHrId ? ' AND om.legacy_hr_id = ?' : '';
    const params = (subject.assignmentId ? [subject.assignmentId] : [])
      .concat([subject.personId, subject.organizationId])
      .concat(subject.legacyHrId ? [subject.legacyHrId] : []);
    const [membershipRows] = await connection.query(
      `SELECT om.id
         FROM organization_memberships om${assignmentSql}
        WHERE om.person_id = ? AND om.org_id = ? AND om.status = 'active'${legacySql}
        LIMIT 1 FOR UPDATE`,
      params
    );
    if (!membershipRows[0]) {
      throw new IdentityError(
        subject.assignmentId ? 'assignment_not_found' : 'work_context_required',
        subject.assignmentId ? personnelCopy.assignmentNotFound : personnelCopy.organizationSelectionExpired,
        409
      );
    }
  }
  return orderedSubjects;
}

function mapAssignmentContext(row) {
  return {
    contextId: contextId('assignment', row.assignment_id, row.organization_id),
    authIdentityId: authIdentityId('assignment', row.assignment_id),
    identityScope: 'organization',
    organizationId: safeString(row.organization_id),
    organizationName: safeString(row.organization_name),
    identityType: 'assignment',
    identityName: buildAssignmentLabel(row),
    role: 'user',
    personId: safeString(row.person_id),
    membershipId: safeString(row.membership_id),
    assignmentId: safeString(row.assignment_id),
    assignmentNature: safeString(row.assignment_kind) || 'staff',
    assignmentLabel: buildAssignmentLabel(row),
    adminGrantId: '',
    legacyHrId: safeString(row.legacy_hr_id),
    legacyAdminId: '',
    name: safeString(row.person_name),
    studentId: safeString(row.student_id),
    departmentId: safeString(row.department_id),
    department: safeString(row.department_name),
    identityId: safeString(row.identity_id),
    identity: safeString(row.identity_name),
    identityCategoryId: safeString(row.identity_id),
    identityCategoryName: safeString(row.identity_name),
    workGroupId: safeString(row.work_group_id),
    workGroup: safeString(row.work_group_name),
    adminLevel: '',
    permissions: []
  };
}

function mapMembershipContext(row) {
  return {
    contextId: contextId('membership', row.membership_id, row.organization_id),
    authIdentityId: authIdentityId('membership', row.membership_id),
    identityScope: 'organization',
    organizationId: safeString(row.organization_id),
    organizationName: safeString(row.organization_name),
    identityType: 'membership',
    identityName: personnelCopy.unassignedPosition,
    role: 'user',
    personId: safeString(row.person_id),
    membershipId: safeString(row.membership_id),
    assignmentId: '',
    assignmentNature: '',
    assignmentLabel: '',
    adminGrantId: '',
    legacyHrId: safeString(row.legacy_hr_id),
    legacyAdminId: '',
    name: safeString(row.person_name),
    studentId: safeString(row.student_id),
    departmentId: '',
    department: '',
    identityId: '',
    identity: '',
    identityCategoryId: '',
    identityCategoryName: '',
    workGroupId: '',
    workGroup: '',
    adminLevel: '',
    permissions: []
  };
}

function mapAdminContext(row) {
  const isGlobal = row.admin_level === 'super_admin' && safeString(row.grant_org_id) === '';
  return {
    contextId: contextId('admin', row.admin_grant_id, row.organization_id),
    authIdentityId: authIdentityId('admin', row.admin_grant_id),
    identityScope: isGlobal ? 'global' : 'organization',
    organizationId: safeString(row.organization_id),
    organizationName: safeString(row.organization_name),
    identityType: 'admin',
    identityName: row.admin_level === 'super_admin' ? '超级管理员' : '管理员',
    role: 'admin',
    personId: safeString(row.person_id),
    membershipId: '',
    assignmentId: '',
    adminGrantId: safeString(row.admin_grant_id),
    legacyHrId: '',
    legacyAdminId: safeString(row.legacy_admin_id),
    name: safeString(row.person_name),
    studentId: safeString(row.student_id),
    departmentId: '',
    department: '',
    identityId: '',
    identity: row.admin_level === 'super_admin' ? '超级管理员' : '管理员',
    workGroupId: '',
    workGroup: '',
    adminLevel: safeString(row.admin_level),
    permissions: []
  };
}

async function insertActiveWechatBinding(connection, accountId, openid) {
  try {
    await connection.query(
      `INSERT INTO account_wechat_bindings
         (id, account_id, app_id, openid_hash, hash_version, openid_ciphertext,
          legacy_openid, status, active_account_id, bound_at)
       VALUES (?, ?, ?, ?, 'hmac_sha256_v1', ?, NULL, 'active', ?, NOW())`,
      [generateId(), accountId, APP_ID, hmac(openid), encryptOpenid(openid), accountId]
    );
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new IdentityError('wechat_conflict', localeCopy.copy_7000bcfcbf, 409);
    }
    throw error;
  }
}

async function findAccountByOpenid(openid, connection) {
  const executor = connection || pool;
  const openidHash = hmac(openid);
  const oldHmacHash = legacyHmac(openid);
  const oldHash = legacyHash(openid);
  const [rows] = await executor.query(
    `SELECT a.*, b.id AS binding_id, b.openid_hash, b.hash_version, b.openid_ciphertext,
            b.legacy_openid, p.name, p.student_id
       FROM account_wechat_bindings b
       JOIN accounts a ON a.id = b.account_id
       JOIN persons p ON p.id = a.person_id
      WHERE b.app_id = ? AND b.status = 'active'
        AND (b.openid_hash = ? OR (? <> '' AND b.openid_hash = ?)
             OR (b.hash_version = 'sha256_legacy' AND b.openid_hash = ?)
             OR b.legacy_openid = ?)
        AND a.status IN ('verified', 'frozen') AND p.status = 'active'
      LIMIT 1`,
    [APP_ID, openidHash, oldHmacHash, oldHmacHash, oldHash, safeString(openid)]
  );
  const account = rows[0] || null;
  if (account && (account.openid_hash !== openidHash
    || account.hash_version !== 'hmac_sha256_v1'
    || !account.openid_ciphertext
    || account.legacy_openid)) {
    await executor.query(
      `UPDATE account_wechat_bindings
          SET openid_hash = ?, hash_version = 'hmac_sha256_v1',
              openid_ciphertext = ?, legacy_openid = NULL, updated_at = NOW()
        WHERE id = ? AND status = 'active'`,
      [openidHash, encryptOpenid(openid), account.binding_id]
    );
    account.openid_hash = openidHash;
    account.hash_version = 'hmac_sha256_v1';
    account.legacy_openid = null;
  }
  return account;
}

async function upgradeLegacyWechatBindings() {
  return pool.withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT id, legacy_openid
         FROM account_wechat_bindings
        WHERE status = 'active'
          AND (hash_version <> 'hmac_sha256_v1'
               OR openid_ciphertext IS NULL
               OR legacy_openid IS NOT NULL)
        FOR UPDATE`
    );
    for (const row of rows) {
      const openid = safeString(row.legacy_openid);
      if (!openid) {
        throw new IdentityError('legacy_binding_invalid', localeCopy.copy_240050f1ca, 500);
      }
      await connection.query(
        `UPDATE account_wechat_bindings
            SET openid_hash = ?, hash_version = 'hmac_sha256_v1',
                openid_ciphertext = ?, legacy_openid = NULL, updated_at = NOW()
          WHERE id = ? AND status = 'active'`,
        [hmac(openid), encryptOpenid(openid), row.id]
      );
    }
    return { upgraded: rows.length };
  });
}

async function listClaimOrganizations() {
  const [rows] = await pool.query(
    `SELECT id, name
       FROM organizations
      ORDER BY created_at DESC, name ASC`
  );
  return rows.map((row) => ({ id: safeString(row.id), name: safeString(row.name) }));
}

async function syncLegacyHrRecords(connection, hrIds) {
  const ids = Array.from(new Set((hrIds || []).map(safeString).filter(Boolean)));
  if (!ids.length) return { synced: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await connection.query(
    `SELECT id, name, student_id, department_id, identity_id, work_group_id, org_id
       FROM hr_info
      WHERE id IN (${placeholders})
      FOR UPDATE`,
    ids
  );
  let synced = 0;
  let skipped = 0;
  for (const row of rows) {
    const normalizedStudentId = normalizeStudentId(row.student_id);
    const name = normalizeName(row.name);
    if (!normalizedStudentId || !name) {
      throw new IdentityError('invalid_person_identity', localeCopy.copy_f162fa8c06, 400);
    }
    const [membershipRows] = await connection.query(
      'SELECT * FROM organization_memberships WHERE legacy_hr_id = ? LIMIT 1 FOR UPDATE',
      [row.id]
    );
    const existingMembership = membershipRows[0] || null;
    if (existingMembership && existingMembership.status !== 'active') {
      skipped += 1;
      continue;
    }
    const [personRows] = await connection.query(
      'SELECT * FROM persons WHERE normalized_student_id = ? LIMIT 1 FOR UPDATE',
      [normalizedStudentId]
    );
    let person = personRows[0];
    if (person && person.status !== 'active') {
      skipped += 1;
      continue;
    }
    if (person && safeString(person.name) !== name) {
      throw new IdentityError('student_id_name_conflict', localeCopy.copy_71b59f6dd1, 409);
    }
    if (!person) {
      const personId = generateId();
      await connection.query(
        `INSERT INTO persons
           (id, name, student_id, normalized_student_id, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [personId, name, safeString(row.student_id), normalizedStudentId]
      );
      person = { id: personId };
    } else {
      await connection.query(
        `UPDATE persons
            SET name = ?, student_id = ?, updated_at = NOW()
          WHERE id = ? AND status = 'active'`,
        [name, safeString(row.student_id), person.id]
      );
    }
    const membershipId = existingMembership ? existingMembership.id : generateId();
    if (existingMembership && existingMembership.person_id !== person.id) {
      throw new IdentityError('membership_person_conflict', localeCopy.copy_9d94db0edc, 409);
    }
    await connection.query(
      `INSERT INTO organization_memberships
         (id, person_id, org_id, legacy_hr_id, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), org_id = VALUES(org_id),
         updated_at = NOW()`,
      [membershipId, person.id, row.org_id, row.id]
    );
    const departmentId = safeString(row.department_id);
    const identityId = safeString(row.identity_id);
    let workGroupId = safeString(row.work_group_id);
    let departmentValid = false;
    let identityValid = false;
    if (departmentId && identityId) {
      const [referenceRows] = await connection.query(
        `SELECT
           EXISTS(SELECT 1 FROM departments WHERE id = ? AND org_id = ?) AS department_valid,
           EXISTS(SELECT 1 FROM identities WHERE id = ? AND org_id = ?) AS identity_valid`,
        [departmentId, row.org_id, identityId, row.org_id]
      );
      departmentValid = Boolean(referenceRows[0] && Number(referenceRows[0].department_valid));
      identityValid = Boolean(referenceRows[0] && Number(referenceRows[0].identity_valid));
    }
    if (workGroupId) {
      const [workGroups] = await connection.query(
        `SELECT department_id
           FROM work_groups
          WHERE id = ? AND org_id = ?
          LIMIT 1`,
        [workGroupId, row.org_id]
      );
      if (!departmentValid || !workGroups.length
        || safeString(workGroups[0].department_id) !== departmentId) {
        workGroupId = '';
        await connection.query(
          'UPDATE hr_info SET work_group_id = NULL, updated_at = NOW() WHERE id = ? AND org_id = ?',
          [row.id, row.org_id]
        );
      }
    }
    const assignmentId = safeString(row.id);
    if (departmentValid && identityValid) {
      const [duplicateAssignments] = await connection.query(
        `SELECT id FROM membership_assignments
          WHERE membership_id = ? AND org_id = ? AND status = 'active'
            AND assignment_kind = 'staff' AND department_id = ? AND identity_id = ?
            AND COALESCE(work_group_id, '') = ? AND id <> ?
          LIMIT 1 FOR UPDATE`,
        [membershipId, row.org_id, departmentId, identityId, workGroupId, assignmentId]
      );
      if (duplicateAssignments.length) {
        await connection.query(
          `UPDATE membership_assignments
              SET status = 'revoked', revoked_by_departure_id = NULL, updated_at = NOW()
            WHERE id = ? AND membership_id = ? AND org_id = ? AND status = 'active'`,
          [assignmentId, membershipId, row.org_id]
        );
        await connection.query(
          `UPDATE auth_sessions
              SET status = 'revoked', revoked_at = NOW()
            WHERE context_type = 'assignment' AND context_subject_id = ? AND status = 'active'`,
          [assignmentId]
        );
      } else {
        await connection.query(
          `INSERT INTO membership_assignments
             (id, membership_id, org_id, assignment_kind, department_id, identity_id,
              work_group_id, status)
            VALUES (?, ?, ?, 'staff', ?, ?, ?, 'active')
            ON DUPLICATE KEY UPDATE membership_id = VALUES(membership_id), org_id = VALUES(org_id), department_id = VALUES(department_id),
              identity_id = VALUES(identity_id), work_group_id = VALUES(work_group_id),
              status = 'active', revoked_by_departure_id = NULL, updated_at = NOW()`,
          [
            assignmentId,
            membershipId,
            row.org_id,
            departmentId,
            identityId,
            workGroupId || null
          ]
        );
      }
    } else {
      await connection.query(
        `UPDATE membership_assignments
            SET status = 'revoked', revoked_by_departure_id = NULL, updated_at = NOW()
          WHERE id = ? AND membership_id = ? AND org_id = ? AND status = 'active'`,
        [assignmentId, membershipId, row.org_id]
      );
    }
    synced += 1;
  }
  return { synced, skipped };
}

async function listMembershipAssignments(legacyHrId, organizationId) {
  const [rows] = await pool.query(
    `SELECT ma.id, ma.membership_id, ma.assignment_kind, ma.title,
            ma.department_id, ma.identity_id, ma.work_group_id,
            d.name AS department_name, i.name AS identity_name,
            w.name AS work_group_name
       FROM organization_memberships om
       JOIN membership_assignments ma
         ON ma.membership_id = om.id AND ma.org_id = om.org_id AND ma.status = 'active'
       LEFT JOIN departments d
         ON CONVERT(d.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.department_id
        AND CONVERT(d.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.org_id
       LEFT JOIN identities i
         ON CONVERT(i.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.identity_id
        AND CONVERT(i.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.org_id
       LEFT JOIN work_groups w
         ON CONVERT(w.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.work_group_id
        AND CONVERT(w.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.org_id
      WHERE om.legacy_hr_id = ? AND om.org_id = ? AND om.status = 'active'
      ORDER BY ma.created_at ASC, ma.id ASC`,
    [safeString(legacyHrId), safeString(organizationId)]
  );
  return rows;
}

async function listMembershipAssignmentSummaries(legacyHrIds, organizationId) {
  const ids = Array.from(new Set((legacyHrIds || []).map(safeString).filter(Boolean)));
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT om.legacy_hr_id, ma.id AS assignment_id, ma.assignment_kind,
            ma.department_id, ma.identity_id, ma.work_group_id,
            d.name AS department_name, i.name AS identity_name, w.name AS work_group_name
       FROM organization_memberships om
       LEFT JOIN membership_assignments ma
         ON ma.membership_id = om.id AND ma.org_id = om.org_id AND ma.status = 'active'
       LEFT JOIN departments d
         ON CONVERT(d.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.department_id
        AND CONVERT(d.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.org_id
       LEFT JOIN identities i
         ON CONVERT(i.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.identity_id
        AND CONVERT(i.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.org_id
       LEFT JOIN work_groups w
         ON CONVERT(w.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.work_group_id
        AND CONVERT(w.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.org_id
      WHERE om.org_id = ? AND om.status = 'active'
        AND om.legacy_hr_id IN (${placeholders})
      ORDER BY ma.created_at ASC, ma.id ASC`,
    [safeString(organizationId), ...ids]
  );
  const summaries = new Map();
  rows.forEach((row) => {
    const legacyHrId = safeString(row.legacy_hr_id);
    const summary = summaries.get(legacyHrId) || {
      count: 0,
      departments: [],
      identities: [],
      workGroups: [],
      assignments: []
    };
    if (safeString(row.assignment_id)) {
      summary.count += 1;
      summary.assignments.push({
        assignmentId: safeString(row.assignment_id),
        assignmentNature: safeString(row.assignment_kind) || 'staff',
        departmentId: safeString(row.department_id),
        department: safeString(row.department_name),
        identityCategoryId: safeString(row.identity_id),
        identityCategoryName: safeString(row.identity_name),
        workGroupId: safeString(row.work_group_id),
        workGroup: safeString(row.work_group_name),
        assignmentLabel: buildAssignmentLabel(row)
      });
    }
    const values = [
      ['departments', safeString(row.department_name)],
      ['identities', safeString(row.identity_name)],
      ['workGroups', safeString(row.work_group_name)]
    ];
    values.forEach(([key, value]) => {
      if (value && !summary[key].includes(value)) summary[key].push(value);
    });
    summaries.set(legacyHrId, summary);
  });
  return summaries;
}

async function validateAssignmentReferences(connection, organizationId, data) {
  if (!safeString(data.departmentId) || !safeString(data.identityId)) {
    throw new IdentityError(
      'assignment_structure_required',
      personnelCopy.assignmentDepartmentAndIdentityRequired,
      400
    );
  }
  const checks = [
    ['departments', data.departmentId, personnelCopy.departmentLabel],
    ['identities', data.identityId, personnelCopy.identityCategoryLabel],
    ['work_groups', data.workGroupId, personnelCopy.workGroupLabel]
  ];
  for (const [table, id, label] of checks) {
    if (!safeString(id)) continue;
    const [rows] = await connection.query(
      `SELECT 1 FROM ${table} WHERE id = ? AND org_id = ? LIMIT 1`,
      [safeString(id), safeString(organizationId)]
    );
    if (!rows.length) throw new IdentityError('assignment_reference_invalid', label + localeCopy.copy_3169026f18, 400);
  }
  const workGroupId = safeString(data.workGroupId);
  const departmentId = safeString(data.departmentId);
  if (workGroupId) {
    const [rows] = await connection.query(
      `SELECT department_id
         FROM work_groups
        WHERE id = ? AND org_id = ?
        LIMIT 1`,
      [workGroupId, safeString(organizationId)]
    );
    if (!rows.length || safeString(rows[0].department_id) !== departmentId) {
      throw new IdentityError('assignment_work_group_department_mismatch', personnelCopy.workGroupDepartmentMismatch, 400);
    }
  }
}

// 目录筛选使用完整岗位元组。已离开成员仅返回其离任前已撤销岗位，
// 避免把不同岗位的部门、身份类别和职能组拼成不存在的组合。
async function listDirectoryAssignmentSummaries(legacyHrIds, organizationId) {
  const ids = Array.from(new Set((legacyHrIds || []).map(safeString).filter(Boolean)));
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT om.legacy_hr_id, om.status AS membership_status,
            ma.id AS assignment_id, ma.assignment_kind, ma.status AS assignment_status,
            ma.department_id, ma.identity_id, ma.work_group_id,
            d.name AS department_name, i.name AS identity_name, w.name AS work_group_name
       FROM organization_memberships om
       LEFT JOIN membership_assignments ma
         ON ma.membership_id = om.id AND ma.org_id = om.org_id
         AND ((om.status = 'active' AND ma.status = 'active')
          OR (om.status = 'left' AND ma.status = 'revoked'
            AND ma.revoked_by_departure_id = om.departure_batch_id))
       LEFT JOIN departments d ON d.id = ma.department_id AND d.org_id = ma.org_id
       LEFT JOIN identities i ON i.id = ma.identity_id AND i.org_id = ma.org_id
       LEFT JOIN work_groups w ON w.id = ma.work_group_id AND w.org_id = ma.org_id
      WHERE om.org_id = ? AND om.status IN ('active', 'left')
        AND om.legacy_hr_id IN (${placeholders})
      ORDER BY ma.created_at ASC, ma.id ASC`,
    [safeString(organizationId), ...ids]
  );
  const summaries = new Map();
  rows.forEach((row) => {
    const legacyHrId = safeString(row.legacy_hr_id);
    const summary = summaries.get(legacyHrId) || {
      count: 0,
      departments: [],
      identities: [],
      workGroups: [],
      assignmentNatures: [],
      assignments: []
    };
    if (safeString(row.assignment_id)) {
      const assignment = {
        assignmentId: safeString(row.assignment_id),
        assignmentNature: safeString(row.assignment_kind) || 'staff',
        departmentId: safeString(row.department_id),
        department: safeString(row.department_name),
        identityCategoryId: safeString(row.identity_id),
        identityCategoryName: safeString(row.identity_name),
        workGroupId: safeString(row.work_group_id),
        workGroup: safeString(row.work_group_name),
        historical: safeString(row.membership_status) === 'left',
        assignmentLabel: buildAssignmentLabel(row)
      };
      summary.count += 1;
      summary.assignments.push(assignment);
      if (assignment.assignmentNature && !summary.assignmentNatures.includes(assignment.assignmentNature)) {
        summary.assignmentNatures.push(assignment.assignmentNature);
      }
      [
        ['departments', assignment.department],
        ['identities', assignment.identityCategoryName],
        ['workGroups', assignment.workGroup]
      ].forEach(([key, value]) => {
        if (value && !summary[key].includes(value)) summary[key].push(value);
      });
    }
    summaries.set(legacyHrId, summary);
  });
  return summaries;
}

async function refreshLegacyHrCompatibilitySnapshot(connection, membership) {
  const membershipId = safeString(membership.membership_id || membership.id);
  const [rows] = await connection.query(
    `SELECT department_id, identity_id, work_group_id
       FROM membership_assignments
      WHERE membership_id = ? AND org_id = ? AND status = 'active'
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [membershipId, membership.org_id]
  );
  const assignment = rows[0] || {};
  await connection.query(
    `UPDATE hr_info
        SET department_id = ?, identity_id = ?, work_group_id = ?
      WHERE id = ? AND org_id = ?`,
    [
      safeString(assignment.department_id) || null,
      safeString(assignment.identity_id) || null,
      safeString(assignment.work_group_id) || null,
      membership.legacy_hr_id,
      membership.org_id
    ]
  );
}

async function saveMembershipAssignment(data, actor, authorize) {
  const organizationId = safeString(data.organizationId);
  const legacyHrId = safeString(data.legacyHrId);
  const assignmentId = safeString(data.id);
  const assignmentKind = normalizeAssignmentNature(data.assignmentKind);
  if (!organizationId || !legacyHrId) {
    throw new IdentityError('invalid_params', personnelCopy.missingMemberOrOrganization, 400);
  }
  if (!assignmentKind) {
    throw new IdentityError('assignment_nature_invalid', personnelCopy.assignmentNatureInvalid, 400);
  }
  return pool.withTransaction(async (connection) => {
    if (authorize) await authorize(connection);
    const [membershipRows] = await connection.query(
      `SELECT * FROM organization_memberships
        WHERE legacy_hr_id = ? AND org_id = ? AND status = 'active'
        LIMIT 1 FOR UPDATE`,
      [legacyHrId, organizationId]
    );
    const membership = membershipRows[0];
    if (!membership) throw new IdentityError('membership_not_found', personnelCopy.organizationSelectionExpired, 404);
    await validateAssignmentReferences(connection, organizationId, data);

    let existing = null;
    if (assignmentId) {
      const [assignmentRows] = await connection.query(
        `SELECT * FROM membership_assignments
          WHERE id = ? AND membership_id = ? AND org_id = ? AND status = 'active'
          LIMIT 1 FOR UPDATE`,
        [assignmentId, membership.id, organizationId]
      );
      existing = assignmentRows[0];
      if (!existing) throw new IdentityError('assignment_not_found', personnelCopy.assignmentNotFound, 404);
    }

    const departmentId = safeString(data.departmentId);
    const identityId = safeString(data.identityId);
    const workGroupId = safeString(data.workGroupId);
    const [duplicateRows] = await connection.query(
      `SELECT id FROM membership_assignments
        WHERE membership_id = ? AND org_id = ? AND status = 'active'
          AND assignment_kind = ? AND department_id = ? AND identity_id = ?
          AND COALESCE(work_group_id, '') = ? AND id <> ?
        LIMIT 1 FOR UPDATE`,
      [membership.id, organizationId, assignmentKind, departmentId, identityId, workGroupId, assignmentId]
    );
    if (duplicateRows.length) {
      throw new IdentityError('duplicate_assignment', personnelCopy.duplicateAssignment, 409);
    }

    const nextId = existing ? existing.id : generateId();
    if (existing) {
      await connection.query(
        `UPDATE membership_assignments
            SET assignment_kind = ?, title = NULL, department_id = ?, identity_id = ?,
                work_group_id = ?, revoked_by_departure_id = NULL, updated_at = NOW()
          WHERE id = ?`,
        [
          assignmentKind,
          departmentId || null,
          identityId || null,
          workGroupId || null,
          nextId
        ]
      );
    } else {
      await connection.query(
         `INSERT INTO membership_assignments
           (id, membership_id, org_id, assignment_kind, title, department_id,
            identity_id, work_group_id, status)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'active')`,
        [
          nextId,
          membership.id,
          organizationId,
          assignmentKind,
          departmentId || null,
          identityId || null,
          workGroupId || null
        ]
      );
    }
    await refreshLegacyHrCompatibilitySnapshot(connection, membership);
    await appendAuditEvent({
      connection,
      eventType: existing ? 'membership_assignment_updated' : 'membership_assignment_created',
      actorPersonId: actor && actor.personId,
      targetPersonId: membership.person_id,
      organizationId,
      contextId: actor && actor.contextId,
      detail: { assignmentId: nextId, assignmentKind }
    });
    return { id: nextId };
  });
}

async function revokeMembershipAssignment(data, actor, authorize) {
  const organizationId = safeString(data.organizationId);
  const assignmentId = safeString(data.id);
  return pool.withTransaction(async (connection) => {
    if (authorize) await authorize(connection);
    const [rows] = await connection.query(
      `SELECT ma.*, om.person_id, om.legacy_hr_id
         FROM membership_assignments ma
         JOIN organization_memberships om ON om.id = ma.membership_id
        WHERE ma.id = ? AND ma.org_id = ? AND ma.status = 'active'
        LIMIT 1 FOR UPDATE`,
      [assignmentId, organizationId]
    );
    const assignment = rows[0];
    if (!assignment) throw new IdentityError('assignment_not_found', localeCopy.copy_10d3269bb4, 404);
    await connection.query(
      `UPDATE membership_assignments
          SET status = 'revoked', revoked_by_departure_id = NULL, updated_at = NOW()
        WHERE id = ?`,
      [assignmentId]
    );
    await refreshLegacyHrCompatibilitySnapshot(connection, assignment);
    await connection.query(
      `UPDATE auth_sessions
          SET status = 'revoked', revoked_at = NOW()
        WHERE context_type = 'assignment' AND context_subject_id = ? AND status = 'active'`,
      [assignmentId]
    );
    await appendAuditEvent({
      connection,
      eventType: 'membership_assignment_revoked',
      actorPersonId: actor && actor.personId,
      targetPersonId: assignment.person_id,
      organizationId,
      contextId: actor && actor.contextId,
      detail: { assignmentId }
    });
    return { revoked: true };
  });
}

async function revokeOrganizationAdminAccessForDeparture(connection, personId, organizationId) {
  const orgId = safeString(organizationId);
  const [grantRows] = await connection.query(
    `SELECT id, legacy_admin_id
       FROM admin_grants
      WHERE person_id = ? AND org_id = ? AND admin_level = 'admin' AND status = 'active'
      ORDER BY id FOR UPDATE`,
    [safeString(personId), orgId]
  );
  const grantIds = [...new Set(grantRows.map((row) => safeString(row.id)).filter(Boolean))];
  const legacyAdminIds = [...new Set(grantRows
    .map((row) => safeString(row.legacy_admin_id)).filter(Boolean))];
  if (!grantIds.length) {
    return { grantsRevoked: 0, overridesRemoved: 0, adminRecordsRemoved: 0, sessionsRevoked: 0 };
  }

  const grantPlaceholders = grantIds.map(() => '?').join(', ');
  const [sessionResult] = await connection.query(
    `UPDATE auth_sessions
        SET status = 'revoked', revoked_at = NOW()
      WHERE organization_id = ? AND context_type = 'admin' AND status = 'active'
        AND context_subject_id IN (${grantPlaceholders})`,
    [orgId, ...grantIds]
  );
  const [grantResult] = await connection.query(
    `UPDATE admin_grants
        SET status = 'revoked', updated_at = NOW()
      WHERE id IN (${grantPlaceholders}) AND person_id = ? AND org_id = ?
        AND admin_level = 'admin' AND status = 'active'`,
    [...grantIds, safeString(personId), orgId]
  );

  let overridesRemoved = 0;
  let adminRecordsRemoved = 0;
  if (legacyAdminIds.length) {
    const adminPlaceholders = legacyAdminIds.map(() => '?').join(', ');
    const [overrideResult] = await connection.query(
      `DELETE FROM admin_permission_overrides
        WHERE org_id = ? AND admin_id IN (${adminPlaceholders})`,
      [orgId, ...legacyAdminIds]
    );
    overridesRemoved = Number(overrideResult.affectedRows || 0);
    const [adminResult] = await connection.query(
      `DELETE FROM admin_info
        WHERE org_id = ? AND admin_level = 'admin' AND id IN (${adminPlaceholders})`,
      [orgId, ...legacyAdminIds]
    );
    adminRecordsRemoved = Number(adminResult.affectedRows || 0);
  }
  return {
    grantsRevoked: Number(grantResult.affectedRows || 0),
    overridesRemoved,
    adminRecordsRemoved,
    sessionsRevoked: Number(sessionResult.affectedRows || 0)
  };
}

async function removeLegacyHrRecord(connection, legacyHrId, organizationId, actor) {
  const [rows] = await connection.query(
    `SELECT om.id, om.person_id, om.legacy_hr_id, om.org_id
       FROM organization_memberships om
      WHERE om.legacy_hr_id = ? AND om.org_id = ? AND om.status = 'active'
      LIMIT 1 FOR UPDATE`,
    [safeString(legacyHrId), safeString(organizationId)]
  );
  const membership = rows[0];
  if (!membership) return { removed: false };
  const departureBatchId = generateId();
  await connection.query(
    `UPDATE membership_assignments
        SET status = 'revoked', revoked_by_departure_id = ?, updated_at = NOW()
      WHERE membership_id = ? AND org_id = ? AND status = 'active'`,
    [departureBatchId, membership.id, safeString(organizationId)]
  );
  // 当前岗位兼容快照只反映在职岗位。离任历史由 departure_batch_id 关联的
  // 已撤销岗位读取，不能把旧部门/身份继续暴露给重新加入后的无岗位成员。
  await refreshLegacyHrCompatibilitySnapshot(connection, membership);
  await connection.query(
    `UPDATE organization_memberships
        SET status = 'left', departure_batch_id = ?, updated_at = NOW()
      WHERE id = ? AND org_id = ?`,
    [departureBatchId, membership.id, safeString(organizationId)]
  );
  await connection.query(
    `UPDATE auth_sessions
        SET status = 'revoked', revoked_at = NOW()
      WHERE organization_id = ?
        AND status = 'active'
        AND ((context_type = 'membership' AND context_subject_id = ?)
          OR (context_type = 'assignment' AND context_subject_id IN (
            SELECT id FROM membership_assignments WHERE membership_id = ?
          )))`,
    [safeString(organizationId), membership.id, membership.id]
  );
  const adminAccessCleanup = await revokeOrganizationAdminAccessForDeparture(
    connection,
    membership.person_id,
    organizationId
  );
  await appendAuditEvent({
    connection,
    eventType: 'hr_membership_left',
    actorPersonId: safeString(actor && actor.personId),
    targetPersonId: safeString(membership.person_id),
    organizationId: safeString(organizationId),
    contextId: safeString(actor && actor.contextId),
    requestId: safeString(actor && actor.requestId),
    ip: safeString(actor && actor.ip),
    detail: {
      membershipId: safeString(membership.id),
      departureBatchId,
      adminAccessCleanup
    }
  });
  return { removed: true, left: true, personId: membership.person_id, membershipId: membership.id };
}

async function listFormerMemberships(organizationId) {
  const [rows] = await pool.query(
    `SELECT om.id AS membership_id, om.person_id, om.legacy_hr_id,
            p.name, p.student_id, om.updated_at AS left_at
       FROM organization_memberships om
       JOIN persons p ON p.id = om.person_id
      WHERE om.org_id = ? AND om.status = 'left' AND p.status = 'active'
      ORDER BY om.updated_at DESC, p.name ASC`,
    [safeString(organizationId)]
  );
  return rows;
}

async function reactivateMembership(data, actor, authorize) {
  const organizationId = safeString(data.organizationId);
  const legacyHrId = safeString(data.legacyHrId);
  if (!organizationId || !legacyHrId) {
    throw new IdentityError('invalid_params', personnelCopy.missingMemberOrOrganization, 400);
  }
  return pool.withTransaction(async (connection) => {
    if (authorize) await authorize(connection);
    const [rows] = await connection.query(
      `SELECT om.id, om.person_id, om.legacy_hr_id, om.org_id, om.status
         FROM organization_memberships om
         JOIN persons p ON p.id = om.person_id AND p.status = 'active'
        WHERE om.legacy_hr_id = ? AND om.org_id = ?
        LIMIT 1 FOR UPDATE`,
      [legacyHrId, organizationId]
    );
    const membership = rows[0];
    if (!membership) throw new IdentityError('membership_not_found', personnelCopy.organizationSelectionExpired, 404);
    if (membership.status === 'active') return { reactivated: false, alreadyActive: true };
    if (membership.status !== 'left') {
      throw new IdentityError('membership_not_found', personnelCopy.formerMemberNotFound, 404);
    }
    await connection.query(
      `UPDATE organization_memberships
          SET status = 'active', departure_batch_id = NULL, updated_at = NOW()
        WHERE id = ? AND org_id = ?`,
      [membership.id, organizationId]
    );
    // 兼容历史数据可能仍保留离任前岗位字段；重新加入必须防御性清空，
    // 且不会恢复任何 membership_assignments。
    await refreshLegacyHrCompatibilitySnapshot(connection, membership);
    await appendAuditEvent({
      connection,
      eventType: 'organization_membership_reactivated',
      actorPersonId: actor && actor.personId,
      targetPersonId: membership.person_id,
      organizationId,
      contextId: actor && actor.contextId,
      detail: { membershipId: membership.id }
    });
    return { reactivated: true, membershipId: membership.id };
  });
}

async function syncLegacyAdminGrant(connection, legacyAdminId) {
  const [adminRows] = await connection.query(
    'SELECT * FROM admin_info WHERE id = ? LIMIT 1 FOR UPDATE',
    [safeString(legacyAdminId)]
  );
  const admin = adminRows[0];
  if (!admin) return null;
  const studentId = normalizeStudentId(admin.student_id);
  const name = normalizeName(admin.name);
  const [personRows] = await connection.query(
      `SELECT p.id
       FROM persons p
       JOIN organization_memberships om ON om.person_id = p.id AND om.status = 'active'
      WHERE p.normalized_student_id = ? AND p.name = ? AND p.status = 'active'
        AND (? = '' OR om.org_id = ?)
      LIMIT 1 FOR UPDATE`,
    [studentId, name, safeString(admin.org_id), safeString(admin.org_id)]
  );
  if (!personRows.length) {
    throw new IdentityError(
      'admin_person_missing',
      localeCopy.copy_2ade5fb1b3,
      409
    );
  }
  const personId = personRows[0].id;
  const [grantRows] = await connection.query(
    'SELECT id, person_id FROM admin_grants WHERE legacy_admin_id = ? LIMIT 1 FOR UPDATE',
    [admin.id]
  );
  if (grantRows[0] && grantRows[0].person_id !== personId) {
    throw new IdentityError('admin_grant_conflict', localeCopy.copy_9d94db0edc, 409);
  }
  await connection.query(
    `INSERT INTO admin_grants
       (id, person_id, org_id, admin_level, status, legacy_admin_id)
     VALUES (?, ?, ?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), org_id = VALUES(org_id),
       admin_level = VALUES(admin_level), status = 'active', updated_at = NOW()`,
    [grantRows[0] ? grantRows[0].id : generateId(), personId, admin.org_id, admin.admin_level, admin.id]
  );
  const [bindingRows] = await connection.query(
    `SELECT b.openid_ciphertext, b.legacy_openid
       FROM accounts a
       JOIN account_wechat_bindings b ON b.account_id = a.id AND b.status = 'active'
      WHERE a.person_id = ? AND a.status = 'verified'
      ORDER BY b.bound_at DESC LIMIT 1 FOR UPDATE`,
    [personId]
  );
  if (bindingRows.length) {
    const openid = bindingRows[0].openid_ciphertext
      ? decryptOpenid(bindingRows[0].openid_ciphertext)
      : safeString(bindingRows[0].legacy_openid);
    await connection.query(
      `UPDATE admin_info
          SET openid = ?, bind_status = 'active', bound_at = COALESCE(bound_at, NOW()),
              invite_code = NULL, invite_expires_at = NULL, updated_at = NOW()
        WHERE id = ?`,
      [openid, admin.id]
    );
  }
  return { personId };
}

async function listLegacyAdminAuthenticationStates(legacyAdminIds, connection) {
  const ids = Array.from(new Set(
    (Array.isArray(legacyAdminIds) ? legacyAdminIds : []).map(safeString).filter(Boolean)
  ));
  if (!ids.length) return {};
  const executor = connection || pool;
  const [rows] = await executor.query(
    `SELECT ag.legacy_admin_id, a.status AS account_status,
            EXISTS (
              SELECT 1 FROM account_wechat_bindings b
               WHERE b.account_id = a.id AND b.status = 'active'
            ) AS has_active_binding
       FROM admin_grants ag
       LEFT JOIN accounts a ON a.person_id = ag.person_id
      WHERE ag.legacy_admin_id IN (?) AND ag.status = 'active'`,
    [ids]
  );
  return rows.reduce((result, row) => {
    const accountStatus = safeString(row.account_status);
    let status = 'pending_verification';
    if (accountStatus === 'frozen') status = 'frozen';
    else if (accountStatus === 'recovery_required') status = 'recovery_required';
    else if (accountStatus === 'verified') status = 'verified';
    result[safeString(row.legacy_admin_id)] = status;
    return result;
  }, {});
}

async function revokeLegacyAdminGrant(connection, legacyAdminId) {
  const [rows] = await connection.query(
    `SELECT ag.*, a.id AS account_id, a.status AS account_status
       FROM admin_grants ag
       LEFT JOIN accounts a ON a.person_id = ag.person_id
      WHERE ag.legacy_admin_id = ?
      LIMIT 1 FOR UPDATE`,
    [safeString(legacyAdminId)]
  );
  const grant = rows[0];
  if (!grant) return { revoked: false };
  if (grant.admin_level === 'super_admin' && !safeString(grant.org_id)
    && grant.status === 'active' && grant.account_status === 'verified') {
    const [boundRows] = await connection.query(
      `SELECT DISTINCT other.person_id
         FROM admin_grants other
         JOIN accounts a ON a.person_id = other.person_id AND a.status = 'verified'
         JOIN persons p ON p.id = a.person_id AND p.status = 'active'
        WHERE other.admin_level = 'super_admin' AND other.org_id = '' AND other.status = 'active'
          AND ${usableLoginCredentialSql('a')}
        FOR UPDATE`
    );
    if (boundRows.length <= 1) {
      throw new IdentityError('last_bound_super_admin', localeCopy.copy_23d656758f, 409);
    }
  }
  await connection.query(
    "UPDATE admin_grants SET status = 'revoked', updated_at = NOW() WHERE id = ?",
    [grant.id]
  );
  if (grant.account_id) {
    await connection.query(
      `UPDATE accounts SET token_version = token_version + 1, updated_at = NOW()
        WHERE id = ?`,
      [grant.account_id]
    );
    await connection.query(
      `UPDATE auth_sessions SET status = 'revoked', revoked_at = NOW()
        WHERE account_id = ? AND context_type = 'admin' AND status = 'active'`,
      [grant.account_id]
    );
  }
  return { revoked: true };
}

async function createBootstrapSession(openid) {
  const id = generateId();
  const openidHash = hmac(openid);
  await pool.query(
    `INSERT INTO auth_bootstrap_sessions
       (id, openid_hash, openid_ciphertext, status, expires_at)
     VALUES (?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [id, openidHash, encryptOpenid(openid), BOOTSTRAP_MINUTES]
  );
  return { id, openidHash, expiresInSeconds: BOOTSTRAP_MINUTES * 60 };
}

async function getBootstrapSession(id, lock, connection) {
  const executor = connection || pool;
  const [rows] = await executor.query(
    `SELECT *
       FROM auth_bootstrap_sessions
      WHERE id = ? AND status = 'active' AND expires_at > NOW()
        AND (locked_until IS NULL OR locked_until <= NOW())
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [safeString(id)]
  );
  return rows[0] || null;
}

async function listContexts(accountId, connection) {
  const executor = connection || pool;
  // 所有认证方式共用账号状态限制，口令会话不能绕过冻结或恢复要求。
  const accountStatusCondition = "a.status = 'verified'";
  const [assignmentRows] = await executor.query(
    `SELECT ma.id AS assignment_id, ma.title AS assignment_title, ma.assignment_kind,
            ma.department_id, ma.identity_id, ma.work_group_id,
            om.id AS membership_id, om.org_id AS organization_id, om.legacy_hr_id,
            p.id AS person_id, p.name AS person_name, p.student_id,
            o.name AS organization_name, d.name AS department_name,
            i.name AS identity_name, w.name AS work_group_name
       FROM accounts a
       JOIN persons p ON p.id = a.person_id AND p.status = 'active'
       JOIN organization_memberships om ON om.person_id = p.id AND om.status = 'active'
       JOIN membership_assignments ma ON ma.membership_id = om.id
         AND ma.org_id = om.org_id AND ma.status = 'active'
       JOIN organizations o
         ON CONVERT(o.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = om.org_id
       LEFT JOIN departments d
         ON CONVERT(d.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.department_id
        AND CONVERT(d.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = om.org_id
       LEFT JOIN identities i
         ON CONVERT(i.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.identity_id
        AND CONVERT(i.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = om.org_id
       LEFT JOIN work_groups w
         ON CONVERT(w.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ma.work_group_id
        AND CONVERT(w.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = om.org_id
       WHERE a.id = ? AND ${accountStatusCondition}
      ORDER BY o.created_at DESC, ma.created_at ASC, ma.id ASC`,
    [safeString(accountId)]
  );
  const [membershipRows] = await executor.query(
    `SELECT om.id AS membership_id, om.org_id AS organization_id, om.legacy_hr_id,
            p.id AS person_id, p.name AS person_name, p.student_id,
            o.name AS organization_name
       FROM accounts a
       JOIN persons p ON p.id = a.person_id AND p.status = 'active'
       JOIN organization_memberships om ON om.person_id = p.id AND om.status = 'active'
       JOIN organizations o
         ON CONVERT(o.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = om.org_id
       WHERE a.id = ? AND ${accountStatusCondition}
        AND NOT EXISTS (
          SELECT 1
            FROM membership_assignments ma
           WHERE ma.membership_id = om.id AND ma.org_id = om.org_id AND ma.status = 'active'
        )
      ORDER BY o.created_at DESC, om.created_at ASC, om.id ASC`,
    [safeString(accountId)]
  );
  const [adminRows] = await executor.query(
    `SELECT ag.id AS admin_grant_id, ag.org_id AS grant_org_id, ag.admin_level,
            ag.legacy_admin_id, p.id AS person_id, p.name AS person_name, p.student_id,
            o.id AS organization_id, o.name AS organization_name
       FROM accounts a
       JOIN persons p ON p.id = a.person_id AND p.status = 'active'
       JOIN admin_grants ag ON ag.person_id = p.id AND ag.status = 'active'
       JOIN organizations o ON (ag.admin_level = 'super_admin' AND ag.org_id = '')
                              OR CONVERT(o.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = ag.org_id
       WHERE a.id = ? AND ${accountStatusCondition}
      ORDER BY ag.admin_level = 'super_admin' DESC, o.created_at DESC`,
    [safeString(accountId)]
  );
  const contexts = assignmentRows.map(mapAssignmentContext)
    .concat(membershipRows.map(mapMembershipContext))
    .concat(adminRows.map(mapAdminContext));
  const seen = new Set();
  return contexts.filter((item) => {
    if (!item.contextId || seen.has(item.contextId)) return false;
    seen.add(item.contextId);
    return true;
  });
}

function contextRank(context) {
  if (context.identityType === 'assignment') return 0;
  if (context.identityType === 'membership') return 1;
  if (context.adminLevel !== 'super_admin') return 2;
  return 3;
}

function chooseFallbackContext(contexts, preferredOrganizationId) {
  const orgId = safeString(preferredOrganizationId);
  const scoped = orgId
    ? contexts.filter((item) => item.organizationId === orgId)
    : [];
  const candidates = scoped.length ? scoped : contexts;
  return candidates.slice().sort((left, right) => contextRank(left) - contextRank(right))[0] || null;
}

async function resolveContextSelection(accountId, requestedSelection, connection) {
  const contexts = await listContexts(accountId, connection);
  if (!contexts.length) return { context: null, fallback: false, reason: 'no_context' };
  const selection = requestedSelection && typeof requestedSelection === 'object'
    ? requestedSelection
    : { contextId: requestedSelection };
  const requestedContextId = safeString(selection.contextId);
  const requestedOrganizationId = safeString(selection.organizationId);
  const requestedIdentityId = safeString(selection.identityId);
  const hasPreference = Boolean(requestedContextId || requestedOrganizationId || requestedIdentityId);
  let matched = null;
  if (requestedContextId) {
    matched = contexts.find((item) => item.contextId === requestedContextId) || null;
  }
  if (!matched && requestedOrganizationId && requestedIdentityId) {
    matched = contexts.find((item) => (
      item.organizationId === requestedOrganizationId
      && item.authIdentityId === requestedIdentityId
    )) || null;
  }
  if (matched) return { context: matched, fallback: false, reason: '' };
  const fallback = chooseFallbackContext(contexts, requestedOrganizationId);
  return {
    context: fallback,
    fallback: hasPreference,
    reason: hasPreference ? 'selection_unavailable' : ''
  };
}

async function resolveContext(accountId, requestedSelection, connection) {
  const resolved = await resolveContextSelection(accountId, requestedSelection, connection);
  return resolved.context;
}

async function createSession(account, requestedSelection, metadata, options) {
  return pool.withTransaction(async (connection) => {
    const temporary = Boolean(options && options.temporary);
    const [accountRows] = await connection.query(
      `SELECT a.id, a.person_id, a.status, a.token_version,
              b.openid_hash AS binding_openid_hash, b.id AS binding_id
         FROM accounts a
         LEFT JOIN account_wechat_bindings b ON b.account_id = a.id
           AND b.app_id = ? AND b.status = 'active'
        WHERE a.id = ? AND a.status = 'verified'
        LIMIT 1 FOR UPDATE`,
      [APP_ID, safeString(account.id)]
    );
    const activeAccount = accountRows[0];
    if (!activeAccount) throw new IdentityError('account_unavailable', localeCopy.copy_0995192dbd, 401);
    const bindingOpenidHash = safeString(activeAccount.binding_openid_hash);
    const temporaryOpenidHash = safeString(options && options.openidHash);
    const temporaryOpenidCiphertext = safeString(options && options.openidCiphertext);
    if (!temporary && !bindingOpenidHash) {
      throw new IdentityError('binding_missing', localeCopy.copy_518fa5022c, 401);
    }
    const resolvedSelection = await resolveContextSelection(
      activeAccount.id,
      requestedSelection,
      connection
    );
    const activeContext = resolvedSelection.context;
    if (!activeContext) throw new IdentityError('no_context', localeCopy.copy_13f29f572b, 403);
    const id = generateId();
    // 口令会话的旧字段仅保存随机占位摘要；不能用于定位人员或扩大权限。
    const openidHash = temporary ? temporaryOpenidHash || crypto.randomBytes(32).toString('hex') : bindingOpenidHash;
    const bindingMode = temporary ? 'temporary' : 'bound';
    const openidCiphertext = temporary ? temporaryOpenidCiphertext : null;
    await connection.query(
      `INSERT INTO auth_sessions
         (id, account_id, openid_hash, binding_mode, openid_ciphertext,
          context_id, context_type, context_subject_id,
          organization_id, role, token_version, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [
        id,
        activeAccount.id,
        openidHash,
        bindingMode,
        openidCiphertext,
        activeContext.contextId,
        activeContext.identityType,
        activeContext.assignmentId || activeContext.adminGrantId || activeContext.membershipId,
        activeContext.organizationId,
        activeContext.role,
        Number(activeAccount.token_version || 1),
        SESSION_MINUTES
      ]
    );
    await appendAuditEvent({
      connection,
      eventType: temporary ? 'temporary_password_session_created' : 'wechat_session_created',
      actorPersonId: activeAccount.person_id,
      targetPersonId: activeAccount.person_id,
      accountId: activeAccount.id,
      organizationId: activeContext.organizationId,
      contextId: activeContext.contextId,
      requestId: metadata && metadata.requestId,
      ip: metadata && metadata.ip,
      detail: { role: activeContext.role, temporary }
    });
    return {
      id,
      context: activeContext,
      tokenVersion: Number(activeAccount.token_version || 1),
      expiresInSeconds: SESSION_MINUTES * 60,
      bindingMode,
      deviceRecognized: false,
      deviceKeyHash: null,
      selectionFallback: resolvedSelection.fallback,
      selectionFallbackReason: resolvedSelection.reason
    };
  });
}

async function loadSession(id) {
  const [rows] = await pool.query(
    `SELECT s.*, a.person_id, a.status AS account_status, a.token_version AS account_token_version,
            p.name, p.student_id,
            b.openid_ciphertext AS binding_openid_ciphertext,
            b.legacy_openid AS binding_legacy_openid,
            b.id AS binding_id
       FROM auth_sessions s
       JOIN accounts a ON a.id = s.account_id
       JOIN persons p ON p.id = a.person_id
       LEFT JOIN account_wechat_bindings b ON b.account_id = a.id
         AND b.app_id = ? AND b.status = 'active'
      WHERE s.id = ? AND s.status = 'active' AND s.expires_at > NOW()
        AND p.status = 'active'
      LIMIT 1`,
    [APP_ID, safeString(id)]
  );
  const session = rows[0] || null;
  if (!session || Number(session.token_version) !== Number(session.account_token_version)) return null;
  const temporary = safeString(session.binding_mode) === 'temporary';
  if (!['bound', 'temporary'].includes(safeString(session.binding_mode))) return null;
  if (session.account_status !== 'verified' || (!temporary && !session.binding_id)) return null;
  const activeContext = await resolveContext(
    session.account_id,
    session.context_id,
    null
  );
  if (!activeContext || activeContext.contextId !== session.context_id) return null;
  await pool.query(
    'UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = ? AND last_seen_at < DATE_SUB(NOW(), INTERVAL 1 MINUTE)',
    [session.id]
  );
  // 会话身份由账号与工作角色确定。可选绑定材料只在用户明确绑定时解密。
  return { session, context: activeContext, openid: '' };
}

async function activateSelection(sessionId, accountId, requestedSelection) {
  return pool.withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT * FROM auth_sessions
        WHERE id = ? AND account_id = ? AND status = 'active' AND expires_at > NOW()
        LIMIT 1 FOR UPDATE`,
      [safeString(sessionId), safeString(accountId)]
    );
    const session = rows[0];
    if (!session) throw new IdentityError('session_expired', localeCopy.copy_c337bd9350, 401);
    const contexts = await listContexts(accountId, connection);
    const selection = requestedSelection && typeof requestedSelection === 'object'
      ? requestedSelection
      : { contextId: requestedSelection };
    const requestedContextId = safeString(selection.contextId);
    const requestedOrganizationId = safeString(selection.organizationId);
    const requestedIdentityId = safeString(selection.identityId);
    const activeContext = requestedContextId
      ? contexts.find((item) => item.contextId === requestedContextId)
      : contexts.find((item) => (
        item.organizationId === requestedOrganizationId
        && item.authIdentityId === requestedIdentityId
      ));
    if (!activeContext) {
      throw new IdentityError('context_forbidden', localeCopy.copy_8d32be8b00, 403);
    }
    await connection.query(
      `UPDATE auth_sessions
          SET context_id = ?, context_type = ?, context_subject_id = ?,
              organization_id = ?, role = ?, last_seen_at = NOW()
        WHERE id = ?`,
      [
        activeContext.contextId,
        activeContext.identityType,
        activeContext.assignmentId || activeContext.adminGrantId || activeContext.membershipId,
        activeContext.organizationId,
        activeContext.role,
        sessionId
      ]
    );
    return activeContext;
  });
}

async function activateContext(sessionId, accountId, requestedContextId) {
  return activateSelection(sessionId, accountId, { contextId: requestedContextId });
}

async function syncLegacyBindings(connection, accountId, openidOrLoader) {
  const openid = typeof openidOrLoader === 'function'
    ? await openidOrLoader()
    : safeString(openidOrLoader);
  if (!openid) throw new IdentityError('binding_missing', localeCopy.copy_518fa5022c, 401);
  const [membershipRows] = await connection.query(
    `SELECT om.id, om.org_id, om.legacy_hr_id
       FROM accounts a
       JOIN organization_memberships om ON om.person_id = a.person_id AND om.status = 'active'
      WHERE a.id = ?`,
    [accountId]
  );
  for (const membership of membershipRows) {
    const [existingRows] = await connection.query(
      'SELECT id, hr_id FROM user_info WHERE openid = ? AND org_id = ? LIMIT 1 FOR UPDATE',
      [openid, membership.org_id]
    );
    if (existingRows.length && safeString(existingRows[0].hr_id) !== safeString(membership.legacy_hr_id)) {
      throw new IdentityError('wechat_conflict', localeCopy.copy_c445c4571a, 409);
    }
    await connection.query(
      `INSERT INTO user_info (id, openid, hr_id, org_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE hr_id = VALUES(hr_id), updated_at = NOW()`,
      [existingRows[0] ? existingRows[0].id : generateId(), openid, membership.legacy_hr_id, membership.org_id]
    );
  }
  await connection.query(
    `UPDATE admin_info ai
       JOIN admin_grants ag
         ON ag.legacy_admin_id =
            CONVERT(ai.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
       JOIN accounts a ON a.person_id = ag.person_id
        SET ai.openid = ?, ai.bind_status = 'active', ai.bound_at = COALESCE(ai.bound_at, NOW()),
            ai.invite_code = NULL, ai.invite_expires_at = NULL, ai.updated_at = NOW()
      WHERE a.id = ? AND ag.status = 'active'`,
    [openid, accountId]
  );
  return openid;
}

async function createClaim(bootstrapId, data) {
  const publicClaimId = generateId();
  const studentId = normalizeStudentId(data.studentId);
  const name = normalizeName(data.name);
  const orgId = safeString(data.organizationId);
  if (!studentId || !name || !orgId) {
    throw new IdentityError('invalid_params', localeCopy.copy_f162fa8c06, 400);
  }
  return pool.withTransaction(async (connection) => {
    const bootstrap = await getBootstrapSession(bootstrapId, true, connection);
    if (!bootstrap) throw new IdentityError('bootstrap_expired', localeCopy.copy_ffadbecb8f, 401);
    const [personRows] = await connection.query(
      `SELECT p.id
         FROM persons p
         JOIN organization_memberships om ON om.person_id = p.id
        WHERE p.normalized_student_id = ? AND p.name = ? AND p.status = 'active'
          AND om.org_id = ? AND om.status = 'active'
        LIMIT 1 FOR UPDATE`,
      [studentId, name, orgId]
    );
    if (!personRows.length) {
      throw new IdentityError('identity_not_found', localeCopy.copy_71b59f6dd1, 404);
    }
    const personId = personRows[0].id;
    const [boundRows] = await connection.query(
      `SELECT 1
         FROM accounts a
         JOIN account_wechat_bindings b ON b.account_id = a.id AND b.status = 'active'
        WHERE a.person_id = ?
        LIMIT 1`,
      [personId]
    );
    if (boundRows.length) {
      throw new IdentityError('already_verified', localeCopy.copy_e879ade127, 409);
    }
    const [existingWithActiveCode] = await connection.query(
      `SELECT r.id
         FROM identity_claim_requests r
         JOIN identity_verification_tokens t
           ON t.claim_request_id = r.id AND t.status = 'active' AND t.expires_at > NOW()
        WHERE r.person_id = ? AND r.status = 'pending'
        LIMIT 1 FOR UPDATE`,
      [personId]
    );
    if (existingWithActiveCode.length) {
      return { claimId: safeString(existingWithActiveCode[0].id), accepted: true };
    }
    await connection.query(
      `UPDATE identity_claim_requests
          SET status = 'superseded', updated_at = NOW()
        WHERE person_id = ? AND status = 'pending'`,
      [personId]
    );
    await connection.query(
      `INSERT INTO identity_claim_requests
         (id, person_id, requested_org_id, openid_hash, status, expires_at)
       VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [publicClaimId, personId, orgId, bootstrap.openid_hash, CLAIM_HOURS]
    );
    await appendAuditEvent({
      connection,
      eventType: 'identity_claim_started',
      targetPersonId: personId,
      organizationId: orgId,
      requestId: data.requestId,
      ip: data.ip
    });
    return { claimId: publicClaimId, accepted: true };
  });
}

async function listClaims(organizationId, options) {
  const orgId = safeString(organizationId);
  const limit = Math.min(Math.max(Number(options && options.limit) || 200, 1), MAX_AUTH_DIRECTORY_LIMIT);
  const params = [];
  let scopeSql = '';
  if (orgId) {
    scopeSql = "AND EXISTS (SELECT 1 FROM organization_memberships scope_m WHERE scope_m.person_id = r.person_id AND scope_m.org_id = ? AND scope_m.status = 'active')";
    params.push(orgId);
  }
  const search = safeString(options && options.search);
  if (search) {
    scopeSql += ' AND (p.name LIKE ? OR p.student_id LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT r.id, r.requested_org_id, r.status, r.created_at, r.expires_at,
            p.id AS person_id, p.name, p.student_id, o.name AS requested_org_name,
            EXISTS (
              SELECT 1 FROM identity_verification_tokens t
               WHERE t.claim_request_id = r.id AND t.status = 'active' AND t.expires_at > NOW()
            ) AS has_active_code
       FROM identity_claim_requests r
       JOIN persons p ON p.id = r.person_id
       JOIN organizations o
         ON CONVERT(o.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = r.requested_org_id
      WHERE r.status = 'pending' AND r.expires_at > NOW()
        ${scopeSql}
      ORDER BY r.created_at ASC
      LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    id: safeString(row.id),
    personId: safeString(row.person_id),
    name: safeString(row.name),
    studentId: safeString(row.student_id),
    requestedOrganizationId: safeString(row.requested_org_id),
    requestedOrganizationName: safeString(row.requested_org_name),
    hasActiveCode: Boolean(row.has_active_code),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));
}

async function issueVerificationCodeWithConnection(connection, claimId, actor, metadata) {
  const [rows] = await connection.query(
    `SELECT r.*, EXISTS (
        SELECT 1 FROM organization_memberships om
         WHERE om.person_id = r.person_id AND om.org_id = ? AND om.status = 'active'
       ) AS actor_org_matches
       FROM identity_claim_requests r
       JOIN persons p ON p.id = r.person_id AND p.status = 'active'
       JOIN organization_memberships requested_membership
         ON requested_membership.person_id = r.person_id
        AND requested_membership.org_id = r.requested_org_id
        AND requested_membership.status = 'active'
      WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > NOW()
      LIMIT 1 FOR UPDATE`,
    [safeString(actor.organizationId), safeString(claimId)]
  );
  const claim = rows[0];
  if (!claim) throw new IdentityError('claim_unavailable', localeCopy.copy_3e9f5046ae, 409);
  if (actor.adminLevel !== 'super_admin' && !Boolean(claim.actor_org_matches)) {
    throw new IdentityError('claim_forbidden', localeCopy.copy_9bc4da7866, 403);
  }
  const code = randomCode(12);
  await connection.query(
    `UPDATE identity_verification_tokens
        SET status = 'superseded'
      WHERE claim_request_id = ? AND status = 'active'`,
    [claim.id]
  );
  await connection.query(
    `INSERT INTO identity_verification_tokens
       (id, claim_request_id, person_id, issued_by_person_id, issued_by_context_id,
        token_hash, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [
      generateId(),
      claim.id,
      claim.person_id,
      actor.personId,
      actor.contextId,
      hmac('identity-code:' + claim.id + ':' + code),
      VERIFY_TOKEN_HOURS
    ]
  );
  await appendAuditEvent({
    connection,
    eventType: 'identity_code_issued',
    actorPersonId: actor.personId,
    targetPersonId: claim.person_id,
    organizationId: actor.organizationId,
    contextId: actor.contextId,
    requestId: metadata && metadata.requestId,
    ip: metadata && metadata.ip
  });
  return { claimId: safeString(claim.id), code, expiresInHours: VERIFY_TOKEN_HOURS };
}

async function issueVerificationCode(claimId, actor, metadata) {
  return pool.withTransaction((connection) => (
    issueVerificationCodeWithConnection(connection, claimId, actor, metadata)
  ));
}

async function issueVerificationCodes(claimIds, actor, metadata) {
  const normalizedIds = Array.from(new Set(
    (Array.isArray(claimIds) ? claimIds : []).map(safeString).filter(Boolean)
  )).slice(0, 50);
  if (!normalizedIds.length) {
    throw new IdentityError('invalid_params', localeCopy.copy_d0970707a8, 400);
  }
  return pool.withTransaction(async (connection) => {
    const issued = [];
    for (const claimId of normalizedIds) {
      issued.push(await issueVerificationCodeWithConnection(
        connection,
        claimId,
        actor,
        metadata
      ));
    }
    return issued;
  });
}

async function revokeVerificationCodes(claimIds, actor, metadata) {
  const normalizedIds = Array.from(new Set(
    (Array.isArray(claimIds) ? claimIds : []).map(safeString).filter(Boolean)
  )).slice(0, 50);
  if (!normalizedIds.length) {
    throw new IdentityError('invalid_params', localeCopy.copy_d0970707a8, 400);
  }
  return pool.withTransaction(async (connection) => {
    const revokedClaimIds = [];
    for (const claimId of normalizedIds) {
      const [rows] = await connection.query(
        `SELECT r.id, r.person_id, EXISTS (
            SELECT 1 FROM organization_memberships om
             WHERE om.person_id = r.person_id AND om.org_id = ? AND om.status = 'active'
          ) AS actor_org_matches
           FROM identity_claim_requests r
          WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > NOW()
          LIMIT 1 FOR UPDATE`,
        [safeString(actor.organizationId), claimId]
      );
      const claim = rows[0];
      if (!claim) throw new IdentityError('claim_unavailable', localeCopy.copy_3e9f5046ae, 409);
      if (actor.adminLevel !== 'super_admin' && !Boolean(claim.actor_org_matches)) {
        throw new IdentityError('claim_forbidden', localeCopy.copy_9bc4da7866, 403);
      }
      await connection.query(
        `UPDATE identity_verification_tokens
            SET status = 'revoked'
          WHERE claim_request_id = ? AND status = 'active'`,
        [claim.id]
      );
      await appendAuditEvent({
        connection,
        eventType: 'identity_code_revoked',
        actorPersonId: actor.personId,
        targetPersonId: claim.person_id,
        organizationId: actor.organizationId,
        contextId: actor.contextId,
        requestId: metadata && metadata.requestId,
        ip: metadata && metadata.ip
      });
      revokedClaimIds.push(safeString(claim.id));
    }
    return revokedClaimIds;
  });
}

async function verifyClaim(bootstrapId, claimId, code, metadata) {
  const result = await pool.withTransaction(async (connection) => {
    const bootstrap = await getBootstrapSession(bootstrapId, true, connection);
    if (!bootstrap) throw new IdentityError('bootstrap_expired', localeCopy.copy_ffadbecb8f, 401);
    const policy = await getPolicy(connection);
    const now = Date.now();
    if (!policy
      || !policy.initial_claim_enabled
      || (policy.claim_starts_at && new Date(policy.claim_starts_at).getTime() > now)
      || (policy.claim_ends_at && new Date(policy.claim_ends_at).getTime() < now)) {
      throw new IdentityError('claim_paused', localeCopy.copy_cd1cedd0b0, 403);
    }
    const [claimRows] = await connection.query(
      `SELECT r.*
         FROM identity_claim_requests r
         JOIN persons p ON p.id = r.person_id AND p.status = 'active'
         JOIN organization_memberships om
           ON om.person_id = r.person_id AND om.org_id = r.requested_org_id AND om.status = 'active'
        WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > NOW()
          AND (r.locked_until IS NULL OR r.locked_until <= NOW())
        LIMIT 1 FOR UPDATE`,
      [safeString(claimId)]
    );
    const claim = claimRows[0];
    if (!claim) {
      await connection.query(
        `UPDATE auth_bootstrap_sessions
            SET failed_attempts = failed_attempts + 1,
                locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until)
          WHERE id = ?`,
        [MAX_VERIFY_ATTEMPTS, bootstrap.id]
      );
      return { authenticationFailure: 'verification_failed' };
    }
    const [tokenRows] = await connection.query(
      `SELECT *
         FROM identity_verification_tokens
        WHERE claim_request_id = ? AND status = 'active' AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [claim.id]
    );
    const verification = tokenRows[0];
    const matches = verification
      && verification.person_id === claim.person_id
      && secureEqualHex(
        verification.token_hash,
        hmac('identity-code:' + claim.id + ':' + safeString(code).toUpperCase())
      );
    if (!matches) {
      const attempts = Number(claim.failed_attempts || 0) + 1;
      await connection.query(
        `UPDATE identity_claim_requests
            SET failed_attempts = ?,
                locked_until = IF(? >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until),
                updated_at = NOW()
          WHERE id = ?`,
        [attempts, attempts, MAX_VERIFY_ATTEMPTS, claim.id]
      );
      await connection.query(
        `UPDATE auth_bootstrap_sessions
            SET failed_attempts = failed_attempts + 1,
                locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until)
          WHERE id = ?`,
        [MAX_VERIFY_ATTEMPTS, bootstrap.id]
      );
      return { authenticationFailure: 'verification_failed' };
    }
    const [accountRows] = await connection.query(
      `SELECT a.*,
              EXISTS (
                SELECT 1
                  FROM account_wechat_bindings b
                 WHERE b.account_id = a.id AND b.status = 'active'
              ) AS has_active_binding
         FROM accounts a
        WHERE a.person_id = ?
        LIMIT 1 FOR UPDATE`,
      [claim.person_id]
    );
    let account = accountRows[0];
    if (account && account.status === 'frozen') {
      throw new IdentityError('account_frozen', localeCopy.copy_d6a178f6ce, 403);
    }
    if (account && account.status === 'verified' && Boolean(account.has_active_binding)) {
      throw new IdentityError('recovery_required', localeCopy.copy_3364144ea9, 409);
    }
    const accountId = account ? account.id : generateId();
    if (!account) {
      await connection.query(
        `INSERT INTO accounts (id, person_id, status, token_version, verified_at)
         VALUES (?, ?, 'verified', 1, NOW())`,
        [accountId, claim.person_id]
      );
    } else {
      await connection.query(
        `UPDATE accounts
            SET status = 'verified', token_version = token_version + 1,
                verified_at = NOW(), recovery_required_at = NULL
          WHERE id = ?`,
        [accountId]
      );
    }
    const openid = decryptOpenid(bootstrap.openid_ciphertext);
    await insertActiveWechatBinding(connection, accountId, openid);
    await syncLegacyBindings(connection, accountId, openid);
    await connection.query(
      `UPDATE identity_verification_tokens
          SET status = 'consumed', consumed_at = NOW()
        WHERE id = ?`,
      [verification.id]
    );
    await connection.query(
      `UPDATE identity_claim_requests
          SET status = 'verified', verified_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [claim.id]
    );
    await connection.query(
      `UPDATE auth_bootstrap_sessions
          SET status = 'consumed', consumed_at = NOW()
        WHERE id = ?`,
      [bootstrap.id]
    );
    await appendAuditEvent({
      connection,
      eventType: 'identity_claim_verified',
      targetPersonId: claim.person_id,
      accountId,
      organizationId: claim.requested_org_id,
      requestId: metadata && metadata.requestId,
      ip: metadata && metadata.ip
    });
    const [freshRows] = await connection.query(
      `SELECT a.*, b.openid_hash, p.name, p.student_id
         FROM accounts a
         JOIN account_wechat_bindings b ON b.account_id = a.id AND b.status = 'active'
         JOIN persons p ON p.id = a.person_id
        WHERE a.id = ?`,
      [accountId]
    );
    return freshRows[0];
  });
  if (result && result.authenticationFailure) {
    throw new IdentityError('verification_failed', localeCopy.copy_ef2bb7ee30, 400);
  }
  return result;
}

async function getPolicy(connection) {
  const executor = connection || pool;
  const [rows] = await executor.query('SELECT * FROM auth_policy WHERE id = ? LIMIT 1', ['default']);
  return rows[0] || null;
}

async function savePolicy(data, actor) {
  const claimStartsAt = normalizePolicyDate(data.claimStartsAt, '认证开始时间');
  const claimEndsAt = normalizePolicyDate(data.claimEndsAt, '认证截止时间');
  if (claimStartsAt && claimEndsAt && policyTimestamp(claimStartsAt) >= policyTimestamp(claimEndsAt)) {
    throw new IdentityError('invalid_policy_time', localeCopy.copy_b0e6d46935, 400);
  }
  return pool.withTransaction(async (connection) => {
    const [policyRows] = await connection.query(
      "SELECT * FROM auth_policy WHERE id = 'default' LIMIT 1 FOR UPDATE"
    );
    const previous = policyRows[0] || {};
    const scheduleChanged = Boolean(previous.initial_claim_enabled) !== Boolean(data.initialClaimEnabled)
      || policyTimestamp(previous.claim_starts_at) !== policyTimestamp(claimStartsAt)
      || policyTimestamp(previous.claim_ends_at) !== policyTimestamp(claimEndsAt);
    await connection.query(
      `UPDATE auth_policy
          SET initial_claim_enabled = ?, claim_starts_at = ?, claim_ends_at = ?,
              allow_recovery_code = ?, allow_passphrase = ?, passphrase_min_length = 12,
              updated_by_person_id = ?, updated_at = NOW()
        WHERE id = 'default'`,
      [
        data.initialClaimEnabled ? 1 : 0,
        claimStartsAt,
        claimEndsAt,
        data.allowRecoveryCode ? 1 : 0,
        data.allowPassphrase ? 1 : 0,
        actor.personId
      ]
    );
    if (scheduleChanged) {
      await connection.query(
        `UPDATE identity_verification_tokens t
         JOIN identity_claim_requests r ON r.id = t.claim_request_id
            SET t.status = 'revoked', r.status = 'paused', r.updated_at = NOW()
          WHERE t.status = 'active' AND r.status = 'pending'`
      );
    }
    await appendAuditEvent({
      connection,
      eventType: 'auth_policy_updated',
      actorPersonId: actor.personId,
      organizationId: actor.organizationId,
      contextId: actor.contextId,
      detail: {
        initialClaimEnabled: Boolean(data.initialClaimEnabled),
        scheduleChanged,
        allowRecoveryCode: Boolean(data.allowRecoveryCode),
        allowPassphrase: Boolean(data.allowPassphrase)
      }
    });
    return getPolicy(connection);
  });
}

async function configureRecoveryCredential(accountId, method, value, connection) {
  const executor = connection || pool;
  const policy = await getPolicy(executor);
  if (!policy) throw new IdentityError('policy_unavailable', localeCopy.copy_485abf3ee5, 503);
  if (method === 'recovery_code' && !policy.allow_recovery_code) {
    throw new IdentityError('method_disabled', localeCopy.copy_f07aa06bda, 403);
  }
  if (method === 'passphrase' && !policy.allow_passphrase) {
    throw new IdentityError('method_disabled', localeCopy.copy_329340742b, 403);
  }
  let plaintext = method === 'passphrase' ? normalizePassphrase(value) : safeString(value);
  if (method === 'recovery_code') plaintext = randomCode(20);
  if (method === 'passphrase' && !isPassphraseLengthValid(plaintext)) {
    throw new IdentityError('passphrase_length_invalid', securityCopy.passphraseLengthInvalid, 400);
  }
  if (method === 'passphrase' && /^(123456|password|qwerty|111111|abcdef)/i.test(plaintext)) {
    throw new IdentityError('weak_passphrase', localeCopy.copy_a1708b8b9d, 400);
  }
  const credential = hashPassphrase(plaintext);
  await executor.query(
    `INSERT INTO account_recovery_credentials
       (id, account_id, method, credential_hash, salt, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE credential_hash = VALUES(credential_hash), salt = VALUES(salt),
       status = 'active', failed_attempts = 0, locked_until = NULL, expires_at = NULL,
       used_at = NULL, updated_at = NOW()`,
    [generateId(), accountId, method, credential.hash, credential.salt]
  );
  return method === 'recovery_code' ? { recoveryCode: plaintext } : { configured: true };
}

async function startRecovery(bootstrapId, data, metadata) {
  const publicRequestId = generateId();
  const studentId = normalizeStudentId(data.studentId);
  const name = normalizeName(data.name);
  const orgId = safeString(data.organizationId);
  if (!studentId || !name || !orgId) {
    throw new IdentityError('invalid_params', localeCopy.copy_f162fa8c06, 400);
  }
  return pool.withTransaction(async (connection) => {
    const bootstrap = await getBootstrapSession(bootstrapId, true, connection);
    if (!bootstrap) throw new IdentityError('bootstrap_expired', localeCopy.copy_ffadbecb8f, 401);
    const [rows] = await connection.query(
      `SELECT p.id AS person_id, a.id AS account_id, a.status AS account_status
         FROM persons p
         JOIN accounts a ON a.person_id = p.id
         JOIN organization_memberships om ON om.person_id = p.id
        WHERE p.normalized_student_id = ? AND p.name = ? AND p.status = 'active'
          AND om.org_id = ? AND om.status = 'active'
        LIMIT 1 FOR UPDATE`,
      [studentId, name, orgId]
    );
    if (!rows.length) {
      throw new IdentityError('identity_not_found', localeCopy.copy_71b59f6dd1, 404);
    }
    if (rows[0].account_status === 'frozen') {
      return { recoveryRequestId: publicRequestId, accepted: true };
    }
    await connection.query(
      `UPDATE account_recovery_requests
          SET status = 'superseded', updated_at = NOW()
        WHERE account_id = ? AND status = 'pending'`,
      [rows[0].account_id]
    );
    await connection.query(
      `INSERT INTO account_recovery_requests
         (id, person_id, account_id, requested_org_id, new_openid_hash, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [publicRequestId, rows[0].person_id, rows[0].account_id, orgId, bootstrap.openid_hash, RECOVERY_HOURS]
    );
    await appendAuditEvent({
      connection,
      eventType: 'account_recovery_started',
      targetPersonId: rows[0].person_id,
      accountId: rows[0].account_id,
      organizationId: orgId,
      requestId: metadata && metadata.requestId,
      ip: metadata && metadata.ip
    });
    return { recoveryRequestId: publicRequestId, accepted: true };
  });
}

async function completeRecoveryWithCredential(bootstrapId, recoveryRequestId, method, credentialValue, metadata) {
  const result = await pool.withTransaction(async (connection) => {
    const bootstrap = await getBootstrapSession(bootstrapId, true, connection);
    if (!bootstrap) throw new IdentityError('bootstrap_expired', localeCopy.copy_ffadbecb8f, 401);
    const [requestRows] = await connection.query(
      `SELECT r.*
         FROM account_recovery_requests r
         JOIN persons p ON p.id = r.person_id AND p.status = 'active'
         JOIN accounts a ON a.id = r.account_id AND a.person_id = r.person_id
        WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > NOW()
          AND r.new_openid_hash = ?
        LIMIT 1 FOR UPDATE`,
      [safeString(recoveryRequestId), bootstrap.openid_hash]
    );
    const request = requestRows[0];
    if (!request) throw new IdentityError('recovery_failed', localeCopy.copy_33dbab4037, 400);
    const policy = await getPolicy(connection);
    const allowed = method === 'recovery_code'
      ? Boolean(policy && policy.allow_recovery_code)
      : Boolean(policy && policy.allow_passphrase);
    if (!allowed) throw new IdentityError('method_disabled', localeCopy.copy_75c1e85105, 403);
    const [credentialRows] = await connection.query(
      `SELECT *
         FROM account_recovery_credentials
        WHERE account_id = ? AND method = ? AND status = 'active'
          AND (locked_until IS NULL OR locked_until <= NOW())
        LIMIT 1 FOR UPDATE`,
      [request.account_id, method]
    );
    const credential = credentialRows[0];
    if (!credential || !verifyPassphrase(credentialValue, credential.salt, credential.credential_hash)) {
      if (credential) {
        const attempts = Number(credential.failed_attempts || 0) + 1;
        await connection.query(
          `UPDATE account_recovery_credentials
              SET failed_attempts = ?,
                  locked_until = IF(? >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until),
                  updated_at = NOW()
            WHERE id = ?`,
          [attempts, attempts, MAX_RECOVERY_ATTEMPTS, credential.id]
        );
      }
      await connection.query(
        `UPDATE auth_bootstrap_sessions
            SET failed_attempts = failed_attempts + 1,
                locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until)
          WHERE id = ?`,
        [MAX_RECOVERY_ATTEMPTS, bootstrap.id]
      );
      return { authenticationFailure: 'recovery_failed' };
    }
    return transferWechatBinding(connection, {
      accountId: request.account_id,
      personId: request.person_id,
      bootstrap,
      recoveryRequestId: request.id,
      credential,
      metadata
    });
  });
  if (result && result.authenticationFailure) {
    throw new IdentityError('recovery_failed', localeCopy.copy_f003820e19, 400);
  }
  return result;
}

async function transferWechatBinding(connection, data) {
  const [accountRowsForUpdate] = await connection.query(
    `SELECT a.status, a.person_id, p.status AS person_status
       FROM accounts a
       JOIN persons p ON p.id = a.person_id
      WHERE a.id = ? AND a.person_id = ?
      LIMIT 1 FOR UPDATE`,
    [data.accountId, data.personId]
  );
  if (!accountRowsForUpdate.length) throw new IdentityError('account_not_found', localeCopy.copy_4cc5002771, 404);
  if (accountRowsForUpdate[0].person_status !== 'active') {
    throw new IdentityError('person_merged', personnelCopy.mergedPersonAuthenticationBlocked, 409);
  }
  if (accountRowsForUpdate[0].status === 'frozen') {
    throw new IdentityError('account_frozen', localeCopy.copy_d6a178f6ce, 403);
  }
  const openid = decryptOpenid(data.bootstrap.openid_ciphertext);
  const newHash = hmac(openid);
  const [conflicts] = await connection.query(
    `SELECT account_id
       FROM account_wechat_bindings
      WHERE app_id = ? AND openid_hash IN (?, ?) AND status = 'active'
        AND account_id <> ?
      LIMIT 1 FOR UPDATE`,
    [APP_ID, newHash, legacyHash(openid), data.accountId]
  );
  if (conflicts.length) throw new IdentityError('wechat_conflict', localeCopy.copy_6d67001148, 409);
  await connection.query(
    `UPDATE account_wechat_bindings
        SET status = 'revoked', active_account_id = NULL,
            revoked_at = NOW(), updated_at = NOW()
      WHERE account_id = ? AND app_id = ? AND status = 'active'`,
    [data.accountId, APP_ID]
  );
  await insertActiveWechatBinding(connection, data.accountId, openid);
  await connection.query(
    `UPDATE accounts
        SET status = 'verified', token_version = token_version + 1,
            recovery_required_at = NULL, updated_at = NOW()
      WHERE id = ?`,
    [data.accountId]
  );
  await connection.query(
    `UPDATE auth_sessions
        SET status = 'revoked', revoked_at = NOW()
      WHERE account_id = ? AND status = 'active'`,
    [data.accountId]
  );
  await connection.query(
    `DELETE ui
       FROM user_info ui
       JOIN organization_memberships om
         ON om.legacy_hr_id =
            CONVERT(ui.hr_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
        AND om.org_id =
            CONVERT(ui.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
       JOIN accounts a ON a.person_id = om.person_id
      WHERE a.id = ?`,
    [data.accountId]
  );
  await syncLegacyBindings(connection, data.accountId, openid);
  let rotatedRecoveryCode = '';
  if (data.credential && data.credential.method === 'recovery_code') {
    rotatedRecoveryCode = randomCode(20);
    const rotated = hashPassphrase(rotatedRecoveryCode);
    await connection.query(
      `UPDATE account_recovery_credentials
          SET credential_hash = ?, salt = ?, status = 'active',
              failed_attempts = 0, locked_until = NULL, used_at = NOW(),
              updated_at = NOW()
        WHERE id = ?`,
      [rotated.hash, rotated.salt, data.credential.id]
    );
  } else if (data.credential) {
    await connection.query(
      `UPDATE account_recovery_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
        WHERE id = ?`,
      [data.credential.id]
    );
  }
  if (data.recoveryRequestId) {
    await connection.query(
      `UPDATE account_recovery_requests
          SET status = 'completed', reviewed_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [data.recoveryRequestId]
    );
  }
  await connection.query(
    `UPDATE auth_bootstrap_sessions
        SET status = 'consumed', consumed_at = NOW()
      WHERE id = ?`,
    [data.bootstrap.id]
  );
  const [recipientRows] = await connection.query(
    `SELECT om.org_id, om.legacy_hr_id
       FROM organization_memberships om
      WHERE om.person_id = ? AND om.status = 'active'
      ORDER BY om.created_at ASC, om.id ASC
      LIMIT 1`,
    [data.personId]
  );
  if (recipientRows.length) {
    const { createNotification } = require('../../modules/audit/utils/notificationHelper');
    await createNotification({
      orgId: recipientRows[0].org_id,
      recipientType: 'user',
      recipientId: recipientRows[0].legacy_hr_id,
      eventKey: 'account-security:wechat-recovered:' + (data.recoveryRequestId || data.bootstrap.id),
      type: 'account_security',
      title: localeCopy.copy_3e75d7ee9b,
      description: localeCopy.copy_58e01ef218,
      category: 'system',
      targetType: 'account_security',
      targetId: data.accountId,
      targetUrl: '/subpackages/org/pages/accountSecurity/accountSecurity'
    }, connection);
  }
  await appendAuditEvent({
    connection,
    eventType: 'account_wechat_recovered',
    targetPersonId: data.personId,
    accountId: data.accountId,
    requestId: data.metadata && data.metadata.requestId,
    ip: data.metadata && data.metadata.ip
  });
  const [accountRows] = await connection.query(
    `SELECT a.*, b.openid_hash, p.name, p.student_id
       FROM accounts a
       JOIN account_wechat_bindings b ON b.account_id = a.id AND b.status = 'active'
       JOIN persons p ON p.id = a.person_id
      WHERE a.id = ?`,
    [data.accountId]
  );
  const account = accountRows[0];
  if (account && rotatedRecoveryCode) account.rotatedRecoveryCode = rotatedRecoveryCode;
  return account;
}

async function listRecoveryRequests(organizationId, options) {
  const orgId = safeString(organizationId);
  const limit = Math.min(Math.max(Number(options && options.limit) || 200, 1), MAX_AUTH_DIRECTORY_LIMIT);
  const params = [];
  let scopeSql = '';
  if (orgId) {
    scopeSql = "AND EXISTS (SELECT 1 FROM organization_memberships scope_m WHERE scope_m.person_id = r.person_id AND scope_m.org_id = ? AND scope_m.status = 'active')";
    params.push(orgId);
  }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT r.id, r.person_id, r.account_id, r.requested_org_id, r.status,
            r.created_at, r.expires_at, p.name, p.student_id, o.name AS requested_org_name
       FROM account_recovery_requests r
       JOIN persons p ON p.id = r.person_id
       JOIN organizations o
         ON CONVERT(o.id USING utf8mb4) COLLATE utf8mb4_unicode_ci = r.requested_org_id
      WHERE r.status = 'pending' AND r.expires_at > NOW()
        ${scopeSql}
      ORDER BY r.created_at ASC
      LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    id: safeString(row.id),
    personId: safeString(row.person_id),
    accountId: safeString(row.account_id),
    name: safeString(row.name),
    studentId: safeString(row.student_id),
    requestedOrganizationId: safeString(row.requested_org_id),
    requestedOrganizationName: safeString(row.requested_org_name),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));
}

async function listAccounts(organizationId, options) {
  const orgId = safeString(organizationId);
  const limit = Math.min(Math.max(Number(options && options.limit) || 500, 1), MAX_AUTH_DIRECTORY_LIMIT);
  const params = [];
  let scopeSql = '';
  if (orgId) {
    scopeSql = "AND EXISTS (SELECT 1 FROM organization_memberships scope_m WHERE scope_m.person_id = p.id AND scope_m.org_id = ? AND scope_m.status = 'active')";
    params.push(orgId);
  }
  const search = safeString(options && options.search);
  if (search) {
    scopeSql += ' AND (p.name LIKE ? OR p.student_id LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT a.id AS account_id, a.person_id, a.status, a.verified_at,
            a.recovery_required_at, p.name, p.student_id,
            EXISTS (
              SELECT 1 FROM account_wechat_bindings b
               WHERE b.account_id = a.id AND b.status = 'active'
            ) AS has_active_binding,
            EXISTS (
              SELECT 1 FROM admin_grants ag
               WHERE ag.person_id = p.id AND ag.admin_level = 'super_admin' AND ag.status = 'active'
            ) AS is_super_admin,
            EXISTS (
              SELECT 1 FROM account_recovery_credentials rc
               WHERE rc.account_id = a.id AND rc.method = 'recovery_code' AND rc.status = 'active'
            ) AS has_recovery_code,
            (a.status = 'frozen') AS is_frozen
       FROM accounts a
       JOIN persons p ON p.id = a.person_id
      WHERE p.status = 'active' ${scopeSql}
      ORDER BY p.name ASC, p.student_id ASC
      LIMIT ?`,
    params
  );
  return rows;
}

async function setAccountFrozen(personId, frozen, actor, metadata) {
  return pool.withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT a.*, EXISTS (
          SELECT 1 FROM admin_grants ag
           WHERE ag.person_id = a.person_id
             AND ag.admin_level = 'super_admin' AND ag.status = 'active'
        ) AS is_super_admin
         FROM accounts a
        WHERE a.person_id = ?
        LIMIT 1 FOR UPDATE`,
      [safeString(personId)]
    );
    const account = rows[0];
    if (!account) throw new IdentityError('account_not_found', localeCopy.copy_4cc5002771, 404);
    if (actor.adminLevel !== 'super_admin') {
      const [membershipRows] = await connection.query(
        `SELECT 1 FROM organization_memberships
          WHERE person_id = ? AND org_id = ? AND status = 'active'
          LIMIT 1`,
        [account.person_id, actor.organizationId]
      );
      if (!membershipRows.length) {
        throw new IdentityError('account_forbidden', localeCopy.copy_eebad7c140, 403);
      }
    }
    if (account.person_id === actor.personId && frozen) {
      throw new IdentityError('self_freeze_forbidden', localeCopy.copy_d959e00a3f, 403);
    }
    if (frozen && account.is_super_admin) {
      const [boundRows] = await connection.query(
        `SELECT DISTINCT ag.person_id
           FROM admin_grants ag
           JOIN accounts a ON a.person_id = ag.person_id AND a.status = 'verified'
           JOIN persons p ON p.id = a.person_id AND p.status = 'active'
          WHERE ag.admin_level = 'super_admin' AND ag.org_id = '' AND ag.status = 'active'
            AND ${usableLoginCredentialSql('a')}
          FOR UPDATE`
      );
      if (boundRows.length <= 1) {
        throw new IdentityError('last_bound_super_admin', localeCopy.copy_23d656758f, 409);
      }
    }
    const nextStatus = frozen ? 'frozen' : (account.recovery_required_at ? 'recovery_required' : 'verified');
    await connection.query(
      `UPDATE accounts
          SET status = ?, token_version = token_version + 1, updated_at = NOW()
        WHERE id = ?`,
      [nextStatus, account.id]
    );
    if (frozen) {
      await connection.query(
        `UPDATE auth_sessions SET status = 'revoked', revoked_at = NOW()
          WHERE account_id = ? AND status = 'active'`,
        [account.id]
      );
      await connection.query(
        `UPDATE account_recovery_requests
            SET status = 'revoked', reviewed_at = NOW(), updated_at = NOW()
          WHERE account_id = ? AND status = 'pending'`,
        [account.id]
      );
    }
    await appendAuditEvent({
      connection,
      eventType: frozen ? 'account_frozen' : 'account_unfrozen',
      actorPersonId: actor.personId,
      targetPersonId: account.person_id,
      accountId: account.id,
      organizationId: actor.organizationId,
      contextId: actor.contextId,
      requestId: metadata && metadata.requestId,
      ip: metadata && metadata.ip
    });
    return { accountId: account.id, status: nextStatus };
  });
}

async function approveRecovery(recoveryRequestId, actor, metadata) {
  if (!actor || !actor.personId) throw new IdentityError('forbidden', localeCopy.copy_8acb6c346a, 403);
  return pool.withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT r.*, EXISTS (
          SELECT 1 FROM organization_memberships om
           WHERE om.person_id = r.person_id AND om.org_id = ? AND om.status = 'active'
        ) AS actor_org_matches
         FROM account_recovery_requests r
         JOIN persons p ON p.id = r.person_id AND p.status = 'active'
        WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > NOW()
        LIMIT 1 FOR UPDATE`,
      [actor.organizationId, safeString(recoveryRequestId)]
    );
    const request = rows[0];
    if (!request) throw new IdentityError('recovery_unavailable', localeCopy.copy_31a162f4e0, 409);
    if (request.person_id === actor.personId) {
      throw new IdentityError('self_approval_forbidden', localeCopy.copy_bf1b9a92c7, 403);
    }
    if (actor.adminLevel !== 'super_admin' && !Boolean(request.actor_org_matches)) {
      throw new IdentityError('recovery_forbidden', localeCopy.copy_eebad7c140, 403);
    }
    const bootstrap = await getBootstrapByHash(request.new_openid_hash, true, connection);
    if (!bootstrap) throw new IdentityError('bootstrap_expired', localeCopy.copy_59a2e8fe47, 409);
    await connection.query(
      `UPDATE account_recovery_requests
          SET approved_by_person_id = ?, approved_by_context_id = ?,
              reviewed_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [actor.personId, actor.contextId, request.id]
    );
    return transferWechatBinding(connection, {
      accountId: request.account_id,
      personId: request.person_id,
      bootstrap,
      recoveryRequestId: request.id,
      metadata
    });
  });
}

async function getBootstrapByHash(openidHash, lock, connection) {
  const executor = connection || pool;
  const [rows] = await executor.query(
    `SELECT *
       FROM auth_bootstrap_sessions
      WHERE openid_hash = ? AND status = 'active' AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [safeString(openidHash)]
  );
  return rows[0] || null;
}

async function listSessions(accountId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.context_id, s.organization_id, s.role, s.status, s.expires_at,
            s.last_seen_at, s.created_at, s.device_key_hash, s.device_platform, s.device_model,
            o.name AS organization_name
       FROM auth_sessions s
       LEFT JOIN organizations o ON o.id = s.organization_id
      WHERE account_id = ? AND status = 'active' AND expires_at > NOW()
      ORDER BY last_seen_at DESC`,
    [safeString(accountId)]
  );
  return rows;
}

async function revokeSession(accountId, sessionId, currentSessionId, connection) {
  if (safeString(sessionId) === safeString(currentSessionId)) {
    throw new IdentityError('current_session', localeCopy.copy_5d9019847e, 400);
  }
  const executor = connection || pool;
  const [result] = await executor.query(
    `UPDATE auth_sessions SET status = 'revoked', revoked_at = NOW()
      WHERE id = ? AND account_id = ? AND status = 'active'`,
    [safeString(sessionId), safeString(accountId)]
  );
  return result.affectedRows > 0;
}

async function getAccountByPersonInOrg(personId, orgId) {
  const [rows] = await pool.query(
    `SELECT a.id AS account_id, a.person_id, a.status AS account_status,
            p.name, p.normalized_student_id AS student_id
       FROM organization_memberships om
       JOIN persons p ON p.id = om.person_id
       JOIN accounts a ON a.person_id = om.person_id
      WHERE om.person_id = ? AND om.org_id = ? AND om.status = 'active'
        AND a.status IN ('verified', 'frozen', 'recovery_required')
      LIMIT 1`,
    [safeString(personId), safeString(orgId)]
  );
  return rows[0] || null;
}

async function getMemberAccountSubjectByPersonInOrg(personId, orgId, connection, lock) {
  const executor = connection || pool;
  const [rows] = await executor.query(
    `SELECT p.id AS person_id, p.name, p.student_id,
            a.id AS account_id, a.status AS account_status
       FROM organization_memberships om
       JOIN persons p ON p.id = om.person_id AND p.status = 'active'
       LEFT JOIN accounts a ON a.person_id = p.id
      WHERE om.person_id = ? AND om.org_id = ? AND om.status = 'active'
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [safeString(personId), safeString(orgId)]
  );
  return rows[0] || null;
}

async function ensureAccountForActiveMember(personId, orgId, connection) {
  const subject = await getMemberAccountSubjectByPersonInOrg(personId, orgId, connection, true);
  if (!subject) return null;
  if (subject.account_id) {
    return Object.assign({}, subject, { accountInitialized: false });
  }
  const accountId = generateId();
  await connection.query(
    `INSERT INTO accounts (id, person_id, status, token_version, verified_at)
     VALUES (?, ?, 'verified', 1, NOW())`,
    [accountId, subject.person_id]
  );
  return Object.assign({}, subject, {
    account_id: accountId,
    account_status: 'verified',
    accountInitialized: true
  });
}

async function getPassphraseStatus(accountId) {
  const [rows] = await pool.query(
    `SELECT 1 FROM account_recovery_credentials
      WHERE account_id = ? AND method = 'passphrase' AND status = 'active'
      LIMIT 1`,
    [safeString(accountId)]
  );
  return rows.length > 0;
}

async function revokeRecoveryCredential(accountId, method, connection) {
  const executor = connection || pool;
  const [result] = await executor.query(
    `UPDATE account_recovery_credentials
        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
      WHERE account_id = ? AND method = ? AND status = 'active'`,
    [safeString(accountId), safeString(method)]
  );
  return Number(result.affectedRows || 0) > 0;
}

async function resetAccountByLegacyHr(connection, legacyHrId, organizationId, actor, reason) {
  const [rows] = await connection.query(
    `SELECT a.id AS account_id, a.person_id
       FROM organization_memberships om
       JOIN accounts a ON a.person_id = om.person_id
      WHERE om.legacy_hr_id = ? AND om.org_id = ?
      LIMIT 1 FOR UPDATE`,
    [safeString(legacyHrId), safeString(organizationId)]
  );
  const account = rows[0];
  if (!account) return null;
  const [targetSuperRows] = await connection.query(
    `SELECT 1 FROM admin_grants
      WHERE person_id = ? AND admin_level = 'super_admin' AND status = 'active'
      LIMIT 1 FOR UPDATE`,
    [account.person_id]
  );
  if (targetSuperRows.length) {
    const [boundSuperRows] = await connection.query(
      `SELECT DISTINCT ag.person_id
         FROM admin_grants ag
         JOIN accounts a ON a.person_id = ag.person_id AND a.status = 'verified'
         JOIN persons p ON p.id = a.person_id AND p.status = 'active'
        WHERE ag.admin_level = 'super_admin' AND ag.org_id = '' AND ag.status = 'active'
          AND ${usableLoginCredentialSql('a')}
        FOR UPDATE`
    );
    if (boundSuperRows.length <= 1) {
      throw new IdentityError('last_bound_super_admin', localeCopy.copy_23d656758f, 409);
    }
  }
  await connection.query(
    `UPDATE account_wechat_bindings
        SET status = 'revoked', active_account_id = NULL,
            revoked_at = NOW(), updated_at = NOW()
      WHERE account_id = ? AND status = 'active'`,
    [account.account_id]
  );
  await connection.query(
    `UPDATE auth_sessions
        SET status = 'revoked', revoked_at = NOW()
      WHERE account_id = ? AND status = 'active'`,
    [account.account_id]
  );
  await connection.query(
    `UPDATE accounts
        SET status = 'verified', token_version = token_version + 1,
            recovery_required_at = NULL, updated_at = NOW()
      WHERE id = ?`,
    [account.account_id]
  );
  await connection.query(
    `DELETE ui
       FROM user_info ui
       JOIN organization_memberships om
         ON om.legacy_hr_id =
            CONVERT(ui.hr_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
        AND om.org_id =
            CONVERT(ui.org_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
      WHERE om.person_id = ?`,
    [account.person_id]
  );
  await connection.query(
    `UPDATE admin_info ai
       JOIN admin_grants ag
         ON ag.legacy_admin_id =
            CONVERT(ai.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
          SET ai.openid = NULL, ai.bind_status = 'invited', ai.bound_at = NULL,
              ai.updated_at = NOW()
        WHERE ag.person_id = ? AND ag.status = 'active'`,
    [account.person_id]
  );
  await appendAuditEvent({
    connection,
    eventType: 'account_binding_reset',
    actorPersonId: actor && actor.personId,
    targetPersonId: account.person_id,
    accountId: account.account_id,
    organizationId,
    contextId: actor && actor.contextId,
    detail: { reason: safeString(reason) || 'administrator_reset' }
  });
  return { accountId: account.account_id, personId: account.person_id };
}

async function appendAuditEvent(data) {
  const executor = data.connection || pool;
  await executor.query(
    `INSERT INTO auth_audit_events
       (id, event_type, actor_person_id, target_person_id, account_id,
        organization_id, context_id, request_id, ip_hash, outcome, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      safeString(data.eventType),
      safeString(data.actorPersonId) || null,
      safeString(data.targetPersonId) || null,
      safeString(data.accountId) || null,
      safeString(data.organizationId) || null,
      safeString(data.contextId) || null,
      safeString(data.requestId) || null,
      data.ip ? hmac('ip:' + safeString(data.ip)) : null,
      safeString(data.outcome) || 'success',
      data.detail ? JSON.stringify(data.detail) : null
    ]
  );
}

async function listAuditEvents(organizationId, limit) {
  const count = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const orgId = safeString(organizationId);
  const params = [];
  let scopeSql = '';
  if (orgId) {
    scopeSql = 'WHERE e.organization_id = ?';
    params.push(orgId);
  }
  params.push(count);
  const [rows] = await pool.query(
    `SELECT e.*, actor.name AS actor_name, target.name AS target_name
       FROM auth_audit_events e
       LEFT JOIN persons actor ON actor.id = e.actor_person_id
       LEFT JOIN persons target ON target.id = e.target_person_id
       ${scopeSql}
      ORDER BY e.created_at DESC
      LIMIT ?`,
    params
  );
  return rows;
}

function normalizeInviteCode(value) {
  return safeString(value).replace(/[^0-9a-z]/gi, '').toUpperCase();
}

async function listEligibleInitialInvitePeople(organizationId, options) {
  const orgId = safeString(organizationId);
  const limit = Math.min(Math.max(Number(options && options.limit) || 500, 1), MAX_AUTH_DIRECTORY_LIMIT);
  const params = [];
  const where = [
    "p.status = 'active'",
    "om.status = 'active'",
    "NOT EXISTS (SELECT 1 FROM account_wechat_bindings history_b JOIN accounts history_a ON history_a.id = history_b.account_id WHERE history_a.person_id = p.id)",
    "NOT EXISTS (SELECT 1 FROM accounts existing_a WHERE existing_a.person_id = p.id AND existing_a.status = 'frozen')"
  ];
  if (orgId) { where.push('om.org_id = ?'); params.push(orgId); }
  const search = safeString(options && options.search);
  if (search) { where.push('(p.name LIKE ? OR p.student_id LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }
  if (safeString(options && options.departmentId)) { where.push('ma.department_id = ?'); params.push(safeString(options.departmentId)); }
  if (safeString(options && options.identityId)) { where.push('ma.identity_id = ?'); params.push(safeString(options.identityId)); }
  if (safeString(options && options.workGroupId)) { where.push('ma.work_group_id = ?'); params.push(safeString(options.workGroupId)); }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT DISTINCT p.id AS person_id, p.name, p.student_id, om.org_id,
            o.name AS organization_name, d.name AS department_name,
            i.name AS identity_name, w.name AS work_group_name,
            EXISTS (SELECT 1 FROM identity_verification_invites inv
              WHERE inv.person_id = p.id AND inv.org_id = om.org_id
                AND inv.status = 'active' AND inv.expires_at > NOW()) AS has_active_invite
       FROM persons p
       JOIN organization_memberships om ON om.person_id = p.id
       JOIN organizations o ON o.id = om.org_id
       LEFT JOIN membership_assignments ma ON ma.membership_id = om.id AND ma.org_id = om.org_id AND ma.status = 'active'
       LEFT JOIN departments d ON d.id = ma.department_id AND d.org_id = ma.org_id
       LEFT JOIN identities i ON i.id = ma.identity_id AND i.org_id = ma.org_id
       LEFT JOIN work_groups w ON w.id = ma.work_group_id AND w.org_id = ma.org_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.name ASC, p.student_id ASC, om.org_id ASC
      LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    personId: safeString(row.person_id), name: safeString(row.name), studentId: safeString(row.student_id),
    organizationId: safeString(row.org_id), organizationName: safeString(row.organization_name),
    departmentName: safeString(row.department_name), identityName: safeString(row.identity_name),
    workGroupName: safeString(row.work_group_name), hasActiveInvite: Boolean(row.has_active_invite)
  }));
}

async function issueInitialInvites(personIds, organizationId, actor, options) {
  const ids = Array.from(new Set((Array.isArray(personIds) ? personIds : []).map(safeString).filter(Boolean))).slice(0, 100);
  const orgId = safeString(organizationId);
  if (!ids.length) throw new IdentityError('invalid_params', localeCopy.copy_e5d78a79f7, 400);
  const hours = Math.min(Math.max(Number(options && options.expiresInHours) || 24, 1), 168);
  return pool.withTransaction(async (connection) => {
    const results = [];
    for (const personId of ids) {
      const orgParams = [personId];
      const orgWhere = orgId ? 'AND om.org_id = ?' : '';
      if (orgId) orgParams.push(orgId);
      const [rows] = await connection.query(
        `SELECT p.id AS person_id, p.name, p.student_id, om.org_id
           FROM persons p JOIN organization_memberships om ON om.person_id = p.id
          WHERE p.id = ? ${orgWhere} AND om.status = 'active' AND p.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM account_wechat_bindings b JOIN accounts a ON a.id = b.account_id WHERE a.person_id = p.id)
          ORDER BY om.org_id LIMIT 20 FOR UPDATE`, orgParams
      );
      for (const row of rows) {
        const targetOrgId = safeString(row.org_id);
        const inviteId = generateId();
        const code = randomCode(12);
        await connection.query(
          `UPDATE identity_verification_invites SET status = 'revoked', updated_at = NOW()
            WHERE person_id = ? AND org_id = ? AND status = 'active'`, [personId, targetOrgId]
        );
        await connection.query(
          `INSERT INTO identity_verification_invites
             (id, person_id, org_id, code_hash, issued_by_person_id, issued_by_context_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
          [inviteId, personId, targetOrgId, hmac('identity-invite:' + inviteId + ':' + code), actor.personId, actor.contextId, hours]
        );
        await appendAuditEvent({ connection, eventType: 'identity_invite_issued', actorPersonId: actor.personId,
          targetPersonId: personId, organizationId: targetOrgId, contextId: actor.contextId,
          requestId: options && options.requestId, ip: options && options.ip });
        results.push({ inviteId, personId, name: row.name, studentId: row.student_id, organizationId: targetOrgId, code, expiresInHours: hours });
      }
    }
    return results;
  });
}

async function revokeInitialInvites(personIds, organizationId, actor, metadata) {
  const ids = Array.from(new Set((Array.isArray(personIds) ? personIds : []).map(safeString).filter(Boolean))).slice(0, 100);
  if (!ids.length) return { revoked: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const params = [...ids];
  let scope = '';
  if (safeString(organizationId)) { scope = ' AND org_id = ?'; params.push(safeString(organizationId)); }
  const [result] = await pool.query(`UPDATE identity_verification_invites SET status = 'revoked', updated_at = NOW()
    WHERE status = 'active' AND person_id IN (${placeholders})${scope}`, params);
  await appendAuditEvent({ eventType: 'identity_invites_revoked', actorPersonId: actor.personId,
    organizationId: safeString(organizationId), contextId: actor.contextId, requestId: metadata && metadata.requestId, ip: metadata && metadata.ip,
    detail: { count: Number(result.affectedRows || 0) } });
  return { revoked: Number(result.affectedRows || 0) };
}

async function redeemInitialInvite(bootstrapId, data, metadata) {
  const result = await pool.withTransaction(async (connection) => {
    const bootstrap = await getBootstrapSession(bootstrapId, true, connection);
    if (!bootstrap) throw new IdentityError('bootstrap_expired', localeCopy.copy_ffadbecb8f, 401);
    const policy = await getPolicy(connection);
    if (!policy || !policy.initial_claim_enabled) throw new IdentityError('claim_paused', localeCopy.copy_0ca681f988, 403);
    const studentId = normalizeStudentId(data.studentId);
    const name = normalizeName(data.name);
    const orgId = safeString(data.organizationId);
    const code = normalizeInviteCode(data.code);
    if (!studentId || !name || !orgId || !code) throw new IdentityError('verification_failed', localeCopy.copy_65a9439851, 400);
    const [rows] = await connection.query(
      `SELECT inv.*, p.name, p.student_id
         FROM identity_verification_invites inv
         JOIN persons p ON p.id = inv.person_id AND p.status = 'active'
         JOIN organization_memberships om
           ON om.person_id = inv.person_id AND om.org_id = inv.org_id AND om.status = 'active'
        WHERE inv.org_id = ? AND p.normalized_student_id = ? AND p.name = ?
          AND inv.status = 'active' AND inv.expires_at > NOW()
          AND (inv.locked_until IS NULL OR inv.locked_until <= NOW())
        LIMIT 1 FOR UPDATE`, [orgId, studentId, name]
    );
    const invite = rows[0];
    const matches = invite && secureEqualHex(invite.code_hash, hmac('identity-invite:' + invite.id + ':' + code))
      && invite.failed_attempts < MAX_VERIFY_ATTEMPTS;
    if (!matches) {
      if (invite) await connection.query(`UPDATE identity_verification_invites SET failed_attempts = failed_attempts + 1,
        locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until), updated_at = NOW() WHERE id = ?`, [MAX_VERIFY_ATTEMPTS, invite.id]);
      await connection.query(`UPDATE auth_bootstrap_sessions SET failed_attempts = failed_attempts + 1,
        locked_until = IF(failed_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until) WHERE id = ?`, [MAX_VERIFY_ATTEMPTS, bootstrap.id]);
      throw new IdentityError('verification_failed', localeCopy.copy_65a9439851, 400);
    }
    const [existingBindings] = await connection.query(`SELECT 1 FROM account_wechat_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE a.person_id = ? AND b.status = 'active' LIMIT 1 FOR UPDATE`, [invite.person_id]);
    if (existingBindings.length) throw new IdentityError('already_verified', localeCopy.copy_e879ade127, 409);
    const [accounts] = await connection.query('SELECT * FROM accounts WHERE person_id = ? LIMIT 1 FOR UPDATE', [invite.person_id]);
    const account = accounts[0];
    const accountId = account ? account.id : generateId();
    if (account) await connection.query(`UPDATE accounts SET status = 'verified', token_version = token_version + 1,
      verified_at = NOW(), recovery_required_at = NULL WHERE id = ?`, [accountId]);
    else await connection.query(`INSERT INTO accounts (id, person_id, status, token_version, verified_at) VALUES (?, ?, 'verified', 1, NOW())`, [accountId, invite.person_id]);
    const openid = decryptOpenid(bootstrap.openid_ciphertext);
    await insertActiveWechatBinding(connection, accountId, openid);
    await syncLegacyBindings(connection, accountId, openid);
    await connection.query(`UPDATE identity_verification_invites SET status = 'consumed', consumed_at = NOW(), updated_at = NOW() WHERE id = ?`, [invite.id]);
    await connection.query(`UPDATE auth_bootstrap_sessions SET status = 'consumed', consumed_at = NOW() WHERE id = ?`, [bootstrap.id]);
    await appendAuditEvent({ connection, eventType: 'identity_invite_redeemed', targetPersonId: invite.person_id,
      accountId, organizationId: orgId, requestId: metadata && metadata.requestId, ip: metadata && metadata.ip });
    const [fresh] = await connection.query(`SELECT a.*, b.openid_hash, p.name, p.student_id FROM accounts a
      JOIN account_wechat_bindings b ON b.account_id = a.id AND b.status = 'active' JOIN persons p ON p.id = a.person_id WHERE a.id = ?`, [accountId]);
    return fresh[0];
  });
  return result;
}

async function listEligibleRecoveryAccounts(organizationId, options) {
  const rows = await listAccounts(organizationId, Object.assign({}, options, {
    limit: options && options.limit ? options.limit : MAX_AUTH_DIRECTORY_LIMIT
  }));
  return rows.filter((row) => ['verified', 'recovery_required'].includes(safeString(row.status)) && !Boolean(row.is_frozen));
}

async function issueAdminRecoveryCodes(accountIds, organizationId, actor, options) {
  const ids = Array.from(new Set((Array.isArray(accountIds) ? accountIds : []).map(safeString).filter(Boolean))).slice(0, 100);
  if (!ids.length) throw new IdentityError('invalid_params', localeCopy.copy_06f6e6c619, 400);
  const policy = await getPolicy();
  if (!policy || !policy.allow_recovery_code) throw new IdentityError('method_disabled', localeCopy.copy_f07aa06bda, 403);
  return pool.withTransaction(async (connection) => {
    const result = [];
    for (const accountId of ids) {
      const orgParams = [accountId];
      const orgScope = safeString(organizationId)
        ? 'AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.person_id = a.person_id AND om.org_id = ? AND om.status = \'active\')'
        : '';
      if (safeString(organizationId)) orgParams.push(safeString(organizationId));
      const [rows] = await connection.query(`SELECT a.id AS account_id, a.person_id, a.status, p.name, p.student_id
        FROM accounts a JOIN persons p ON p.id = a.person_id
        WHERE a.id = ? AND a.status IN ('verified','recovery_required')
          ${orgScope}
        LIMIT 1 FOR UPDATE`, orgParams);
      if (!rows.length) continue;
      const code = randomCode(20); const credential = hashPassphrase(code);
      await connection.query(`INSERT INTO account_recovery_credentials (id, account_id, method, credential_hash, salt, status)
        VALUES (?, ?, 'recovery_code', ?, ?, 'active') ON DUPLICATE KEY UPDATE credential_hash = VALUES(credential_hash), salt = VALUES(salt),
          status = 'active', failed_attempts = 0, locked_until = NULL, used_at = NULL, updated_at = NOW()`,
        [generateId(), accountId, credential.hash, credential.salt]);
      await appendAuditEvent({ connection, eventType: 'admin_recovery_code_issued', actorPersonId: actor.personId,
        targetPersonId: rows[0].person_id, accountId, organizationId: safeString(organizationId), contextId: actor.contextId,
        requestId: options && options.requestId, ip: options && options.ip });
      result.push({ accountId, personId: rows[0].person_id, name: rows[0].name, studentId: rows[0].student_id, code });
    }
    return result;
  });
}

async function revokeAdminRecoveryCodes(accountIds, organizationId, actor, metadata) {
  const ids = Array.from(new Set((Array.isArray(accountIds) ? accountIds : []).map(safeString).filter(Boolean))).slice(0, 100);
  if (!ids.length) return { revoked: 0 };
  const orgScope = safeString(organizationId)
    ? ' AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.person_id = a.person_id AND om.org_id = ? AND om.status = \'active\')'
    : '';
  const params = [...ids];
  if (safeString(organizationId)) params.push(safeString(organizationId));
  const [result] = await pool.query(`UPDATE account_recovery_credentials c JOIN accounts a ON a.id = c.account_id
    SET c.status = 'revoked', c.updated_at = NOW() WHERE c.method = 'recovery_code' AND c.status = 'active'
      AND a.id IN (${ids.map(() => '?').join(',')})${orgScope}`, params);
  await appendAuditEvent({ eventType: 'admin_recovery_codes_revoked', actorPersonId: actor.personId,
    organizationId: safeString(organizationId), contextId: actor.contextId, requestId: metadata && metadata.requestId, ip: metadata && metadata.ip,
    detail: { count: Number(result.affectedRows || 0) } });
  return { revoked: Number(result.affectedRows || 0) };
}

async function authenticateWithPassphrase(studentId, passphrase) {
  const policy = await getPolicy();
  if (!policy || !policy.allow_passphrase) throw new IdentityError('login_failed', localeCopy.copy_b1957461c7, 401);
  const normalized = normalizeStudentId(studentId); const value = normalizePassphrase(passphrase);
  if (!normalized || !isPassphraseLengthValid(value)) throw new IdentityError('login_failed', localeCopy.copy_b1957461c7, 401);
  return pool.withTransaction(async (connection) => {
    const [rows] = await connection.query(`SELECT a.*, p.name, p.student_id, b.openid_hash, c.id AS credential_id,
      c.credential_hash, c.salt, c.failed_attempts, c.locked_until
      FROM persons p JOIN accounts a ON a.person_id = p.id
      LEFT JOIN account_wechat_bindings b ON b.account_id = a.id AND b.app_id = ? AND b.status = 'active'
      LEFT JOIN account_recovery_credentials c ON c.account_id = a.id AND c.method = 'passphrase' AND c.status = 'active'
      WHERE p.normalized_student_id = ? AND p.status = 'active' LIMIT 1 FOR UPDATE`, [APP_ID, normalized]);
    const account = rows[0];
    const valid = account && account.status === 'verified' && account.credential_id
      && (!account.locked_until || new Date(account.locked_until).getTime() <= Date.now())
      && verifyPassphrase(value, account.salt, account.credential_hash);
    if (!valid) {
      if (account && account.credential_id) {
        const attempts = Number(account.failed_attempts || 0) + 1;
        await connection.query(`UPDATE account_recovery_credentials SET failed_attempts = ?, locked_until = IF(? >= ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), locked_until), updated_at = NOW() WHERE id = ?`, [attempts, attempts, MAX_RECOVERY_ATTEMPTS, account.credential_id]);
      }
      throw new IdentityError('login_failed', localeCopy.copy_b1957461c7, 401);
    }
    await connection.query(`UPDATE account_recovery_credentials SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`, [account.credential_id]);
    return account;
  });
}

async function bindWechatAfterPassphraseLogin(accountId, openid, metadata) {
  const normalizedAccountId = safeString(accountId);
  const normalizedOpenid = safeString(openid);
  if (!normalizedAccountId || !normalizedOpenid) {
    throw new IdentityError('invalid_wechat_code', localeCopy.copy_ffadbecb8f, 401);
  }
  return pool.withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT a.*, p.name, p.student_id, b.id AS binding_id, b.openid_hash
         FROM accounts a
         JOIN persons p ON p.id = a.person_id AND p.status = 'active'
         LEFT JOIN account_wechat_bindings b
           ON b.account_id = a.id AND b.app_id = ? AND b.status = 'active'
        WHERE a.id = ? AND a.status = 'verified'
        LIMIT 1 FOR UPDATE`,
      [APP_ID, normalizedAccountId]
    );
    const account = rows[0];
    if (!account) {
      throw new IdentityError('account_unavailable', localeCopy.copy_0995192dbd, 401);
    }
    if (account.binding_id) return account;

    const boundAccount = await findAccountByOpenid(normalizedOpenid, connection);
    if (boundAccount && safeString(boundAccount.id) !== normalizedAccountId) {
      throw new IdentityError('wechat_conflict', localeCopy.copy_6d67001148, 409);
    }
    if (boundAccount) return boundAccount;

    await insertActiveWechatBinding(connection, normalizedAccountId, normalizedOpenid);
    await syncLegacyBindings(connection, normalizedAccountId, normalizedOpenid);
    await appendAuditEvent({
      connection,
      eventType: 'password_wechat_binding_created',
      targetPersonId: account.person_id,
      accountId: normalizedAccountId,
      requestId: metadata && metadata.requestId,
      ip: metadata && metadata.ip
    });
    return Object.assign({}, account, { openid_hash: hmac(normalizedOpenid) });
  });
}

function temporaryPasswordSessionOptions(openid) {
  const normalizedOpenid = safeString(openid);
  return {
    temporary: true,
    openidHash: crypto.randomBytes(32).toString('hex'),
    openidCiphertext: normalizedOpenid ? encryptOpenid(normalizedOpenid) : null
  };
}

async function bindTemporaryPasswordSessionOpenid(accountId, session) {
  const normalizedAccountId = safeString(accountId);
  const ciphertext = safeString(session && session.openid_ciphertext);
  if (!normalizedAccountId || safeString(session && session.binding_mode) !== 'temporary' || !ciphertext) {
    throw new IdentityError('invalid_params', localeCopy.copy_ffadbecb8f, 400);
  }
  const openid = decryptOpenid(ciphertext);
  // 旧客户端仅从当前会话取已加密的绑定邀请；与新版显式绑定共用冲突校验。
  // 绑定只增加登录凭据，不把既有口令会话改造成依赖微信的会话。
  const account = await bindWechatAfterPassphraseLogin(normalizedAccountId, openid, {
    requestId: session.requestId, ip: session.ip
  });
  return { accountId: normalizedAccountId, personId: account.person_id };
}

module.exports = {
  APP_ID,
  SESSION_MINUTES,
  PASSPHRASE_MIN_CHARACTERS,
  PASSPHRASE_MAX_CHARACTERS,
  passphraseCharacterLength,
  isPassphraseLengthValid,
  IdentityError,
  contextId,
  authIdentityId,
  buildAssignmentLabel,
  lockActiveBusinessSubjects,
  normalizeStudentId,
  listClaimOrganizations,
  syncLegacyHrRecords,
  listMembershipAssignments,
  listMembershipAssignmentSummaries,
  listDirectoryAssignmentSummaries,
  saveMembershipAssignment,
  revokeMembershipAssignment,
  removeLegacyHrRecord,
  revokeOrganizationAdminAccessForDeparture,
  listFormerMemberships,
  reactivateMembership,
  syncLegacyAdminGrant,
  listLegacyAdminAuthenticationStates,
  revokeLegacyAdminGrant,
  findAccountByOpenid,
  upgradeLegacyWechatBindings,
  createBootstrapSession,
  getBootstrapSession,
  listContexts,
  resolveContextSelection,
  resolveContext,
  createSession,
  loadSession,
  activateSelection,
  activateContext,
  syncLegacyBindings,
  createClaim,
  listClaims,
  issueVerificationCode,
  issueVerificationCodes,
  revokeVerificationCodes,
  verifyClaim,
  getPolicy,
  savePolicy,
  configureRecoveryCredential,
  startRecovery,
  completeRecoveryWithCredential,
  listRecoveryRequests,
  listAccounts,
  setAccountFrozen,
  approveRecovery,
  listSessions,
  revokeSession,
  getAccountByPersonInOrg,
  getMemberAccountSubjectByPersonInOrg,
  ensureAccountForActiveMember,
  getPassphraseStatus,
  revokeRecoveryCredential,
  resetAccountByLegacyHr,
  appendAuditEvent,
  listAuditEvents,
  listEligibleInitialInvitePeople,
  issueInitialInvites,
  revokeInitialInvites,
  redeemInitialInvite,
  listEligibleRecoveryAccounts,
  issueAdminRecoveryCodes,
  revokeAdminRecoveryCodes,
  authenticateWithPassphrase,
  bindWechatAfterPassphraseLogin,
  temporaryPasswordSessionOptions,
  bindTemporaryPasswordSessionOpenid
};
