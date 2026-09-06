const { authContext: localeCopy } = require('../locales/zh-CN/main');
const {
  callFunction,
  markAuthenticationReady,
  beginContextActivation,
  endContextActivation
} = require('./api');
const eventBus = require('./eventBus');
const orgSession = require('./orgSession');

const CONTEXTS_KEY = 'authContexts';
const WORK_CONTEXTS_KEY = 'authWorkContexts';
const ORGANIZATIONS_KEY = 'authOrganizations';
const IDENTITIES_KEY = 'authIdentities';
const SELECTION_KEY = 'authSelection';
const ACCOUNT_KEY = 'accountProfile';
const PROFILE_KEY = 'roleProfiles';

let runtimeAuthenticatedState = null;
let persistenceGeneration = 0;
let catalogPersistenceGeneration = 0;

function getAuthenticatedState() {
  const compact = typeof orgSession.getAuthenticatedState === 'function'
    ? orgSession.getAuthenticatedState()
    : null;
  if (compact && typeof compact === 'object') {
    // App 级会话跨分包共享；它必须覆盖当前分包可能缓存的旧角色资料。
    runtimeAuthenticatedState = compact;
    return compact;
  }
  return runtimeAuthenticatedState;
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function buildAssignmentLabel(source) {
  if (!source) return '';
  if (source.assignmentLabel) return stringValue(source.assignmentLabel);
  if (source.assignmentName) return stringValue(source.assignmentName);
  return [
    source.identityCategoryName || source.identity,
    source.department,
    source.workGroup
  ].filter(Boolean).join(' · ');
}

function normalizeProfile(user) {
  const source = user || {};
  const permissionKeys = Array.isArray(source.permissions)
    ? source.permissions
    : (source.permissionKeys || []);
  const permissions = {};
  permissionKeys.forEach(function(key) { permissions[key] = true; });
  if (source.permissions && !Array.isArray(source.permissions)) {
    Object.keys(source.permissions).forEach(function(key) {
      permissions[key] = Boolean(source.permissions[key]);
    });
  }
  const identityCategoryId = source.identityCategoryId || source.identityId || '';
  const identityCategoryName = source.identityCategoryName || source.identity || '';
  return {
    id: source.id || source.hrId || '',
    hrId: source.hrId || '',
    contextId: source.contextId || '',
    organizationId: source.organizationId || source.orgId || '',
    organizationName: source.organizationName || source.orgName || '',
    personId: source.personId || '',
    membershipId: source.membershipId || '',
    assignmentId: source.assignmentId || '',
    adminGrantId: source.adminGrantId || '',
    name: source.name || '',
    studentId: source.studentId || '',
    departmentId: source.departmentId || '',
    department: source.department || '',
    identityCategoryId,
    identityCategoryName,
    identityId: identityCategoryId,
    identity: identityCategoryName,
    workGroupId: source.workGroupId || '',
    workGroup: source.workGroup || '',
    assignmentNature: source.assignmentNature || source.assignmentKind || '',
    assignmentLabel: buildAssignmentLabel(source),
    adminLevel: source.adminLevel || '',
    permissions: permissions,
    permissionKeys: permissionKeys,
    canAccessPermissionSystem: Boolean(source.canAccessPermissionSystem)
  };
}

function normalizeSelection(selection, fallbackContext, knownContexts) {
  const source = selection && typeof selection === 'object' ? selection : {};
  const context = fallbackContext || {};
  const organizationId = stringValue(source.organizationId || context.organizationId);
  const directContextId = stringValue(source.contextId || context.contextId);
  const legacyReference = stringValue(source.identityId || context.authIdentityId);
  const matched = directContextId
    ? null
    : findContextByReference(
      Array.isArray(knownContexts) ? knownContexts : getContexts(),
      legacyReference,
      organizationId
    );
  return {
    organizationId,
    contextId: directContextId || stringValue(matched && matched.contextId)
  };
}

function withLegacySelectionAlias(selection) {
  const canonical = normalizeSelection(selection);
  const context = findContextByReference(
    getContexts(),
    canonical.contextId,
    canonical.organizationId
  ) || {};
  return Object.assign({}, canonical, {
    // 仅供尚未迁移的组织选择页读取；不会写入 authSelection 或 activeIdentityId。
    identityId: stringValue(context.authIdentityId)
  });
}

function findContextByReference(contexts, reference, organizationId) {
  const ref = stringValue(reference);
  const orgId = stringValue(organizationId);
  if (!ref) return null;
  return (contexts || []).find(function(item) {
    if (!item) return false;
    if (orgId && stringValue(item.organizationId) !== orgId) return false;
    return stringValue(item.contextId) === ref
      || stringValue(item.authIdentityId) === ref;
  }) || null;
}

function normalizeWorkContexts(values, contexts) {
  const source = Array.isArray(values) ? values : [];
  return source.map(function(item) {
    const row = item || {};
    const matched = findContextByReference(
      contexts,
      row.contextId || row.identityId,
      row.organizationId
    ) || {};
    const contextId = stringValue(row.contextId || matched.contextId);
    return {
      contextId,
      organizationId: stringValue(row.organizationId || matched.organizationId),
      organizationName: stringValue(row.organizationName || matched.organizationName),
      role: stringValue(row.role || matched.role),
      adminLevel: stringValue(row.adminLevel || matched.adminLevel),
      type: stringValue(row.type || row.identityType || matched.identityType),
      scope: stringValue(row.scope || row.identityScope || matched.identityScope),
      name: stringValue(row.assignmentLabel || row.workContextName || row.label || row.name || matched.assignmentLabel || matched.identityName),
      detail: stringValue(row.detail || matched.detail),
      assignmentId: stringValue(row.assignmentId || matched.assignmentId),
      assignmentNature: stringValue(row.assignmentNature || row.assignmentKind || matched.assignmentNature || matched.assignmentKind),
      assignmentLabel: stringValue(row.assignmentLabel || matched.assignmentLabel || buildAssignmentLabel(matched)),
      identityCategoryId: stringValue(row.identityCategoryId || matched.identityCategoryId || matched.identityId),
      identityCategoryName: stringValue(row.identityCategoryName || matched.identityCategoryName || matched.identity),
      departmentId: stringValue(row.departmentId || matched.departmentId),
      department: stringValue(row.department || matched.department),
      workGroupId: stringValue(row.workGroupId || matched.workGroupId),
      workGroup: stringValue(row.workGroup || matched.workGroup),
      isCurrent: Boolean(row.isCurrent || matched.isCurrent),
      legacyIdentityId: stringValue(row.identityId || matched.authIdentityId)
    };
  }).filter(function(item) { return item.contextId; });
}

function saveContexts(contexts) {
  const list = Array.isArray(contexts) ? contexts : [];
  if (runtimeAuthenticatedState) runtimeAuthenticatedState.contexts = list;
  return list;
}

function persistCatalogLater(entries) {
  const generation = ++catalogPersistenceGeneration;
  setTimeout(function() {
    if (generation !== catalogPersistenceGeneration) return;
    entries.forEach(function(entry) {
      try {
        if (typeof wx.setStorage === 'function') {
          wx.setStorage({ key: entry[0], data: entry[1] });
        } else {
          wx.setStorageSync(entry[0], entry[1]);
        }
      } catch (_) {}
    });
  }, 0);
}

function getContexts() {
  const runtime = getAuthenticatedState();
  if (runtime) return runtime.contexts || [];
  const list = wx.getStorageSync(CONTEXTS_KEY);
  return Array.isArray(list) ? list : [];
}

function saveCatalog(result) {
  const source = result || {};
  const contextValues = Array.isArray(source.contexts)
    ? source.contexts
    : (Array.isArray(source.workContexts) ? source.workContexts : getContexts());
  const contexts = saveContexts(contextValues);
  const organizations = Array.isArray(source.organizations) && source.organizations.length
    ? source.organizations
    : organizationsFromContexts(contexts);
  const legacyIdentities = Array.isArray(source.identities) ? source.identities : [];
  const workContextValues = Array.isArray(source.workContexts) && source.workContexts.length
    ? source.workContexts
    : (legacyIdentities.length ? legacyIdentities : contexts);
  const workContexts = normalizeWorkContexts(workContextValues, contexts);
  const selection = normalizeSelection(source.selection, source.context);
  const runtime = getAuthenticatedState();
  if (runtime) {
    runtimeAuthenticatedState = Object.assign({}, runtime, {
      contexts,
      organizations,
      workContexts,
      identities: legacyIdentities,
      selection
    });
    if (typeof orgSession.updateAuthenticatedState === 'function') {
      orgSession.updateAuthenticatedState(compactAuthenticatedState(runtimeAuthenticatedState));
    }
  }
  const userOrganizations = organizations.filter(function(item) {
    return !item.roles || item.roles.indexOf('user') >= 0;
  });
  const adminOrganizations = organizations.filter(function(item) {
    return !item.roles || item.roles.indexOf('admin') >= 0;
  });
  persistCatalogLater([
    [CONTEXTS_KEY, contexts],
    [ORGANIZATIONS_KEY, organizations],
    [WORK_CONTEXTS_KEY, workContexts],
    [IDENTITIES_KEY, legacyIdentities],
    [SELECTION_KEY, selection],
    ['availableOrgs', organizations],
    ['availableOrgs:user', userOrganizations],
    ['availableOrgs:admin', adminOrganizations]
  ]);
  return {
    contexts,
    organizations,
    workContexts,
    identities: legacyIdentities.length ? legacyIdentities : getIdentities(),
    selection: withLegacySelectionAlias(selection)
  };
}

function getOrganizations() {
  const runtime = getAuthenticatedState();
  if (runtime) return runtime.organizations || [];
  const values = wx.getStorageSync(ORGANIZATIONS_KEY);
  return Array.isArray(values) ? values : organizationsFromContexts(getContexts());
}

function getIdentities() {
  const runtime = getAuthenticatedState();
  if (runtime) return runtime.identities || [];
  const values = wx.getStorageSync(IDENTITIES_KEY);
  if (Array.isArray(values) && values.length) return values;
  return getWorkContexts().map(function(item) {
    return {
      identityId: item.legacyIdentityId || item.contextId,
      contextId: item.contextId,
      organizationId: item.organizationId,
      name: item.name,
      detail: item.detail,
      role: item.role,
      type: item.type,
      scope: item.scope,
      isCurrent: item.isCurrent
    };
  });
}

function getWorkContexts() {
  const runtime = getAuthenticatedState();
  if (runtime) return runtime.workContexts || [];
  const values = wx.getStorageSync(WORK_CONTEXTS_KEY);
  if (Array.isArray(values)) return values;
  const legacyValues = wx.getStorageSync(IDENTITIES_KEY);
  return normalizeWorkContexts(Array.isArray(legacyValues) ? legacyValues : [], getContexts());
}

function getActiveWorkContext() {
  const snapshot = orgSession.getSnapshot();
  if (!snapshot.contextId) return null;
  const matchesSnapshot = function(item) {
    if (!item || stringValue(item.contextId) !== snapshot.contextId) return false;
    if (snapshot.orgId && stringValue(item.organizationId) !== snapshot.orgId) return false;
    if (snapshot.role && stringValue(item.role) !== snapshot.role) return false;
    return true;
  };
  const context = getContexts().find(matchesSnapshot);
  if (context) return context;
  return getWorkContexts().find(matchesSnapshot) || null;
}

function hasActiveUserAssignment() {
  const snapshot = orgSession.getSnapshot();
  if (snapshot.role !== 'user') return false;
  const context = getActiveWorkContext();
  return Boolean(stringValue(context && context.assignmentId));
}

function getSelection() {
  const runtime = getAuthenticatedState();
  if (runtime) return withLegacySelectionAlias(runtime.selection);
  const value = wx.getStorageSync(SELECTION_KEY);
  if (value && typeof value === 'object') return withLegacySelectionAlias(value);
  const snapshot = orgSession.getSnapshot();
  return withLegacySelectionAlias({
    organizationId: snapshot.orgId,
    contextId: snapshot.contextId
  });
}

function resolveContextId(reference, organizationId) {
  const direct = reference && typeof reference === 'object'
    ? stringValue(reference.contextId)
    : stringValue(reference);
  if (!direct) return '';
  const orgId = stringValue(
    organizationId
    || (reference && typeof reference === 'object' ? reference.organizationId : '')
  );
  const context = findContextByReference(getContexts(), direct, orgId);
  if (context) return stringValue(context.contextId);
  const workContext = getWorkContexts().find(function(item) {
    if (orgId && item.organizationId !== orgId) return false;
    return item.contextId === direct || item.legacyIdentityId === direct;
  });
  return workContext ? workContext.contextId : '';
}

function organizationsFromContexts(contexts) {
  const map = {};
  (contexts || []).forEach(function(context) {
    const orgId = context.organizationId || '';
    if (!orgId) return;
    if (!map[orgId]) {
      map[orgId] = {
        id: orgId,
        name: context.organizationName || '',
        roles: [],
        contextIds: []
      };
    }
    if (map[orgId].roles.indexOf(context.role) < 0) map[orgId].roles.push(context.role);
    map[orgId].contextIds.push(context.contextId);
  });
  return Object.keys(map).map(function(key) { return map[key]; });
}

function saveOrganizationsFromContexts(contexts) {
  const organizations = organizationsFromContexts(contexts);
  wx.setStorageSync('availableOrgs', organizations);
  wx.setStorageSync('availableOrgs:user', organizations.filter(function(item) {
    return !item.roles || item.roles.indexOf('user') >= 0;
  }));
  wx.setStorageSync('availableOrgs:admin', organizations.filter(function(item) {
    return !item.roles || item.roles.indexOf('admin') >= 0;
  }));
  return organizations;
}

function buildAuthenticatedState(result) {
  const source = result || {};
  const context = source.context || null;
  if (!context || !source.token) throw new Error(localeCopy.relogin);
  const contexts = Array.isArray(source.contexts)
    ? source.contexts
    : (Array.isArray(source.workContexts) ? source.workContexts : []);
  const organizations = Array.isArray(source.organizations) && source.organizations.length
    ? source.organizations
    : organizationsFromContexts(contexts);
  const identities = Array.isArray(source.identities) ? source.identities : [];
  const workContextValues = Array.isArray(source.workContexts) && source.workContexts.length
    ? source.workContexts
    : (identities.length ? identities : contexts);
  const workContexts = normalizeWorkContexts(workContextValues, contexts);
  const selection = normalizeSelection(source.selection, context, contexts);
  const profile = normalizeProfile(Object.assign({}, source.account || {}, context, source.user || {}));
  const availableOrganizations = Array.isArray(source.availableOrgs) && source.availableOrgs.length
    ? source.availableOrgs
    : organizations;
  return {
    result: source,
    context,
    contexts,
    organizations,
    identities,
    workContexts,
    selection,
    profile,
    availableOrganizations
  };
}

function compactAuthenticatedState(state) {
  return {
    context: state.context,
    contexts: state.contexts,
    organizations: state.organizations,
    identities: state.identities,
    workContexts: state.workContexts,
    selection: state.selection,
    profile: state.profile,
    availableOrganizations: state.availableOrganizations
  };
}

function buildActivatedState(result) {
  const previous = getAuthenticatedState() || {};
  const previousResult = previous.result && typeof previous.result === 'object'
    ? previous.result
    : {};
  const source = Object.assign({}, previousResult, result || {}, {
    account: (result && result.account) || previousResult.account || {},
    availableOrgs: (result && result.availableOrgs)
      || (result && result.organizations)
      || previous.availableOrganizations
      || previousResult.availableOrgs
      || []
  });
  return buildAuthenticatedState(source);
}

function persistAuthenticatedStateLater(state) {
  const generation = ++persistenceGeneration;
  const roleProfiles = {};
  roleProfiles[state.context.role] = state.profile;
  const userOrganizations = state.availableOrganizations.filter(function(item) {
    return !item.roles || item.roles.indexOf('user') >= 0;
  });
  const adminOrganizations = state.availableOrganizations.filter(function(item) {
    return !item.roles || item.roles.indexOf('admin') >= 0;
  });
  const writes = [
    [CONTEXTS_KEY, state.contexts],
    [WORK_CONTEXTS_KEY, state.workContexts],
    [ORGANIZATIONS_KEY, state.organizations],
    [IDENTITIES_KEY, state.identities],
    [SELECTION_KEY, state.selection],
    [ACCOUNT_KEY, state.result.account || {}],
    [PROFILE_KEY, roleProfiles],
    ['availableOrgs', state.availableOrganizations],
    ['availableOrgs:user', userOrganizations],
    ['availableOrgs:admin', adminOrganizations],
    ['lastOrganizationId', state.selection.organizationId || state.context.organizationId || ''],
    ['lastContextId', state.selection.contextId || state.context.contextId || ''],
    ['token', state.result.token],
    ['activeRole', state.context.role || ''],
    ['activeContextId', state.context.contextId || state.selection.contextId || ''],
    ['activeOrgId', state.context.organizationId || state.selection.organizationId || ''],
    ['activeOrgName', state.context.organizationName || ''],
    ['lastIdentityId', ''],
    ['activeIdentityId', '']
  ];
  // 门户已经拿到内存及紧凑会话后，再一次性发出兼容旧页面的后台写入。
  // 不等待旧版鸿蒙可能丢失的完成回调；退出或再次登录后旧任务立即失效。
  setTimeout(function() {
    if (generation !== persistenceGeneration) return;
    writes.forEach(function(entry) {
      try {
        if (typeof wx.setStorage === 'function') {
          wx.setStorage({ key: entry[0], data: entry[1] });
        } else {
          wx.setStorageSync(entry[0], entry[1]);
        }
      } catch (_) {}
    });
  }, 800);
}

function getRuntimeProfile(role) {
  const runtime = getAuthenticatedState();
  if (!runtime) return null;
  if (role && String((runtime.context && runtime.context.role) || '') !== String(role)) return null;
  return runtime.profile || null;
}

function updateRuntimeProfile(role, profile) {
  const runtime = getAuthenticatedState();
  if (!runtime || !profile) return profile || null;
  if (role && String((runtime.context && runtime.context.role) || '') !== String(role)) return profile;
  runtime.profile = normalizeProfile(profile);
  runtimeAuthenticatedState = runtime;
  if (typeof orgSession.updateAuthenticatedState === 'function') {
    orgSession.updateAuthenticatedState(compactAuthenticatedState(runtime));
  }
  return runtime.profile;
}

function applyAuthenticatedResult(result) {
  const state = buildAuthenticatedState(result);
  runtimeAuthenticatedState = state;
  const committed = orgSession.commitFastContext({
    token: state.result.token,
    contextId: state.context.contextId || state.selection.contextId || state.context.id || '',
    role: state.context.role,
    orgId: state.context.organizationId || state.selection.organizationId,
    orgName: state.context.organizationName,
    authState: compactAuthenticatedState(state)
  });
  markAuthenticationReady();
  persistAuthenticatedStateLater(state);
  return committed;
}

function applyAuthenticatedResultAsync(result) {
  // 登录临界路径先建立 AppService 内存会话并立即进入门户；持久化由
  // commitFastContext 和 persistAuthenticatedStateLater 异步投递且不等待回调。
  return Promise.resolve().then(function() {
    return applyAuthenticatedResult(result);
  });
}

async function refreshCatalog() {
  const expectedSnapshot = orgSession.getSnapshot();
  const result = await callFunction({ name: 'auth/contexts', data: {} });
  if (!result || result.status !== 'success') {
    const error = new Error((result && result.message) || localeCopy.reopenWorkContext);
    error.status = result && result.status;
    throw error;
  }
  if (!orgSession.isCurrent(expectedSnapshot)
    || (result.currentContextId && stringValue(result.currentContextId) !== expectedSnapshot.contextId)) {
    const staleError = new Error(localeCopy.reopenWorkContext);
    staleError.status = 'stale_context';
    throw staleError;
  }
  if (result.context && result.user && expectedSnapshot.token) {
    // 分包可能各自持有一份模块内存。切换完成后，旧分包的延迟写入可能留下
    // “外层 contextId 已更新、内层 profile 仍属于上一角色”的紧凑快照。
    // 目录接口已经由服务端按当前会话解析，因而每次刷新都必须用它重建
    // 当前角色资料，不能只在本地资料完全缺失时才恢复。
    const previous = getAuthenticatedState() || {};
    const previousResult = previous.result && typeof previous.result === 'object'
      ? previous.result
      : {};
    const hydrated = buildAuthenticatedState(Object.assign({}, previousResult, result, {
      token: expectedSnapshot.token,
      account: previousResult.account || {},
      availableOrgs: result.organizations || previous.availableOrganizations || []
    }));
    runtimeAuthenticatedState = hydrated;
    if (typeof orgSession.updateAuthenticatedState === 'function') {
      orgSession.updateAuthenticatedState(compactAuthenticatedState(hydrated));
    }
  }
  return saveCatalog(result);
}

async function refreshContexts() {
  const catalog = await refreshCatalog();
  return catalog.contexts;
}

function applyActivatedResult(result) {
  const before = orgSession.getSnapshot();
  const state = buildActivatedState(result);
  const context = state.context;
  const selection = state.selection;
  const profile = state.profile;
  runtimeAuthenticatedState = state;
  const committed = orgSession.commitFastContext({
    token: state.result.token,
    contextId: context.contextId || selection.contextId || context.id || '',
    role: context.role,
    orgId: context.organizationId || selection.organizationId,
    orgName: context.organizationName,
    authState: compactAuthenticatedState(state)
  });
  // 切换必须产生新的持久化代次，使登录或上一次切换遗留的延迟任务失效。
  // 页面立即读取上面的完整内存状态，兼容旧页面的分散键随后后台落盘。
  persistAuthenticatedStateLater(state);
  const payload = {
    organizationId: context.organizationId,
    organizationName: context.organizationName,
    contextId: selection.contextId,
    workContext: context,
    context: context,
    user: profile,
    version: committed.version
  };
  eventBus.emit('auth:selectionChanged', payload);
  eventBus.emit('auth:contextChanged', {
    context: context,
    user: profile,
    version: committed.version
  });
  if (before.orgId !== context.organizationId) {
    eventBus.emit('org:changed', {
      orgId: context.organizationId,
      orgName: context.organizationName,
      role: context.role,
      contextId: context.contextId,
      orgVersion: committed.version,
      user: profile
    });
  }
  return { context: context, user: profile, version: committed.version, selection };
}

async function activateContext(contextId) {
  beginContextActivation();
  try {
    const result = await callFunction({
      name: 'auth/contexts/activate',
      data: { contextId: contextId }
    });
    if (!result || result.status !== 'success' || !result.context) {
      const error = new Error((result && result.message) || localeCopy.switchFailed);
      error.status = result && result.status;
      throw error;
    }
    return applyActivatedResult(result);
  } finally {
    endContextActivation();
  }
}

async function activateSelection(organizationId, contextReference) {
  const contextId = resolveContextId(contextReference, organizationId);
  if (contextId) return activateContext(contextId);
  beginContextActivation();
  try {
    const result = await callFunction({
      name: 'auth/contexts/activate',
      data: {
        organizationId: organizationId,
        identityId: contextReference
      }
    });
    if (!result || result.status !== 'success' || !result.context) {
      const error = new Error((result && result.message) || localeCopy.switchFailed);
      error.status = result && result.status;
      throw error;
    }
    return applyActivatedResult(result);
  } finally {
    endContextActivation();
  }
}

async function activateOrganizationContext(organizationId, preferredRole) {
  let contexts = getContexts();
  if (!contexts.length) contexts = await refreshContexts();
  const target = contexts.find(function(item) {
    return item.organizationId === organizationId && item.role === preferredRole;
  }) || contexts.find(function(item) {
    return item.organizationId === organizationId;
  });
  if (!target) {
    const error = new Error(localeCopy.selectAccessibleOrganization);
    error.status = 'org_access_denied';
    throw error;
  }
  return activateContext(target.contextId);
}

function clearUnifiedAuthentication() {
  persistenceGeneration += 1;
  catalogPersistenceGeneration += 1;
  runtimeAuthenticatedState = null;
  wx.removeStorageSync(CONTEXTS_KEY);
  wx.removeStorageSync(WORK_CONTEXTS_KEY);
  wx.removeStorageSync(ORGANIZATIONS_KEY);
  wx.removeStorageSync(IDENTITIES_KEY);
  wx.removeStorageSync(SELECTION_KEY);
  wx.removeStorageSync(ACCOUNT_KEY);
  wx.removeStorageSync(PROFILE_KEY);
  wx.removeStorageSync('authSelectionNotice');
  wx.removeStorageSync('availableOrgs');
  wx.removeStorageSync('availableOrgs:user');
  wx.removeStorageSync('availableOrgs:admin');
  orgSession.clearAuthentication('');
}

module.exports = {
  normalizeProfile,
  getRuntimeProfile,
  updateRuntimeProfile,
  saveCatalog,
  saveContexts,
  getContexts,
  getOrganizations,
  getWorkContexts,
  getActiveWorkContext,
  hasActiveUserAssignment,
  getIdentities,
  getSelection,
  resolveContextId,
  organizationsFromContexts,
  applyAuthenticatedResult,
  applyAuthenticatedResultAsync,
  refreshCatalog,
  refreshContexts,
  activateContext,
  activateSelection,
  activateOrganizationContext,
  clearUnifiedAuthentication
};
