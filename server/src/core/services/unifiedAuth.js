const localeCopy = require('../../locales/zh-CN/generated/core/services/unifiedAuth');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../middleware/auth');
const { safeString } = require('../../utils/helpers');
const identityModel = require('../models/unifiedIdentity');
const { adminProfileFromContext } = require('./adminRequestContext');
const { loadEffectivePermissions } = require('./adminPermissions');

const WECHAT_APPID = process.env.WECHAT_APPID;
const WECHAT_SECRET = process.env.WECHAT_SECRET;
if (!WECHAT_APPID || !WECHAT_SECRET) {
  throw new Error('WECHAT_APPID and WECHAT_SECRET environment variables are required');
}

const ALLOW_DEV_OPENID_LOGIN = process.env.NODE_ENV !== 'production'
  && process.env.ENABLE_DEV_OPENID_LOGIN === '1';
const ACCESS_AUDIENCE = 'whusu-smart-workspace-api';
const BOOTSTRAP_AUDIENCE = 'whusu-smart-workspace-bootstrap';

async function exchangeWechatCode(code, devOpenid) {
  if (ALLOW_DEV_OPENID_LOGIN && safeString(devOpenid)) return safeString(devOpenid);
  const jsCode = safeString(code);
  if (!jsCode) throw new identityModel.IdentityError('invalid_wechat_code', localeCopy.copy_b10d64a68c, 401);
  let response;
  try {
    response = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: WECHAT_APPID,
        secret: WECHAT_SECRET,
        js_code: jsCode,
        grant_type: 'authorization_code'
      },
      timeout: 5000
    });
  } catch (_) {
    throw new identityModel.IdentityError('wechat_unavailable', localeCopy.copy_4466c2266e, 503);
  }
  const openid = safeString(response && response.data && response.data.openid);
  if (!openid) throw new identityModel.IdentityError('invalid_wechat_code', localeCopy.copy_b10d64a68c, 401);
  return openid;
}

function signAccessToken(session, account) {
  const contextId = safeString(
    session && session.context && session.context.contextId
      ? session.context.contextId
      : session && session.context_id
  );
  return jwt.sign({
    kind: 'unified_access',
    sid: session.id,
    accountId: account.id,
    tokenVersion: Number(session.tokenVersion || account.token_version || 1),
    contextId
  }, JWT_SECRET, {
    expiresIn: identityModel.SESSION_MINUTES * 60,
    audience: ACCESS_AUDIENCE,
    issuer: 'whusu-smart-workspace'
  });
}

function signBootstrapToken(bootstrap) {
  return jwt.sign({
    kind: 'unified_bootstrap',
    bid: bootstrap.id
  }, JWT_SECRET, {
    expiresIn: bootstrap.expiresInSeconds,
    audience: BOOTSTRAP_AUDIENCE,
    issuer: 'whusu-smart-workspace'
  });
}

function verifyBootstrapToken(token) {
  try {
    const decoded = jwt.verify(safeString(token), JWT_SECRET, {
      audience: BOOTSTRAP_AUDIENCE,
      issuer: 'whusu-smart-workspace'
    });
    return decoded && decoded.kind === 'unified_bootstrap' ? safeString(decoded.bid) : '';
  } catch (_) {
    return '';
  }
}

async function decorateContext(context) {
  const value = Object.assign({}, context);
  if (value.role !== 'admin') return value;
  const admin = adminProfileFromContext(value);
  if (!admin) {
    value.permissions = [];
    return value;
  }
  const effective = await loadEffectivePermissions(admin, value.organizationId);
  value.permissions = effective.isSuper ? ['*'] : effective.keys;
  return value;
}

async function decorateContexts(contexts) {
  const values = [];
  for (const context of contexts) values.push(await decorateContext(context));
  return values;
}

function buildAvailableOrganizations(contexts, currentContext) {
  const map = new Map();
  contexts.forEach((context) => {
    if (!context.organizationId) return;
    const current = map.get(context.organizationId) || {
      id: context.organizationId,
      name: context.organizationName,
      roles: [],
      contextIds: []
    };
    if (!current.roles.includes(context.role)) current.roles.push(context.role);
    current.contextIds.push(context.contextId);
    map.set(context.organizationId, current);
  });
  return Array.from(map.values()).map((item) => Object.assign(item, {
    isCurrent: Boolean(currentContext && item.id === currentContext.organizationId)
  }));
}

function buildContextCatalog(contexts, currentContext) {
  const organizations = buildAvailableOrganizations(contexts, currentContext);
  const identityMap = new Map();
  const workContexts = [];
  contexts.forEach((context) => {
    const isGlobal = context.identityScope === 'global';
    workContexts.push({
      contextId: safeString(context.contextId),
      type: safeString(context.identityType),
      label: safeString(context.assignmentLabel || context.identityName),
      scope: isGlobal ? 'global' : 'organization',
      // 全局表示授权范围，不表示当前工作组织为空。超级管理员仍按目标组织
      // 拥有独立上下文，前端才能把角色稳定归入所选组织。
      organizationId: safeString(context.organizationId),
      organizationName: safeString(context.organizationName),
      role: safeString(context.role),
      adminLevel: safeString(context.adminLevel),
      assignmentId: safeString(context.assignmentId),
      assignmentNature: safeString(context.assignmentNature),
      assignmentLabel: safeString(context.assignmentLabel),
      identityCategoryId: safeString(context.identityCategoryId || context.identityId),
      identityCategoryName: safeString(context.identityCategoryName || context.identity),
      departmentId: safeString(context.departmentId),
      department: safeString(context.department),
      workGroupId: safeString(context.workGroupId),
      workGroup: safeString(context.workGroup),
      isCurrent: Boolean(currentContext && currentContext.contextId === context.contextId)
    });
    const identityId = safeString(context.authIdentityId);
    if (!identityId || identityMap.has(identityId)) return;
    identityMap.set(identityId, {
      identityId,
      type: context.identityType,
      name: context.identityName,
      scope: isGlobal ? 'global' : 'organization',
      organizationId: isGlobal ? null : context.organizationId,
      role: context.role,
      adminLevel: safeString(context.adminLevel),
      isCurrent: Boolean(
        currentContext
        && currentContext.authIdentityId === identityId
      ),
      detail: context.role === 'admin'
        ? (isGlobal ? '可管理全部组织' : '管理当前组织')
        : [context.department, context.identity, context.workGroup].filter(Boolean).join(' · ')
    });
  });
  return {
    selection: currentContext ? {
      organizationId: currentContext.organizationId,
      contextId: currentContext.contextId,
      assignmentId: safeString(currentContext.assignmentId),
      identityCategoryId: safeString(currentContext.identityCategoryId || currentContext.identityId),
      identityId: currentContext.authIdentityId
    } : null,
    organizations,
    workContexts,
    identities: Array.from(identityMap.values())
  };
}

function profileFromContext(context) {
  if (!context) return null;
  if (context.role === 'admin') {
    return {
      id: context.legacyAdminId || context.adminGrantId,
      adminGrantId: context.adminGrantId,
      personId: context.personId,
      name: context.name,
      studentId: context.studentId,
      adminLevel: context.adminLevel,
      identity: context.identityName,
      permissions: context.permissions || []
    };
  }
  return {
    id: context.legacyHrId,
    hrId: context.legacyHrId,
    personId: context.personId,
    membershipId: context.membershipId,
    assignmentId: context.assignmentId,
    assignmentNature: safeString(context.assignmentNature),
    assignmentLabel: safeString(context.assignmentLabel),
    name: context.name,
    studentId: context.studentId,
    departmentId: context.departmentId,
    department: context.department,
    identityId: context.identityId,
    identity: context.identity,
    identityCategoryId: safeString(context.identityCategoryId || context.identityId),
    identityCategoryName: safeString(context.identityCategoryName || context.identity),
    workGroupId: context.workGroupId,
    workGroup: context.workGroup,
    assignmentName: context.assignmentLabel || context.identityName,
    hasAssignment: Boolean(context.assignmentId)
  };
}

async function buildAuthenticatedPayload(account, session) {
  const rawContexts = await identityModel.listContexts(account.id);
  const contexts = await decorateContexts(rawContexts);
  const currentContext = contexts.find((item) => item.contextId === session.context.contextId)
    || await decorateContext(session.context);
  const catalog = buildContextCatalog(contexts, currentContext);
  return {
    status: 'login_success',
    token: signAccessToken(session, account),
    expiresIn: session.expiresInSeconds,
    device: {
      recognized: Boolean(session.deviceRecognized),
      current: true
    },
    account: {
      id: account.id,
      personId: account.person_id,
      name: safeString(account.name),
      studentId: safeString(account.student_id),
      status: safeString(account.status)
    },
    context: currentContext,
    contexts,
    workContexts: catalog.workContexts,
    selection: catalog.selection,
    organizations: catalog.organizations,
    identities: catalog.identities,
    // 保留旧客户端响应字段；偏好回退不代表人事资料发生变更。
    selectionNotice: '',
    user: profileFromContext(currentContext),
    activeRole: currentContext.role,
    activeOrg: {
      id: currentContext.organizationId,
      name: currentContext.organizationName
    },
    availableOrgs: catalog.organizations
  };
}

async function createAuthenticatedSession(account, requestedSelection, metadata, options) {
  const session = await identityModel.createSession(account, requestedSelection, metadata, options);
  return buildAuthenticatedPayload(account, session);
}

async function startWechatSession(data, metadata) {
  const openid = await exchangeWechatCode(data.code, data.openid || data.deviceOpenid);
  const account = await identityModel.findAccountByOpenid(openid);
  if (account && account.status === 'frozen') {
    throw new identityModel.IdentityError('account_frozen', localeCopy.copy_d6a178f6ce, 403);
  }
  if (account) {
    return createAuthenticatedSession(account, {
      contextId: data.preferredContextId || data.contextId,
      organizationId: data.preferredOrganizationId || data.organizationId,
      identityId: data.preferredIdentityId || data.identityId
    }, metadata);
  }
  const bootstrap = await identityModel.createBootstrapSession(openid);
  const [policy, organizations] = await Promise.all([
    identityModel.getPolicy(),
    identityModel.listClaimOrganizations()
  ]);
  return {
    status: 'need_claim',
    bootstrapToken: signBootstrapToken(bootstrap),
    claimAvailable: Boolean(policy && policy.initial_claim_enabled),
    recoveryAvailable: true,
    recoveryMethods: {
      recoveryCode: Boolean(policy && policy.allow_recovery_code),
      passphrase: Boolean(policy && policy.allow_passphrase)
    },
    organizations,
    message: localeCopy.copy_961dde1e9f
  };
}

function bootstrapIdFromRequest(req) {
  const authHeader = safeString(req.headers.authorization);
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const bootstrapId = verifyBootstrapToken(token);
  if (!bootstrapId) throw new identityModel.IdentityError('bootstrap_expired', localeCopy.copy_ffadbecb8f, 401);
  return bootstrapId;
}

module.exports = {
  ACCESS_AUDIENCE,
  BOOTSTRAP_AUDIENCE,
  exchangeWechatCode,
  signAccessToken,
  signBootstrapToken,
  verifyBootstrapToken,
  decorateContext,
  decorateContexts,
  profileFromContext,
  buildAvailableOrganizations,
  buildContextCatalog,
  buildAuthenticatedPayload,
  createAuthenticatedSession,
  startWechatSession,
  bootstrapIdFromRequest
};
