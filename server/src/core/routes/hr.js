const localeCopy = require('../../locales/zh-CN/generated/core/routes/hr');
const retiredCopy = require('../../locales/zh-CN/generated/core/routes/admin');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const { format: localeFormat } = require('../../locales/runtime');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../utils/helpers');
const { getCurrentOrgId } = require('../../utils/orgContext');
const { resolveHrBindingStates } = require('../services/userBindingStatus');
const unifiedIdentityModel = require('../models/unifiedIdentity');
const personIdentityOverviewModel = require('../models/personIdentityOverview');
const personGovernanceModel = require('../models/personGovernance');
const hrMemberDeletionService = require('../services/hrMemberDeletionService');
const assignmentDictionaryIntegrity = require('../services/assignmentDictionaryIntegrity');
const {
  HR_GOVERNANCE_DIRECTORY_PERMISSIONS
} = require('../services/adminPermissions');
const {
  AdminOrganizationAccessError,
  listAdminOrganizationAccess,
  requireAdminOrganizationPermission
} = require('../services/adminOrganizationAccess');

const hrInfoModel = require('../models/hrInfo');

const { resolveRequestAdmin } = require('../services/adminRequestContext');
const hrTableImportModel = require('../models/hrTableImport');
const pool = require('../../config/db');

function authenticationStatus(row) {
  const accountStatus = safeString(row.account_status);
  if (accountStatus === 'frozen') return { value: 'frozen', label: localeCopy.copy_ddaba44b59 };
  if (accountStatus === 'recovery_required') return { value: 'recovery_required', label: localeCopy.copy_16399ef078 };
  if (accountStatus === 'verified') {
    return { value: 'verified', label: localeCopy.copy_17d26b7956 };
  }
  return { value: 'pending_verification', label: localeCopy.copy_5342fa4b24 };
}

function sendHrRouteFailure(req, res, error, fallbackMessage) {
  const expected = error instanceof AdminOrganizationAccessError
    || error instanceof unifiedIdentityModel.IdentityError;
  if (!expected && req.logger) {
    req.logger.error('HR operation failed', {
      event: 'hr.operation_failed',
      endpoint: safeString(req.path),
      code: safeString(error && error.code),
      error: safeString(error && error.message)
    });
  }
  return res.status(expected ? (error.httpStatus || 400) : 500).json({
    status: expected ? safeString(error.code) : 'error',
    message: expected ? safeString(error.message) : (fallbackMessage || personnelCopy.hrOperationFailed)
  });
}

// listHrInfo
router.post('/listHrInfo', async (req, res) => {
  try {
    const admin = await resolveRequestAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const orgId = await getCurrentOrgId();
    const [rows] = await pool.query(
      `SELECT h.*, d.name as department_name, i.name as identity_name, wg.name as work_group_name
       FROM hr_info h
       LEFT JOIN departments d ON h.department_id = d.id AND d.org_id = ?
       LEFT JOIN identities i ON h.identity_id = i.id AND i.org_id = ?
       LEFT JOIN work_groups wg ON h.work_group_id = wg.id AND wg.org_id = ?
       WHERE h.org_id = ?
         AND EXISTS (
           SELECT 1 FROM organization_memberships om
            WHERE om.legacy_hr_id = h.id AND om.org_id = h.org_id AND om.status = 'active'
         )
       ORDER BY h.name`,
      [orgId, orgId, orgId, orgId]
    );
    const [bindingStates, assignmentSummaries] = await Promise.all([
      resolveHrBindingStates(rows, orgId),
      unifiedIdentityModel.listMembershipAssignmentSummaries(rows.map((item) => item.id), orgId)
    ]);
    const list = rows.map((item) => {
      const binding = bindingStates.get(safeString(item.id)) || {
        status: 'unbound',
        userInfoId: '',
        boundOpenid: ''
      };
      const assignmentSummary = assignmentSummaries.get(safeString(item.id)) || {
        count: 0,
        assignments: []
      };
      return {
        id: item.id,
        name: safeString(item.name),
        studentId: safeString(item.student_id),
        departmentId: safeString(item.department_id),
        department: safeString(item.department_name),
        identityId: safeString(item.identity_id),
        identity: safeString(item.identity_name),
        workGroupId: safeString(item.work_group_id),
        workGroup: safeString(item.work_group_name),
        assignmentCount: assignmentSummary.count,
        assignments: assignmentSummary.assignments,
        userInfoId: binding.userInfoId,
        boundOpenid: binding.boundOpenid ? safeString(binding.boundOpenid).slice(0, 8) + '***' : '',
        bindStatus: binding.status
      };
    });
    res.json({ status: 'success', list });
  } catch (e) {
    return sendHrRouteFailure(req, res, e);
  }
});

// 人事信息页统一目录：资料、认证、账号与恢复共用同一份人员数据。
router.post('/listHrGovernance', async (req, res) => {
  try {
    const accessList = await listAdminOrganizationAccess(req);
    const readable = accessList.filter((item) => (
      Array.isArray(item.permissionKeys)
      && item.permissionKeys.some((key) => HR_GOVERNANCE_DIRECTORY_PERMISSIONS.indexOf(key) >= 0)
    ));
    if (!readable.length) return res.status(403).json({ status: 'permission_denied', message: localeCopy.copy_828e7e4bfb });
    const requestedOrgId = safeString(req.body && req.body.organizationId);
    const allowedIds = Array.from(new Set(readable.map((item) => safeString(item.organizationId)).filter(Boolean)));
    const organizationIds = requestedOrgId
      ? (allowedIds.indexOf(requestedOrgId) >= 0 ? [requestedOrgId] : [])
      : allowedIds;
    if (!organizationIds.length) return res.status(403).json({ status: 'organization_forbidden', message: localeCopy.copy_b267164ab8 });
    const directory = await personIdentityOverviewModel.listGovernanceDirectory(organizationIds);
    const rows = directory.memberships;
    const assignmentsByMembership = new Map();
    directory.assignments.forEach((assignment) => {
      const membershipId = safeString(assignment.membership_id);
      const assignmentList = assignmentsByMembership.get(membershipId) || [];
      assignmentList.push({
        assignmentId: safeString(assignment.id),
        assignmentNature: safeString(assignment.assignment_kind),
        assignmentKind: safeString(assignment.assignment_kind),
        departmentId: safeString(assignment.department_id),
        department: safeString(assignment.department_name),
        identityCategoryId: safeString(assignment.identity_id),
        identityCategoryName: safeString(assignment.identity_name),
        identityId: safeString(assignment.identity_id),
        identity: safeString(assignment.identity_name),
        workGroupId: safeString(assignment.work_group_id),
        workGroup: safeString(assignment.work_group_name),
        historical: safeString(assignment.membership_status) === 'left'
      });
      assignmentsByMembership.set(membershipId, assignmentList);
    });
    const countByStatus = { verified: 0, pending_verification: 0, frozen: 0, recovery_required: 0 };
    const list = rows.map((item) => {
      const accountStatus = safeString(item.account_status);
      const status = accountStatus === 'frozen'
        ? 'frozen'
        : accountStatus === 'recovery_required'
          ? 'recovery_required'
          : accountStatus === 'verified'
            ? 'verified'
            : 'pending_verification';
      const assignments = assignmentsByMembership.get(safeString(item.membership_id)) || [];
      countByStatus[status] = Number(countByStatus[status] || 0) + 1;
      return {
        id: safeString(item.id),
        hrId: safeString(item.id),
        personId: safeString(item.person_id),
        membershipId: safeString(item.membership_id),
        membershipStatus: safeString(item.membership_status) || 'active',
        joinedAt: item.joined_at || null,
        leftAt: item.left_at || null,
        organizationId: safeString(item.org_id),
        organizationName: safeString(item.organization_name),
        name: safeString(item.name),
        studentId: safeString(item.student_id),
        assignments,
        assignmentCount: assignments.length,
        assignmentNatures: assignments.map((assignment) => assignment.assignmentNature).filter(Boolean),
        departments: assignments.map((assignment) => assignment.department).filter(Boolean),
        identities: assignments.map((assignment) => assignment.identityCategoryName).filter(Boolean),
        workGroups: assignments.map((assignment) => assignment.workGroup).filter(Boolean),
        accountId: safeString(item.account_id),
        wxBindStatus: Boolean(item.has_active_binding) ? 'bound' : 'unbound',
        auth: {
          status,
          hasActiveBinding: Boolean(item.has_active_binding),
          hasBindingHistory: Boolean(item.has_binding_history),
          hasRecoveryCode: Boolean(item.has_recovery_code),
          hasPassphrase: Boolean(item.has_passphrase),
          activeSessionCount: Number(item.active_session_count || 0),
          pendingClaimId: safeString(item.pending_claim_id),
          hasPendingClaim: Boolean(item.has_pending_claim),
          hasActiveClaimCode: Boolean(item.has_active_claim_code),
          hasActiveInvite: Boolean(item.has_active_invite),
          pendingRecoveryId: safeString(item.pending_recovery_id),
          verifiedAt: item.verified_at,
          recoveryRequiredAt: item.recovery_required_at
        }
      };
    });
    const canGlobalAccountManage = accessList.some((item) => (
      Array.isArray(item.permissionKeys) && item.permissionKeys.indexOf('auth.accounts.global_manage') >= 0
    ));
    return res.json({ status: 'success', rows: list, capabilities: { canGlobalAccountManage }, totals: {
      total: list.length,
      verified: countByStatus.verified,
      pendingVerification: countByStatus.pending_verification,
      frozen: countByStatus.frozen,
      recoveryRequired: countByStatus.recovery_required
    }, organizations: organizationIds });
  } catch (error) {
    const expected = error instanceof AdminOrganizationAccessError;
    if (!expected && req.logger) {
      req.logger.error('HR governance directory failed', {
        event: 'hr.governance.list_failed',
        code: safeString(error && error.code),
        error: safeString(error && error.message)
      });
    }
    return res.status(expected ? (error.httpStatus || 403) : 500).json({
      status: expected ? error.code : 'error',
      message: expected ? error.message : localeCopy.copy_cea11bf163
    });
  }
});

router.post('/listMembershipAssignments', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

router.post('/listPersonIdentities', async (req, res) => {
  try {
    const legacyHrId = safeString(req.body.hrId);
    if (!legacyHrId) return res.json({ status: 'invalid_params', message: localeCopy.copy_eb00430bd4 });
    const accessList = await listAdminOrganizationAccess(req);
    const readableAccess = accessList.filter((item) => item.canReadAssignments || item.canReadAdmins);
    const readableOrganizationIds = readableAccess.map((item) => item.organizationId);
    const editableOrganizationIds = readableAccess
      .filter((item) => item.canEditAssignments)
      .map((item) => item.organizationId);
    const data = await personIdentityOverviewModel.listPersonIdentityData(
      legacyHrId,
      readableOrganizationIds,
      editableOrganizationIds
    );
    if (!data) return res.json({ status: 'not_found', message: localeCopy.copy_f4df6d5d73 });

    const accessByOrg = new Map(readableAccess.map((item) => [item.organizationId, item]));
    const assignmentsByOrg = new Map();
    data.assignments.forEach((item) => {
      const orgId = safeString(item.org_id);
      const rows = assignmentsByOrg.get(orgId) || [];
      rows.push({
        id: safeString(item.id),
        assignmentKind: safeString(item.assignment_kind),
        assignmentNature: safeString(item.assignment_kind),
        assignmentLabel: unifiedIdentityModel.buildAssignmentLabel(item),
        title: '',
        departmentId: safeString(item.department_id),
        department: safeString(item.department_name),
        identityId: safeString(item.identity_id),
        identity: safeString(item.identity_name),
        identityCategoryId: safeString(item.identity_id),
        identityCategoryName: safeString(item.identity_name),
        workGroupId: safeString(item.work_group_id),
        workGroup: safeString(item.work_group_name),
        historical: safeString(item.membership_status) === 'left'
      });
      assignmentsByOrg.set(orgId, rows);
    });
    const grantsByOrg = new Map();
    data.grants.filter((item) => safeString(item.org_id)).forEach((item) => {
      const orgId = safeString(item.org_id);
      const rows = grantsByOrg.get(orgId) || [];
      const auth = authenticationStatus(item);
      rows.push({
        id: safeString(item.legacy_admin_id),
        grantId: safeString(item.id),
        adminLevel: safeString(item.admin_level),
        adminLevelLabel: personnelCopy.regularAdministrator,
        authenticationStatus: auth.value,
        authenticationStatusLabel: auth.label
      });
      grantsByOrg.set(orgId, rows);
    });
    const dictionariesByOrg = new Map();
    const appendDictionary = (kind, item) => {
      const orgId = safeString(item.org_id);
      const current = dictionariesByOrg.get(orgId) || {
        departments: [], identities: [], workGroups: []
      };
      const value = { id: safeString(item.id), name: safeString(item.name) };
      if (kind === 'workGroups') value.departmentId = safeString(item.department_id);
      current[kind].push(value);
      dictionariesByOrg.set(orgId, current);
    };
    data.dictionaries.departments.forEach((item) => appendDictionary('departments', item));
    data.dictionaries.identities.forEach((item) => appendDictionary('identities', item));
    data.dictionaries.workGroups.forEach((item) => appendDictionary('workGroups', item));

    const operatorPersonId = safeString(req.authAccount && req.authAccount.personId);
    const organizations = data.memberships.map((membership) => {
      const orgId = safeString(membership.org_id);
      const access = accessByOrg.get(orgId) || {};
      const membershipStatus = safeString(membership.membership_status) || 'active';
      const isActiveMembership = membershipStatus === 'active';
      const adminIdentities = access.canReadAdmins ? (grantsByOrg.get(orgId) || []) : [];
      const dictionaries = dictionariesByOrg.get(orgId) || {
        departments: [], identities: [], workGroups: []
      };
      return {
        organizationId: orgId,
        organizationName: safeString(membership.organization_name),
        hrId: safeString(membership.legacy_hr_id),
        membershipStatus,
        joinedAt: membership.joined_at || null,
        leftAt: membership.left_at || null,
        canReadAssignments: Boolean(access.canReadAssignments),
        canEditAssignments: Boolean(isActiveMembership && access.canEditAssignments),
        canReadAdmins: Boolean(access.canReadAdmins),
        canEditAdmins: Boolean(isActiveMembership && access.canEditAdmins),
        assignments: access.canReadAssignments ? (assignmentsByOrg.get(orgId) || []) : [],
        adminIdentities,
        canAddAdmin: Boolean(isActiveMembership && access.canEditAdmins && !adminIdentities.length),
        dictionaries: Object.assign({}, dictionaries, {
          identityCategories: dictionaries.identities
        })
      };
    });
    const operatorIsSuperAdmin = accessList.some((item) => item.isSuperAdmin);
    const currentOrganizationId = safeString(req.authContext && req.authContext.organizationId);
    const managementOrganizationId = accessList.some((item) => item.organizationId === currentOrganizationId)
      ? currentOrganizationId
      : safeString(accessList[0] && accessList[0].organizationId);
    const globalAdminIdentities = operatorIsSuperAdmin
      ? data.grants.filter((item) => safeString(item.org_id) === '').map((item) => {
          const auth = authenticationStatus(item);
          return {
            id: safeString(item.legacy_admin_id),
            grantId: safeString(item.id),
            adminLevel: 'super_admin',
            adminLevelLabel: personnelCopy.superAdministrator,
            authenticationStatus: auth.value,
            authenticationStatusLabel: auth.label,
            canDelete: safeString(item.person_id) !== operatorPersonId
          };
        })
      : [];
    res.json({
      status: 'success',
      person: { name: safeString(data.person.name), studentId: safeString(data.person.student_id) },
      organizations,
      globalAdminIdentities,
      managementOrganizationId,
      canAddGlobalSuperAdmin: Boolean(operatorIsSuperAdmin && !globalAdminIdentities.length)
    });
  } catch (error) {
    const isExpected = error instanceof AdminOrganizationAccessError;
    if (!isExpected) req.logger.error('List person identities failed', { error: error.message });
    return res.status(isExpected ? (error.httpStatus || 403) : 500).json({
      status: isExpected ? error.code : 'error',
      message: isExpected ? error.message : localeCopy.copy_1681c6c6eb
    });
  }
});

router.post('/saveMembershipAssignment', async (req, res) => {
  try {
    const orgId = safeString(req.body.organizationId) || await getCurrentOrgId();
    const result = await unifiedIdentityModel.saveMembershipAssignment({
      id: safeString(req.body.id),
      legacyHrId: safeString(req.body.hrId),
      organizationId: orgId,
      assignmentKind: safeString(req.body.assignmentNature || req.body.assignmentKind),
      departmentId: safeString(req.body.departmentId),
      identityId: safeString(req.body.identityCategoryId || req.body.identityId),
      workGroupId: safeString(req.body.workGroupId)
    }, {
      personId: req.authAccount && req.authAccount.personId,
      contextId: req.authContext && req.authContext.contextId
    }, (connection) => requireAdminOrganizationPermission(req, orgId, ['hr.people'], connection));
    return res.json({ status: 'success', id: result.id, message: localeCopy.copy_735e0a8bcf });
  } catch (error) {
    const isExpected = error instanceof AdminOrganizationAccessError
      || error instanceof unifiedIdentityModel.IdentityError;
    if (!isExpected) req.logger.error('Save membership assignment failed', { error: error.message });
    return res.status(isExpected ? (error.httpStatus || 400) : 500).json({
      status: isExpected ? error.code : 'error',
      message: isExpected ? error.message : localeCopy.copy_e1a5d7bc94
    });
  }
});

router.post('/deleteMembershipAssignment', async (req, res) => {
  try {
    const orgId = safeString(req.body.organizationId) || await getCurrentOrgId();
    await unifiedIdentityModel.revokeMembershipAssignment({
      id: safeString(req.body.id),
      organizationId: orgId
    }, {
      personId: req.authAccount && req.authAccount.personId,
      contextId: req.authContext && req.authContext.contextId
    }, (connection) => requireAdminOrganizationPermission(req, orgId, ['hr.people'], connection));
    return res.json({ status: 'success', message: localeCopy.copy_63c465d5f0 });
  } catch (error) {
    const isExpected = error instanceof AdminOrganizationAccessError
      || error instanceof unifiedIdentityModel.IdentityError;
    if (!isExpected) req.logger.error('Delete membership assignment failed', { error: error.message });
    return res.status(isExpected ? (error.httpStatus || 400) : 500).json({
      status: isExpected ? error.code : 'error',
      message: isExpected ? error.message : localeCopy.copy_f7ed2e08ad
    });
  }
});

// saveHrInfo
router.post('/saveHrInfo', async (req, res) => {
  try {
    const admin = await resolveRequestAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const name = safeString(req.body.name);
    const studentId = safeString(req.body.studentId);

    if (!name || !studentId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_b84dcf2aa6 });
    }

    const existingId = safeString(req.body.id);
    if (existingId) {
      const existing = await hrInfoModel.getById(existingId);
      if (!existing) {
        return res.json({ status: 'not_found', message: localeCopy.copy_eb00430bd4 });
      }
      if (name !== safeString(existing.name) || studentId !== safeString(existing.student_id)) {
        return res.json({
          status: 'person_correction_required',
          message: personnelCopy.personCorrectionRequired
        });
      }
      return res.json({ status: 'success', id: existingId, message: localeCopy.copy_339e79984b });
    }

    const existingMember = await hrInfoModel.getByStudentIdIncludingFormer(studentId);
    if (existingMember) {
      const membershipStatus = safeString(existingMember.membership_status);
      const isFormer = membershipStatus === 'left';
      const isActive = membershipStatus === 'active';
      return res.status(409).json({
        status: isFormer
          ? 'member_reactivation_required'
          : (isActive ? 'member_already_exists' : 'member_record_unavailable'),
        message: isFormer
          ? personnelCopy.formerMemberRequiresReactivation
          : (isActive ? personnelCopy.activeMemberAlreadyExists : personnelCopy.memberRecordUnavailable),
        id: safeString(existingMember.id)
      });
    }

    const newId = generateId();
    await hrInfoModel.create(newId, {
      name,
      studentId,
      departmentId: '',
      identityId: '',
      workGroupId: ''
    });
    res.json({ status: 'success', id: newId, message: localeCopy.copy_339e79984b });
  } catch (e) {
    return sendHrRouteFailure(req, res, e);
  }
});

// deleteHrInfo
router.post('/deleteHrInfo', async (req, res) => {
  try {
    const orgId = safeString(req.body.organizationId) || await getCurrentOrgId();
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_eb00430bd4 });
    const result = await pool.withTransaction(async (connection) => {
      await requireAdminOrganizationPermission(req, orgId, ['hr.people'], connection);
      return unifiedIdentityModel.removeLegacyHrRecord(connection, id, orgId, {
        personId: safeString(req.authAccount && req.authAccount.personId),
        contextId: safeString(req.authContext && req.authContext.contextId),
        requestId: safeString(req.requestId),
        ip: safeString(req.ip)
      });
    });
    if (!result || !result.left) {
      return res.json({ status: 'not_found', message: personnelCopy.formerMemberNotFound });
    }
    res.json({ status: 'success', left: true, message: personnelCopy.memberLeftOrganization });
  } catch (e) {
    const isExpected = e instanceof AdminOrganizationAccessError
      || e instanceof unifiedIdentityModel.IdentityError;
    res.status(isExpected ? (e.httpStatus || 400) : 500).json({
      status: isExpected ? safeString(e.code) : 'error',
      message: isExpected ? safeString(e.message) : localeCopy.copy_1681c6c6eb
    });
  }
});

router.post('/listFormerHrMembers', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

router.post('/reactivateHrMembership', async (req, res) => {
  try {
    const orgId = safeString(req.body.organizationId) || await getCurrentOrgId();
    const result = await unifiedIdentityModel.reactivateMembership({
      organizationId: orgId,
      legacyHrId: safeString(req.body.hrId)
    }, {
      personId: req.authAccount && req.authAccount.personId,
      contextId: req.authContext && req.authContext.contextId
    }, (connection) => requireAdminOrganizationPermission(req, orgId, ['hr.people'], connection));
    return res.json({
      status: 'success',
      reactivated: Boolean(result.reactivated),
      message: result.reactivated
        ? personnelCopy.membershipReactivated
        : personnelCopy.memberAlreadyActive
    });
  } catch (error) {
    return sendHrRouteFailure(req, res, error);
  }
});

function deletionActor(req, access) {
  const effective = access && access.effective || {};
  return {
    personId: safeString(req.authAccount && req.authAccount.personId),
    contextId: safeString(req.authContext && req.authContext.contextId),
    organizationId: safeString(access && access.organizationId),
    adminLevel: effective.isSuper ? 'super_admin' : 'admin'
  };
}

function deletionAuthorize(req, organizationId) {
  return async (connection) => {
    const access = await requireAdminOrganizationPermission(
      req,
      organizationId,
      ['hr.people'],
      connection
    );
    return deletionActor(req, access);
  };
}

function deletionRequestData(req, scope, organizationId) {
  return {
    scope,
    organizationId,
    legacyHrId: safeString(req.body && (req.body.hrId || req.body.legacyHrId)),
    personId: safeString(req.body && req.body.personId),
    expectedVersion: safeString(req.body && req.body.expectedVersion),
    clientRequestId: safeString(req.body && req.body.clientRequestId),
    acceptCleanup: Boolean(req.body && req.body.acceptCleanup === true),
    confirmStudentId: safeString(req.body && req.body.confirmStudentId),
    requestId: safeString(req.requestId),
    ip: safeString(req.ip)
  };
}

function sendDeletionError(req, res, error) {
  const expected = error instanceof hrMemberDeletionService.HrMemberDeletionError
    || error instanceof AdminOrganizationAccessError;
  if (!expected && req.logger) {
    req.logger.error('HR permanent deletion failed', {
      event: 'hr.member_permanent_deletion_failed',
      code: safeString(error && error.code),
      error: safeString(error && error.message)
    });
  }
  const code = expected ? safeString(error.code) : 'error';
  return res.status(expected ? (error.httpStatus || 400) : 500).json({
    status: code,
    message: personnelCopy.hrDeletionMessages[code]
      || (expected ? personnelCopy.hrDeletionFailed : personnelCopy.hrDeletionSystemError),
    details: error && error.details || null
  });
}

router.post('/previewHrMemberDeletion', async (req, res) => {
  try {
    const organizationId = safeString(req.body && req.body.organizationId) || await getCurrentOrgId();
    const access = await requireAdminOrganizationPermission(req, organizationId, ['hr.people']);
    const scope = safeString(req.body && req.body.scope) || hrMemberDeletionService.MEMBERSHIP_SCOPE;
    const preview = await hrMemberDeletionService.previewHrMemberDeletion(
      deletionRequestData(req, scope, organizationId),
      deletionActor(req, access)
    );
    return res.json({ status: 'success', preview });
  } catch (error) {
    return sendDeletionError(req, res, error);
  }
});

router.post('/deleteHrMembershipPermanently', async (req, res) => {
  try {
    const organizationId = safeString(req.body && req.body.organizationId) || await getCurrentOrgId();
    const access = await requireAdminOrganizationPermission(req, organizationId, ['hr.people']);
    const result = await hrMemberDeletionService.deleteHrMembershipPermanently(
      deletionRequestData(req, hrMemberDeletionService.MEMBERSHIP_SCOPE, organizationId),
      deletionActor(req, access),
      { authorize: deletionAuthorize(req, organizationId) }
    );
    return res.json({ status: 'success', result, message: personnelCopy.hrMembershipPermanentlyDeleted });
  } catch (error) {
    return sendDeletionError(req, res, error);
  }
});

router.post('/deletePersonPermanently', async (req, res) => {
  try {
    const organizationId = safeString(req.body && req.body.organizationId) || await getCurrentOrgId();
    const access = await requireAdminOrganizationPermission(req, organizationId, ['hr.people']);
    const result = await hrMemberDeletionService.deletePersonPermanently(
      deletionRequestData(req, hrMemberDeletionService.PERSON_SCOPE, organizationId),
      deletionActor(req, access),
      { authorize: deletionAuthorize(req, organizationId) }
    );
    return res.json({ status: 'success', result, message: personnelCopy.personPermanentlyDeleted });
  } catch (error) {
    return sendDeletionError(req, res, error);
  }
});

router.post('/previewPersonIdentityCorrection', async (req, res) => {
  try {
    const orgId = safeString(req.body.organizationId) || await getCurrentOrgId();
    await requireAdminOrganizationPermission(req, orgId, ['auth.accounts.global_manage']);
    const result = await personGovernanceModel.previewCorrection({
      legacyHrId: safeString(req.body.hrId),
      organizationId: orgId,
      name: safeString(req.body.name),
      studentId: safeString(req.body.studentId)
    });
    if (!result) return res.status(404).json({ status: 'not_found', message: personnelCopy.formerMemberNotFound });
    return res.json({ status: 'success', preview: result });
  } catch (error) {
    return sendHrRouteFailure(req, res, error);
  }
});

router.post('/applyPersonIdentityCorrection', async (req, res) => {
  try {
    const orgId = safeString(req.body.organizationId) || await getCurrentOrgId();
    await requireAdminOrganizationPermission(req, orgId, ['auth.accounts.global_manage']);
    const result = await personGovernanceModel.applyCorrection({
      legacyHrId: safeString(req.body.hrId),
      organizationId: orgId,
      name: safeString(req.body.name),
      studentId: safeString(req.body.studentId),
      version: safeString(req.body.version)
    }, {
      personId: req.authAccount && req.authAccount.personId,
      contextId: req.authContext && req.authContext.contextId
    });
    return res.json({ status: 'success', result, message: personnelCopy.personCorrectionChanged });
  } catch (error) {
    return sendHrRouteFailure(req, res, error);
  }
});

router.post('/mergePersons', async (req, res) => {
  try {
    if (req.body.confirmed !== true) {
      return res.status(400).json({ status: 'confirmation_required', message: personnelCopy.personMergeConfirmationRequired });
    }
    const organizationId = safeString(req.body.organizationId) || await getCurrentOrgId();
    await requireAdminOrganizationPermission(req, organizationId, ['auth.accounts.global_manage']);
    const result = await personGovernanceModel.mergePersons({
      sourcePersonId: safeString(req.body.sourcePersonId),
      targetPersonId: safeString(req.body.targetPersonId),
      sourceVersion: safeString(req.body.sourceVersion),
      targetVersion: safeString(req.body.targetVersion),
      organizationId
    }, {
      personId: req.authAccount && req.authAccount.personId,
      contextId: req.authContext && req.authContext.contextId
    });
    return res.json({ status: 'success', result, message: personnelCopy.personMergeCompleted });
  } catch (error) {
    return sendHrRouteFailure(req, res, error);
  }
});

async function handleStructuredHrImport(req, res, previewOnly) {
  try {
    const admin = await resolveRequestAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const orgId = await getCurrentOrgId();
    const result = previewOnly
      ? await hrTableImportModel.previewHrTableImport(req.body, orgId)
      : await hrTableImportModel.importHrTable(req.body, orgId);
    return res.json(result);
  } catch (error) {
    const isExpectedImportError = error instanceof hrTableImportModel.HrTableImportError;
    if (req.logger) {
      req.logger.error('hr table import failed', {
        endpoint: previewOnly ? 'previewHrTableImport' : 'importHrTable',
        status: safeString(error.status) || 'error',
        error: safeString(error.message),
        stack: error.stack
      });
    }
    return res.json({
      status: isExpectedImportError ? safeString(error.status) : 'error',
      message: isExpectedImportError ? safeString(error.message) : localeCopy.copy_5840966982,
      requestId: req.requestId || ''
    });
  }
}

router.post('/previewHrTableImport', async (req, res) => {
  await handleStructuredHrImport(req, res, true);
});

router.post('/importHrTable', async (req, res) => {
  await handleStructuredHrImport(req, res, false);
});

router.post('/importHrCsv', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// batchMaintainFromHrInfo
router.post('/batchMaintainFromHrInfo', async (req, res) => {
  try {
    const admin = await resolveRequestAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const orgId = await getCurrentOrgId();
    const stats = await assignmentDictionaryIntegrity.checkOrganization(orgId);

    if (stats.missingDepartments || stats.missingIdentities || stats.missingWorkGroups || stats.wrongDepartmentWorkGroups) {
      return res.json({
        status: 'error',
        message: localeFormat(localeCopy.copy_9984afb98e, [stats.missingDepartments, stats.missingIdentities, stats.missingWorkGroups, stats.wrongDepartmentWorkGroups]),
        stats
      });
    }

    res.json({ status: 'success', message: localeCopy.copy_c2a4637e57, stats });
  } catch (e) {
    return sendHrRouteFailure(req, res, e);
  }
});

// unbindHrWechat — 管理员从全部组织解绑指定人事对应的微信
router.post('/unbindHrWechat', async (req, res) => {
  let connection;
  try {
    const admin = await resolveRequestAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const canGlobalAccountManage = Boolean(req.adminPermissions
      && req.adminPermissions.permissions
      && req.adminPermissions.permissions['auth.accounts.global_manage']);
    if (admin.admin_level !== 'super_admin' && !canGlobalAccountManage) {
      return res.status(403).json({
        status: 'permission_denied',
        message: personnelCopy.globalAccountManageRequired
      });
    }

    const hrId = safeString(req.body.hrId);
    if (!hrId) return res.json({ status: 'invalid_params', message: localeCopy.copy_eb00430bd4 });

    const orgId = await getCurrentOrgId();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const unifiedResult = await unifiedIdentityModel.resetAccountByLegacyHr(
      connection,
      hrId,
      orgId,
      {
        personId: req.authAccount && req.authAccount.personId,
        contextId: req.authContext && req.authContext.contextId
      },
      'administrator_hr_reset'
    );
    if (unifiedResult) {
      await connection.commit();
      return res.json({
        status: 'success',
        message: localeCopy.copy_806092b494,
        recoveryRequired: false,
        unbound: true
      });
    }
    // 未找到统一账号时不能沿旧微信映射跨组织删除，避免影响另一自然人。
    await connection.rollback();
    return res.json({ status: 'not_found', message: localeCopy.copy_cf56435dad });
  } catch (e) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    return sendHrRouteFailure(req, res, e);
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
