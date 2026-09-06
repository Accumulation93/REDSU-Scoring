const localeCopy = require('../../locales/zh-CN/generated/core/services/adminPermissions');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const PERMISSION_GROUPS = [
  {
    key: 'authentication',
    label: localeCopy.copy_3d91f89e36,
    description: '',
    permissions: [
      { key: 'auth.identity.verify', label: localeCopy.copy_3d91f89e36, description: localeCopy.copy_0b8c4db3d7 },
      { key: 'auth.accounts.recover', label: localeCopy.copy_d2d3397a14, description: localeCopy.copy_e5dc008226 },
      { key: 'auth.accounts.global_manage', label: personnelCopy.globalAccountPermissionLabel, description: personnelCopy.globalAccountPermissionDescription, targetLevels: ['super_admin'], defaultLevels: ['super_admin'] },
      // 保留权限键和服务端审计能力以兼容既有授权，但不再把内部安全日志展示为管理界面功能。
      { key: 'auth.accounts.audit', label: localeCopy.copy_aa74d1acc1, description: '', hidden: true },
      { key: 'auth.policy.manage', label: localeCopy.copy_aef40f4a64, description: localeCopy.copy_514de1fe35, targetLevels: ['admin'], defaultLevels: [] }
    ]
  },
  {
    key: 'permissions',
    label: localeCopy.copy_860c048463,
    description: '',
    permissions: [
      { key: 'permissions.manage_regular_admins', label: localeCopy.copy_0b7fec3735, description: localeCopy.copy_95ec2d2724, targetLevels: ['admin'], defaultLevels: [] }
    ]
  },
  {
    key: 'scoring',
    label: localeCopy.copy_33a502217d,
    description: '',
    permissions: [
      { key: 'scoring.activities', label: localeCopy.copy_f82fa46dc7, description: localeCopy.copy_2ba844c95a },
      { key: 'scoring.templates', label: localeCopy.copy_fac1711a09, description: localeCopy.copy_30996e4de7 },
      { key: 'scoring.rules', label: localeCopy.copy_c4f0888fa9, description: localeCopy.copy_a31e1d19cf },
      { key: 'scoring.results', label: localeCopy.copy_96421f734b, description: localeCopy.copy_1ceabc2771 },
      { key: 'scoring.results_export', label: localeCopy.copy_e637e8ebce, description: localeCopy.copy_409eac7a4a },
      { key: 'scoring.results_revoke', label: localeCopy.copy_2cbadf7345, description: localeCopy.copy_2105966964 },
      { key: 'scoring.publications', label: localeCopy.copy_5fef2a914e, description: localeCopy.copy_cd2429bc0e }
    ]
  },
  {
    key: 'hr',
    label: localeCopy.copy_eb65126cfe,
    description: '',
    permissions: [
      { key: 'hr.people', label: localeCopy.copy_865032d8a0, description: localeCopy.copy_142b3cb095 },
      { key: 'hr.import', label: localeCopy.copy_c809ebc5da, description: localeCopy.copy_9b9cb39d96 },
      { key: 'hr.profile_review', label: localeCopy.copy_46b341ec43, description: localeCopy.copy_9cae55038b },
      { key: 'hr.profile_templates.manage', label: localeCopy.copy_7cab7f5321, description: localeCopy.copy_f486291a2d },
      { key: 'hr.profile_templates.select', label: localeCopy.copy_21c318349a, description: localeCopy.copy_3985c940f4 },
      { key: 'hr.departments', label: localeCopy.copy_5b87380932, description: localeCopy.copy_c738544c87 },
      { key: 'hr.identities', label: localeCopy.copy_9fb8fb55bc, description: localeCopy.copy_7b26b33399 },
      { key: 'hr.work_groups', label: localeCopy.copy_25654e7a6e, description: localeCopy.copy_01693f8904 }
    ]
  },
  {
    key: 'audit',
    label: localeCopy.copy_4f6ab0ccf7,
    description: '',
    permissions: [
      { key: 'audit.templates', label: localeCopy.copy_ad546eb2dc, description: localeCopy.copy_783f2b3012 },
      { key: 'audit.stamps', label: localeCopy.copy_1ceb23e763, description: localeCopy.copy_fc760da0ff },
      { key: 'audit.submissions', label: localeCopy.copy_83c3471991, description: localeCopy.copy_547867cecd },
      { key: 'audit.verification', label: localeCopy.copy_9e2295b6fc, description: localeCopy.copy_c25a6ae418 }
    ]
  },
  {
    key: 'venue',
    label: localeCopy.copy_ceffdfcdd7,
    description: '',
    permissions: [
      { key: 'venue.resources', label: localeCopy.copy_eed42b6ab7, description: localeCopy.copy_33a1ff1645 },
      { key: 'venue.bookings', label: localeCopy.copy_20ba89a1cc, description: localeCopy.copy_2af5a1edc2 },
      { key: 'venue.approvals', label: localeCopy.copy_f46b4e54f4, description: localeCopy.copy_56333a8d42 },
      { key: 'venue.purposes', label: localeCopy.copy_8dcf3fcf0b, description: localeCopy.copy_69c1bbec34 }
    ]
  },
  {
    key: 'system',
    label: localeCopy.copy_5b4cf5d1bf,
    description: '',
    permissions: [
      { key: 'system.admin_accounts.read', label: localeCopy.copy_ebb6d5ebfb, description: localeCopy.copy_8c15f54beb },
      { key: 'system.admin_accounts.write', label: localeCopy.copy_fa3f577b48, description: localeCopy.copy_95e5f8ae4b },
      { key: 'system.settings', label: localeCopy.copy_6fd8e21d26, description: localeCopy.copy_b93169a87f },
      { key: 'system.organizations', label: localeCopy.copy_2eb6aec1c5, description: localeCopy.copy_163e9bde7d, targetLevels: [], defaultLevels: [] }
    ]
  }
];

const PERMISSION_DEFINITIONS = new Map();
PERMISSION_GROUPS.forEach((group) => {
  group.permissions.forEach((permission) => {
    PERMISSION_DEFINITIONS.set(permission.key, Object.assign({
      groupKey: group.key,
      targetLevels: ['admin'],
      defaultLevels: []
    }, permission));
  });
});

const ROUTE_RULES = new Map();

const HR_DIRECTORY_PERMISSIONS = Object.freeze([
  'hr.people', 'hr.import', 'hr.profile_review', 'scoring.publications', 'venue.resources',
  'audit.templates', 'audit.stamps', 'audit.submissions', 'audit.verification'
]);

const HR_GOVERNANCE_DIRECTORY_PERMISSIONS = Object.freeze([
  'auth.identity.verify', 'auth.accounts.recover', 'auth.accounts.global_manage'
]);

function mapRoutes(permissionKey, routes, options = {}) {
  routes.forEach((route) => ROUTE_RULES.set(route, {
    anyOf: [permissionKey],
    allowUserRole: Boolean(options.allowUserRole)
  }));
}

function mapAny(routes, permissionKeys, options = {}) {
  routes.forEach((route) => ROUTE_RULES.set(route, {
    anyOf: permissionKeys,
    allowUserRole: Boolean(options.allowUserRole)
  }));
}

mapAny(['/listScoreActivities'], [
  'scoring.activities', 'scoring.rules', 'scoring.results', 'scoring.publications'
]);
mapAny(['/getCurrentScoreActivity'], [
  'scoring.activities', 'scoring.rules', 'scoring.results', 'scoring.publications'
], { allowUserRole: true });
mapAny(['/getLatestPublishedScoreActivity'], [
  'scoring.activities', 'scoring.rules', 'scoring.results', 'scoring.publications'
], { allowUserRole: true });
mapRoutes('scoring.activities', ['/saveScoreActivity', '/deleteScoreActivity', '/setCurrentScoreActivity', '/toggleActivityPause']);
mapAny(['/listScoreTemplates'], ['scoring.templates', 'scoring.rules']);
mapRoutes('scoring.templates', ['/saveScoreTemplate', '/deleteScoreTemplate', '/duplicateScoreTemplate']);
mapRoutes('scoring.rules', [
  '/listRateRules', '/saveRateRule', '/batchSaveRateRules', '/deleteRateRule', '/generateRateTargetRules'
]);
mapRoutes('scoring.results', ['/getScoreResults', '/getScorerTaskStatus']);
mapRoutes('scoring.results_export', ['/exportScoreResults', '/exportScorerTaskStatus']);
mapRoutes('scoring.results_revoke', ['/revokeScoreRecord']);
mapRoutes('scoring.publications', [
  '/getResultPublication', '/saveResultPublication', '/saveResultViewPermission', '/deleteResultViewPermission',
  '/saveMeritListPermission', '/deleteMeritListPermission', '/saveMeritListDesignations', '/removeMeritListDesignation',
  '/generatePubViewRules', '/generatePubMeritRules', '/savePubViewRule', '/listPubViewRules', '/deletePubViewRule',
  '/batchSavePubViewRules', '/batchDeletePubViewRules',
  '/savePubMeritRule', '/listPubMeritRules', '/deletePubMeritRule',
  '/batchSavePubMeritRules', '/batchDeletePubMeritRules', '/getMeritListSummary', '/exportMeritListSummary'
]);

mapAny(['/listHrInfo'], HR_DIRECTORY_PERMISSIONS);
mapAny(['/listHrGovernance'], HR_GOVERNANCE_DIRECTORY_PERMISSIONS);
mapRoutes('hr.people', [
  '/saveHrInfo',
  '/deleteHrInfo',
  '/batchMaintainFromHrInfo',
  '/listMembershipAssignments',
  '/saveMembershipAssignment',
  '/deleteMembershipAssignment',
  '/listFormerHrMembers',
  '/reactivateHrMembership',
  '/previewHrMemberDeletion',
  '/deleteHrMembershipPermanently',
  '/deletePersonPermanently'
]);
mapAny(['/listPersonIdentities'], [
  'hr.people', 'hr.profile_review', 'system.admin_accounts.read', 'system.admin_accounts.write'
]);
mapRoutes('hr.import', ['/previewHrTableImport', '/importHrTable', '/importHrCsv']);
mapAny(['/listHrProfileAdminData'], ['hr.people', 'hr.profile_review']);
mapAny(['/getHrPersonDetail'], ['hr.people', 'hr.profile_review']);
mapRoutes('hr.people', ['/saveHrPersonFull']);
mapRoutes('hr.profile_review', ['/reviewHrProfileChange']);
mapAny(['/listHrProfileTemplates'], ['hr.profile_templates.manage', 'hr.profile_templates.select']);
mapRoutes('hr.profile_templates.manage', [
  '/saveHrProfileTemplateDefinition', '/duplicateHrProfileTemplateDefinition', '/deleteHrProfileTemplateDefinition',
  '/saveHrProfileTemplate'
]);
mapRoutes('hr.profile_templates.select', [
  '/getHrProfileTemplateSwitchContext', '/previewHrProfileTemplateSwitch',
  '/applyHrProfileTemplateSwitch', '/saveOrgHrProfileTemplateSettings'
]);
mapRoutes('hr.departments', ['/saveDepartment', '/deleteDepartment']);
mapRoutes('hr.identities', ['/saveIdentity', '/deleteIdentity']);
mapRoutes('hr.work_groups', ['/saveWorkGroup', '/deleteWorkGroup']);

mapRoutes('audit.templates', ['/listAuditFlowTemplates', '/saveAuditFlowTemplate', '/deleteAuditFlowTemplate']);
mapRoutes('audit.stamps', ['/listStamps', '/saveStamp', '/deleteStamp', '/saveStampAssignments', '/listIdentityStamps', '/listStampCandidates', '/saveStampGrants']);
mapRoutes('audit.submissions', ['/listAllAuditSubmissions', '/getAuditProgress']);
mapRoutes('audit.submissions', ['/getSubmissionDetail'], { allowUserRole: true });
mapRoutes('audit.submissions', [
  '/getAuditFile', '/downloadAuditFile', '/getAuditFilePreview'
], { allowUserRole: true });
mapRoutes('audit.verification', ['/listVerificationPermissions', '/saveVerificationPermission', '/verifyAuditFile']);
mapRoutes('audit.verification', ['/getAuditVerificationAccess', '/verifySignatureChain'], { allowUserRole: true });

mapAny(['/listVenues'], ['venue.resources', 'venue.bookings', 'venue.approvals']);
mapRoutes('venue.resources', [
  '/saveVenue', '/deleteVenue', '/listVenueOpenRules', '/saveVenueOpenRule', '/deleteVenueOpenRule',
  '/listVenueActivityRules', '/saveVenueActivityRule', '/deleteVenueActivityRule'
]);
mapAny(['/getVenueSchedule'], ['venue.resources', 'venue.bookings'], { allowUserRole: true });
mapAny(['/listAllVenueBookings'], ['venue.bookings', 'venue.approvals']);
mapRoutes('venue.bookings', ['/createAdminVenueBooking']);
mapRoutes('venue.approvals', [
  '/listVenueBookingRules', '/saveVenueBookingWindow', '/saveVenueBookingRule', '/deleteVenueBookingRule',
  '/getVenueApprovalFlow', '/saveVenueApprovalFlow', '/deleteVenueApprovalFlow', '/saveVenueApprovalStep',
  '/saveVenueApprovalWholeFlow', '/deleteVenueApprovalStep', '/saveVenueApprovalStepRule', '/deleteVenueApprovalStepRule',
  '/listVenueApprovalFlows', '/saveVenueApprovalFlowMeta',
  '/approveVenueBooking', '/rejectVenueBooking', '/approveVenueBookingAdmin', '/rejectVenueBookingAdmin'
]);
mapRoutes('venue.approvals', [
  '/approveVenueBookingStep', '/rejectVenueBookingStep', '/listPendingVenueApprovals',
  '/listVenueApprovalHistory', '/getVenueApprovalHistoryDetail'
], { allowUserRole: true });
mapAny(['/listVenueBookingPurposes'], [
  'venue.resources', 'venue.bookings', 'venue.purposes'
], { allowUserRole: true });
mapRoutes('venue.purposes', ['/saveVenueBookingPurpose', '/deleteVenueBookingPurpose']);

mapRoutes('system.admin_accounts.read', ['/listAdmins', '/exportAdmins', '/listUserBindings']);
mapAny(['/saveAdmin', '/deleteAdmin'], ['system.admin_accounts.write', 'hr.people']);
mapRoutes('system.admin_accounts.write', [
  '/createAdminInvite', '/generateAdminInviteCode'
]);
mapRoutes('system.settings', ['/getSystemConfig', '/saveSystemConfig', '/listOrganizations', '/admin/health']);
mapRoutes('system.organizations', ['/saveOrganization', '/deleteOrganization', '/switchOrganization']);
mapRoutes('auth.identity.verify', ['/admin/auth/claims']);
mapRoutes('auth.accounts.recover', [
  '/admin/auth/recoveries', '/admin/auth/accounts'
]);
mapRoutes('auth.accounts.global_manage', [
  '/unbindHrWechat', '/adminUnbindUser',
  '/previewPersonIdentityCorrection', '/applyPersonIdentityCorrection', '/mergePersons',
  '/admin/auth/security', '/admin/auth/security/sessions/revoke',
  '/admin/auth/security/passphrase', '/admin/auth/security/passphrase/revoke'
]);
mapRoutes('auth.accounts.audit', ['/admin/auth/audit']);
mapRoutes('auth.policy.manage', ['/admin/auth/policy']);
mapAny(['/parseTableFile', '/buildTableFile'], [
  'hr.import', 'hr.people', 'hr.profile_review', 'scoring.templates'
]);

function listPermissionKeys() {
  return Array.from(PERMISSION_DEFINITIONS.keys());
}

function defaultGranted(adminLevel, definition) {
  return definition.defaultLevels.indexOf(adminLevel) >= 0;
}

function isApplicable(permissionKey, adminLevel) {
  const definition = PERMISSION_DEFINITIONS.get(permissionKey);
  return Boolean(definition && definition.targetLevels.indexOf(adminLevel) >= 0);
}

function canConfigureAdminPermissions(operator, effective, target, orgId) {
  if (!operator || !target || target.org_id !== orgId || target.id === operator.id) return false;
  if (operator.admin_level === 'super_admin') return target.admin_level === 'admin';
  return operator.admin_level === 'admin'
    && Boolean(effective && effective.canAccessPermissionSystem)
    && target.admin_level === 'admin';
}

function editablePermissionKeys(operator, effective, target, orgId, targetEffective) {
  if (!canConfigureAdminPermissions(operator, effective, target, orgId)) return [];
  const applicableKeys = Array.from(PERMISSION_DEFINITIONS.keys())
    .filter((key) => isApplicable(key, target.admin_level));
  if (operator.admin_level === 'super_admin') return applicableKeys;
  const editableKeys = applicableKeys.filter((key) => key !== 'permissions.manage_regular_admins'
    && Boolean(effective.permissions && effective.permissions[key]));
  if (targetEffective
    && targetEffective.permissions
    && targetEffective.permissions['system.admin_accounts.write']
    && !editableKeys.includes('system.admin_accounts.write')) {
    return editableKeys.filter((key) => key !== 'system.admin_accounts.read');
  }
  return editableKeys;
}

async function loadEffectivePermissions(admin, orgId, connection) {
  if (!admin) return { permissions: {}, keys: [], isSuper: false, canAccessPermissionSystem: false };
  const isSuper = admin.admin_level === 'super_admin';
  const permissions = {};
  PERMISSION_DEFINITIONS.forEach((definition, key) => {
    permissions[key] = isSuper || defaultGranted(admin.admin_level, definition);
  });

  if (!isSuper && orgId && admin.org_id === orgId) {
    const adminPermissionModel = require('../models/adminPermission');
    const rows = await adminPermissionModel.getOverrides(orgId, admin.id, connection);
    rows.forEach((row) => {
      if (PERMISSION_DEFINITIONS.has(row.permission_key) && isApplicable(row.permission_key, admin.admin_level)) {
        permissions[row.permission_key] = Boolean(row.granted);
      }
    });
  }

  if (permissions['system.admin_accounts.write']) {
    permissions['system.admin_accounts.read'] = true;
  }

  const keys = Object.keys(permissions).filter((key) => permissions[key]);
  return {
    permissions,
    keys,
    isSuper,
    canAccessPermissionSystem: isSuper || (admin.admin_level === 'admin' && Boolean(permissions['permissions.manage_regular_admins']))
  };
}

function hasAnyPermission(effective, keys) {
  if (!effective) return false;
  if (effective.isSuper) return true;
  return (keys || []).some((key) => effective.permissions && effective.permissions[key]);
}

function hasGrantedPermission(source, permissionKey) {
  if (!source || !permissionKey) return false;
  if (source.isSuper) return true;
  if (Array.isArray(source.permissions)) {
    return source.permissions.includes('*') || source.permissions.includes(permissionKey);
  }
  return Boolean(source.permissions && source.permissions[permissionKey]);
}

function scopeAccountSessions(sessions, organizationId, canGlobalManage) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (canGlobalManage) return list.slice();
  const scopedOrganizationId = String(organizationId || '').trim();
  if (!scopedOrganizationId) return [];
  return list.filter((session) => String(session && session.organization_id || '').trim() === scopedOrganizationId);
}

function serializeCatalog(targetLevel, effectivePermissions, editableKeys) {
  const editableSet = new Set(editableKeys || []);
  return PERMISSION_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    description: group.description,
    permissions: group.permissions
      .filter((item) => !item.hidden && isApplicable(item.key, targetLevel))
      .map((item) => ({
        key: item.key,
        label: item.label,
        description: item.description,
        granted: Boolean(effectivePermissions && effectivePermissions[item.key]),
        editable: editableSet.has(item.key)
      }))
  })).filter((group) => group.permissions.length > 0);
}

module.exports = {
  PERMISSION_GROUPS,
  PERMISSION_DEFINITIONS,
  ROUTE_RULES,
  HR_DIRECTORY_PERMISSIONS,
  HR_GOVERNANCE_DIRECTORY_PERMISSIONS,
  listPermissionKeys,
  defaultGranted,
  isApplicable,
  canConfigureAdminPermissions,
  editablePermissionKeys,
  loadEffectivePermissions,
  hasAnyPermission,
  hasGrantedPermission,
  scopeAccountSessions,
  serializeCatalog
};
