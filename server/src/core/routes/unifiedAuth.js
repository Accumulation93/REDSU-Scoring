const localeCopy = require('../../locales/zh-CN/generated/core/routes/unifiedAuth');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const express = require('express');
const { safeString } = require('../../utils/helpers');
const pool = require('../../config/db');
const identityModel = require('../models/unifiedIdentity');
const systemConfigModel = require('../models/systemConfig');
const unifiedAuth = require('../services/unifiedAuth');
const {
  scopeAccountSessions
} = require('../services/adminPermissions');

const router = express.Router();

async function withSystemTimezone(payload) {
  const config = await systemConfigModel.get();
  return Object.assign({}, payload, {
    systemTimezoneOffset: config ? config.timezone : 8,
    timezoneConfigVersion: config ? String(config.timezone_config_version || 1) : '1'
  });
}

function metadata(req) {
  return {
    requestId: safeString(req.requestId),
    ip: safeString(req.ip)
  };
}

function sendError(req, res, error) {
  if (error instanceof identityModel.IdentityError) {
    return res.status(error.httpStatus).json({
      status: error.code,
      message: error.message
    });
  }
  req.logger.error('Unified authentication operation failed', {
    error: error.message,
    path: req.path
  });
  return res.status(500).json({ status: 'error', message: localeCopy.copy_047d735538 });
}

function requireUnifiedSession(req) {
  if (!req.authSession || !req.authAccount || !req.authContext) {
    throw new identityModel.IdentityError('client_upgrade_required', localeCopy.copy_cffa8244af, 426);
  }
}

async function requireAdminPermission(req, permissionKey) {
  requireUnifiedSession(req);
  if (req.authContext.role !== 'admin') {
    throw new identityModel.IdentityError('admin_role_required', localeCopy.copy_278fb8d3d0, 403);
  }
  const context = await unifiedAuth.decorateContext(req.authContext);
  const permissions = context.permissions || [];
  if (!permissions.includes('*') && !permissions.includes(permissionKey)) {
    throw new identityModel.IdentityError('permission_denied', localeCopy.copy_79c2622548, 403);
  }
  return context;
}

function mapSecuritySession(item) {
  return {
    id: safeString(item.id),
    contextId: safeString(item.context_id),
    organizationId: safeString(item.organization_id),
    organizationName: safeString(item.organization_name),
    role: safeString(item.role),
    deviceLabel: item.device_model || item.device_platform || localeCopy.copy_6378c3f013,
    platform: safeString(item.device_platform),
    model: safeString(item.device_model),
    recognized: Boolean(item.device_key_hash),
    currentDevice: false,
    lastSeenAt: item.last_seen_at || null
  };
}

async function resolveMemberAccount(req, personId) {
  const account = await identityModel.getAccountByPersonInOrg(
    safeString(personId),
    req.authContext.organizationId
  );
  if (!account) {
    throw new identityModel.IdentityError('member_account_not_found', localeCopy.copy_3b60b7e276, 404);
  }
  return account;
}

function claimPolicyOpen(policy) {
  if (!policy || !policy.initial_claim_enabled) return false;
  const now = Date.now();
  if (policy.claim_starts_at && new Date(policy.claim_starts_at).getTime() > now) return false;
  if (policy.claim_ends_at && new Date(policy.claim_ends_at).getTime() < now) return false;
  return true;
}

router.post('/auth/wechat/session', async (req, res) => {
  try {
    const result = await unifiedAuth.startWechatSession(req.body || {}, metadata(req));
    return res.json(await withSystemTimezone(result));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/claims', async (req, res) => {
  try {
    const bootstrapId = unifiedAuth.bootstrapIdFromRequest(req);
    const policy = await identityModel.getPolicy();
    if (!claimPolicyOpen(policy)) {
      return res.status(403).json({
        status: 'claim_paused',
        message: localeCopy.copy_2af0dcac0d
      });
    }
    const result = await identityModel.createClaim(bootstrapId, {
      name: req.body && req.body.name,
      studentId: req.body && req.body.studentId,
      organizationId: req.body && req.body.organizationId,
      requestId: req.requestId,
      ip: req.ip
    });
    return res.json({
      status: 'accepted',
      claimId: result.claimId,
      message: localeCopy.copy_93421f1a7c
    });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/claims/verify', async (req, res) => {
  try {
    const bootstrapId = unifiedAuth.bootstrapIdFromRequest(req);
    const account = await identityModel.verifyClaim(
      bootstrapId,
      req.body && req.body.claimId,
      req.body && req.body.verificationCode,
      metadata(req)
    );
    const result = await unifiedAuth.createAuthenticatedSession(account, '', metadata(req));
    if (account.rotatedRecoveryCode) result.recoveryCode = account.rotatedRecoveryCode;
    return res.json(await withSystemTimezone(result));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/claims/redeem', async (req, res) => {
  try {
    const bootstrapId = unifiedAuth.bootstrapIdFromRequest(req);
    const account = await identityModel.redeemInitialInvite(bootstrapId, {
      name: req.body && req.body.name,
      studentId: req.body && req.body.studentId,
      organizationId: req.body && req.body.organizationId,
      code: req.body && (req.body.code || req.body.verificationCode)
    }, metadata(req));
    return res.json(await withSystemTimezone(
      await unifiedAuth.createAuthenticatedSession(account, '', metadata(req))
    ));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/password/session', async (req, res) => {
  try {
    const account = await identityModel.authenticateWithPassphrase(
      req.body && req.body.studentId,
      req.body && req.body.passphrase
    );
    const hasWechatCode = Boolean(req.body && (req.body.code || req.body.openid));
    let openid = '';
    let currentBound = null;
    // 微信只提供登录后可选的绑定邀请；交换失败不能否定已经验证的口令。
    if (hasWechatCode && !account.openid_hash) {
      try {
        openid = await unifiedAuth.exchangeWechatCode(req.body.code, req.body.openid);
        currentBound = await identityModel.findAccountByOpenid(openid);
      } catch (_) {
        openid = '';
      }
    }
    const temporaryOptions = identityModel.temporaryPasswordSessionOptions(openid);
    await identityModel.appendAuditEvent({ eventType: 'password_session_created', targetPersonId: account.person_id,
      accountId: account.id, requestId: req.requestId, ip: req.ip });
    const payload = await unifiedAuth.createAuthenticatedSession(account, {
      contextId: req.body && req.body.preferredContextId,
      organizationId: req.body && req.body.preferredOrganizationId,
      identityId: req.body && req.body.preferredIdentityId
    }, metadata(req), temporaryOptions);
    if (!account.openid_hash && (openid || req.body && req.body.requestBindingOffer === true)) {
      payload.bindingOffer = {
        available: !currentBound,
        currentWechatBound: Boolean(currentBound),
        requiresWechatCode: !openid,
        accountId: safeString(account.id),
        personId: safeString(account.person_id),
        name: safeString(account.name)
      };
    }
    return res.json(await withSystemTimezone(payload));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/security/bind-current-wechat', async (req, res) => {
  try {
    requireUnifiedSession(req);
    if (req.authSession.binding_mode !== 'temporary') {
      throw new identityModel.IdentityError('invalid_params', localeCopy.copy_cffa8244af, 400);
    }
    if (req.body && req.body.code) {
      const openid = await unifiedAuth.exchangeWechatCode(req.body.code);
      await identityModel.bindWechatAfterPassphraseLogin(req.authAccount.id, openid, metadata(req));
    } else {
      await identityModel.bindTemporaryPasswordSessionOpenid(req.authAccount.id, req.authSession);
    }
    return res.json({ status: 'success' });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.get('/auth/contexts', async (req, res) => {
  try {
    requireUnifiedSession(req);
    const contexts = await unifiedAuth.decorateContexts(
      await identityModel.listContexts(req.authAccount.id)
    );
    const currentContext = contexts.find((item) => item.contextId === req.authContext.contextId)
      || req.authContext;
    const catalog = unifiedAuth.buildContextCatalog(contexts, currentContext);
    return res.json(await withSystemTimezone({
      status: 'success',
      currentContextId: req.authContext.contextId,
      context: currentContext,
      user: unifiedAuth.profileFromContext(currentContext),
      contexts,
      workContexts: catalog.workContexts,
      selection: catalog.selection,
      organizations: catalog.organizations,
      identities: catalog.identities
    }));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/contexts', async (req, res) => {
  try {
    requireUnifiedSession(req);
    const contexts = await unifiedAuth.decorateContexts(
      await identityModel.listContexts(req.authAccount.id)
    );
    const currentContext = contexts.find((item) => item.contextId === req.authContext.contextId)
      || req.authContext;
    const catalog = unifiedAuth.buildContextCatalog(contexts, currentContext);
    return res.json(await withSystemTimezone({
      status: 'success',
      currentContextId: req.authContext.contextId,
      context: currentContext,
      user: unifiedAuth.profileFromContext(currentContext),
      contexts,
      workContexts: catalog.workContexts,
      selection: catalog.selection,
      organizations: catalog.organizations,
      identities: catalog.identities
    }));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/contexts/activate', async (req, res) => {
  try {
    requireUnifiedSession(req);
    const requestedContextId = safeString(req.body && (req.body.contextId || req.body.workContextId));
    const requestedOrganizationId = safeString(req.body && req.body.organizationId);
    const requestedIdentityId = safeString(req.body && req.body.identityId);
    if (!requestedContextId && (!requestedOrganizationId || !requestedIdentityId)) {
      throw new identityModel.IdentityError('invalid_params', personnelCopy.organizationSelectionExpired, 400);
    }
    const previousContext = req.authContext;
    const context = await identityModel.activateSelection(
      req.authSession.id,
      req.authAccount.id,
      {
        contextId: requestedContextId,
        organizationId: requestedOrganizationId,
        identityId: requestedIdentityId
      }
    );
    const decorated = await unifiedAuth.decorateContext(context);
    const contexts = await unifiedAuth.decorateContexts(
      await identityModel.listContexts(req.authAccount.id)
    );
    const catalog = unifiedAuth.buildContextCatalog(contexts, decorated);
    await identityModel.appendAuditEvent({
      eventType: 'auth_context_activated',
      actorPersonId: req.authAccount.personId,
      targetPersonId: req.authAccount.personId,
      accountId: req.authAccount.id,
      organizationId: decorated.organizationId,
      contextId: decorated.contextId,
      requestId: req.requestId,
      ip: req.ip,
      detail: {
        previousOrganizationId: previousContext.organizationId,
        previousIdentityId: previousContext.authIdentityId,
        organizationId: decorated.organizationId,
        identityId: decorated.authIdentityId,
        role: decorated.role,
        identityType: decorated.identityType,
        identityScope: decorated.identityScope
      }
    });
    return res.json(await withSystemTimezone({
      status: 'success',
      token: unifiedAuth.signAccessToken(
        Object.assign({}, req.authSession, { context: decorated }),
        {
          id: req.authAccount.id,
          token_version: req.authAccount.tokenVersion
        }
      ),
      context: decorated,
      contexts,
      workContexts: catalog.workContexts,
      selection: catalog.selection,
      organizations: catalog.organizations,
      identities: catalog.identities,
      user: unifiedAuth.profileFromContext(decorated),
      activeRole: decorated.role,
      activeOrg: { id: decorated.organizationId, name: decorated.organizationName }
    }));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.all('/auth/security', async (req, res) => {
  try {
    requireUnifiedSession(req);
    const [policy, sessions] = await Promise.all([
      identityModel.getPolicy(),
      identityModel.listSessions(req.authAccount.id)
    ]);
    return res.json({
      status: 'success',
      bindingStatus: 'verified',
      account: {
        name: req.authAccount.name,
        studentId: req.authAccount.studentId
      },
      policy: {
        allowRecoveryCode: Boolean(policy && policy.allow_recovery_code),
        allowPassphrase: Boolean(policy && policy.allow_passphrase)
      },
      sessions: sessions.map((item) => ({
        id: safeString(item.id),
        contextId: safeString(item.context_id),
        organizationId: safeString(item.organization_id),
        organizationName: safeString(item.organization_name),
        role: safeString(item.role),
        deviceLabel: item.device_model || item.device_platform || localeCopy.copy_6378c3f013,
        platform: safeString(item.device_platform),
        model: safeString(item.device_model),
        recognized: Boolean(item.device_key_hash),
        currentDevice: Boolean(item.device_key_hash && req.authSession.device_key_hash
          && item.device_key_hash === req.authSession.device_key_hash),
        current: safeString(item.id) === safeString(req.authSession.id),
        createdAt: item.created_at,
        lastSeenAt: item.last_seen_at,
        expiresAt: item.expires_at
      }))
    });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/security/recovery-credential', async (req, res) => {
  try {
    requireUnifiedSession(req);
    const method = safeString(req.body && req.body.method);
    if (!['recovery_code', 'passphrase'].includes(method)) {
      throw new identityModel.IdentityError('invalid_params', localeCopy.copy_6267781771, 400);
    }
    const result = await identityModel.configureRecoveryCredential(
      req.authAccount.id,
      method,
      req.body && req.body.value
    );
    await identityModel.appendAuditEvent({
      eventType: 'recovery_credential_configured',
      actorPersonId: req.authAccount.personId,
      targetPersonId: req.authAccount.personId,
      accountId: req.authAccount.id,
      organizationId: req.authContext.organizationId,
      contextId: req.authContext.contextId,
      requestId: req.requestId,
      ip: req.ip,
      detail: { method }
    });
    return res.json(Object.assign({ status: 'success' }, result));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/security/sessions/revoke', async (req, res) => {
  try {
    requireUnifiedSession(req);
    const revoked = await identityModel.revokeSession(
      req.authAccount.id,
      req.body && req.body.sessionId,
      req.authSession.id
    );
    return res.json({
      status: revoked ? 'success' : 'not_found',
      message: revoked ? localeCopy.copy_c69999ba88 : localeCopy.copy_c69999ba88
    });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/security', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.accounts.global_manage');
    const account = await identityModel.getMemberAccountSubjectByPersonInOrg(
      safeString(req.body && req.body.personId),
      req.authContext.organizationId
    );
    if (!account) {
      throw new identityModel.IdentityError('member_not_found', localeCopy.copy_3b60b7e276, 404);
    }
    const canGlobalManage = true;
    const accountExists = Boolean(account.account_id);
    const sessions = accountExists ? scopeAccountSessions(
      await identityModel.listSessions(account.account_id),
      actor.organizationId,
      canGlobalManage
    ) : [];
    const passphraseSet = canGlobalManage && accountExists
      ? await identityModel.getPassphraseStatus(account.account_id)
      : false;
    return res.json(await withSystemTimezone({
      status: 'success',
      account: { name: account.name, studentId: account.student_id },
      accountExists,
      bindingStatus: accountExists ? safeString(account.account_status) : 'unbound',
      canGlobalManage,
      passphraseSet,
      sessions: sessions.map(mapSecuritySession)
    }));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/security/sessions/revoke', async (req, res) => {
  try {
    await requireAdminPermission(req, 'auth.accounts.global_manage');
    const account = await resolveMemberAccount(req, req.body && req.body.personId);
    const sessionId = safeString(req.body && req.body.sessionId);
    if (!sessionId) {
      throw new identityModel.IdentityError('invalid_params', localeCopy.copy_72b5b8b086, 400);
    }
    const revoked = await pool.withTransaction(async (connection) => {
      const changed = await identityModel.revokeSession(
        account.account_id,
        sessionId,
        req.authSession.id,
        connection
      );
      await identityModel.appendAuditEvent({
        connection,
        eventType: 'admin_session_revoked',
        actorPersonId: req.authAccount.personId,
        targetPersonId: account.person_id,
        accountId: account.account_id,
        organizationId: req.authContext.organizationId,
        contextId: req.authContext.contextId,
        requestId: req.requestId,
        ip: req.ip,
        outcome: changed ? 'success' : 'not_found',
        detail: { sessionId }
      });
      return changed;
    });
    return res.json({ status: revoked ? 'success' : 'not_found', message: localeCopy.copy_c69999ba88 });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/security/passphrase', async (req, res) => {
  try {
    await requireAdminPermission(req, 'auth.accounts.global_manage');
    const result = await pool.withTransaction(async (connection) => {
      const account = await identityModel.ensureAccountForActiveMember(
        safeString(req.body && req.body.personId),
        req.authContext.organizationId,
        connection
      );
      if (!account) {
        throw new identityModel.IdentityError('member_not_found', localeCopy.copy_3b60b7e276, 404);
      }
      await identityModel.configureRecoveryCredential(
        account.account_id,
        'passphrase',
        req.body && req.body.value,
        connection
      );
      await identityModel.appendAuditEvent({
        connection,
        eventType: 'admin_passphrase_configured',
        actorPersonId: req.authAccount.personId,
        targetPersonId: account.person_id,
        accountId: account.account_id,
        organizationId: req.authContext.organizationId,
        contextId: req.authContext.contextId,
        requestId: req.requestId,
        ip: req.ip,
        detail: { method: 'passphrase' }
      });
      return {
        accountId: account.account_id,
        accountInitialized: Boolean(account.accountInitialized)
      };
    });
    return res.json(Object.assign({ status: 'success', passphraseSet: true }, result));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/security/passphrase/revoke', async (req, res) => {
  try {
    await requireAdminPermission(req, 'auth.accounts.global_manage');
    const account = await resolveMemberAccount(req, req.body && req.body.personId);
    const revoked = await pool.withTransaction(async (connection) => {
      const changed = await identityModel.revokeRecoveryCredential(
        account.account_id,
        'passphrase',
        connection
      );
      await identityModel.appendAuditEvent({
        connection,
        eventType: 'admin_passphrase_revoked',
        actorPersonId: req.authAccount.personId,
        targetPersonId: account.person_id,
        accountId: account.account_id,
        organizationId: req.authContext.organizationId,
        contextId: req.authContext.contextId,
        requestId: req.requestId,
        ip: req.ip,
        outcome: changed ? 'success' : 'not_found',
        detail: { method: 'passphrase' }
      });
      return changed;
    });
    return res.json({ status: revoked ? 'success' : 'not_found' });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/recovery/start', async (req, res) => {
  try {
    const bootstrapId = unifiedAuth.bootstrapIdFromRequest(req);
    const result = await identityModel.startRecovery(bootstrapId, {
      name: req.body && req.body.name,
      studentId: req.body && req.body.studentId,
      organizationId: req.body && req.body.organizationId
    }, metadata(req));
    return res.json(await withSystemTimezone({
      status: 'accepted',
      recoveryRequestId: result.recoveryRequestId,
      message: localeCopy.copy_d8ee19964e
    }));
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/auth/recovery/complete', async (req, res) => {
  try {
    const bootstrapId = unifiedAuth.bootstrapIdFromRequest(req);
    const method = safeString(req.body && req.body.method);
    if (!['recovery_code', 'passphrase'].includes(method)) {
      throw new identityModel.IdentityError('invalid_params', localeCopy.copy_6267781771, 400);
    }
    const account = await identityModel.completeRecoveryWithCredential(
      bootstrapId,
      req.body && req.body.recoveryRequestId,
      method,
      req.body && req.body.credential,
      metadata(req)
    );
    const result = await unifiedAuth.createAuthenticatedSession(account, '', metadata(req));
    if (account.rotatedRecoveryCode) result.recoveryCode = account.rotatedRecoveryCode;
    return res.json(result);
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.get('/admin/auth/claims', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.identity.verify');
    const orgId = actor.adminLevel === 'super_admin'
      ? safeString(req.query && req.query.organizationId)
      : actor.organizationId;
    const rows = await identityModel.listClaims(orgId, { limit: req.query && req.query.limit });
    return res.json({ status: 'success', list: rows });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/claims', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.identity.verify');
    const action = safeString(req.body && req.body.action) || 'list';
    if (action === 'list') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const rows = await identityModel.listClaims(orgId, { limit: req.body && req.body.limit });
      return res.json({ status: 'success', list: rows });
    }
    if (action === 'eligible') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const rows = await identityModel.listEligibleInitialInvitePeople(orgId, req.body || {});
      return res.json({ status: 'success', list: rows });
    }
    if (action === 'issue_invites') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const results = await identityModel.issueInitialInvites(req.body && req.body.personIds, orgId, actor, metadata(req));
      return res.json({ status: 'success', issued: results, message: localeCopy.copy_bf3336af0d });
    }
    if (action === 'revoke_invites') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const result = await identityModel.revokeInitialInvites(req.body && req.body.personIds, orgId, actor, metadata(req));
      return res.json({ status: 'success', revoked: result.revoked });
    }
    if (action === 'issue_code') {
      const result = await identityModel.issueVerificationCode(
        req.body && req.body.claimId,
        actor,
        metadata(req)
      );
      return res.json({
        status: 'success',
        verificationCode: result.code,
        expiresInHours: result.expiresInHours,
        message: localeCopy.copy_c4ce58e425
      });
    }
    if (action === 'issue_codes') {
      const claimIds = Array.isArray(req.body && req.body.claimIds)
        ? req.body.claimIds.map(safeString).filter(Boolean).slice(0, 50)
        : [];
      const results = await identityModel.issueVerificationCodes(claimIds, actor, metadata(req));
      const issued = results.map((result) => ({
        claimId: result.claimId,
        verificationCode: result.code,
        expiresInHours: result.expiresInHours
      }));
      return res.json({
        status: 'success',
        issued,
        message: localeCopy.copy_78aaa917be
      });
    }
    if (action === 'revoke_codes') {
      const claimIds = Array.isArray(req.body && req.body.claimIds)
        ? req.body.claimIds.map(safeString).filter(Boolean).slice(0, 50)
        : [];
      const revokedClaimIds = await identityModel.revokeVerificationCodes(
        claimIds,
        actor,
        metadata(req)
      );
      return res.json({ status: 'success', revokedClaimIds });
    }
    throw new identityModel.IdentityError('invalid_action', localeCopy.copy_e6669be1f4, 400);
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.get('/admin/auth/recoveries', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.accounts.recover');
    const orgId = actor.adminLevel === 'super_admin'
      ? safeString(req.query && req.query.organizationId)
      : actor.organizationId;
    const rows = await identityModel.listRecoveryRequests(orgId, { limit: req.query && req.query.limit });
    return res.json({ status: 'success', list: rows });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/recoveries', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.accounts.recover');
    const action = safeString(req.body && req.body.action) || 'list';
    if (action === 'list') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const rows = await identityModel.listRecoveryRequests(orgId, { limit: req.body && req.body.limit });
      return res.json({ status: 'success', list: rows });
    }
    if (action === 'eligible_accounts') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const rows = await identityModel.listEligibleRecoveryAccounts(orgId, req.body || {});
      return res.json({ status: 'success', list: rows.map((row) => ({
        accountId: safeString(row.account_id), personId: safeString(row.person_id), name: safeString(row.name),
        studentId: safeString(row.student_id), accountStatus: safeString(row.status),
        hasActiveBinding: Boolean(row.has_active_binding), hasRecoveryCode: Boolean(row.has_recovery_code)
      })) });
    }
    if (action === 'issue_codes') {
      const globalActor = await requireAdminPermission(req, 'auth.accounts.global_manage');
      const orgId = globalActor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : globalActor.organizationId;
      const results = await identityModel.issueAdminRecoveryCodes(
        req.body && req.body.accountIds,
        orgId,
        globalActor,
        metadata(req)
      );
      return res.json({ status: 'success', issued: results, message: localeCopy.copy_2e445c9710 });
    }
    if (action === 'revoke_codes') {
      const globalActor = await requireAdminPermission(req, 'auth.accounts.global_manage');
      const orgId = globalActor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : globalActor.organizationId;
      const result = await identityModel.revokeAdminRecoveryCodes(
        req.body && req.body.accountIds,
        orgId,
        globalActor,
        metadata(req)
      );
      return res.json({ status: 'success', revoked: result.revoked });
    }
    if (action === 'approve') {
      const globalActor = await requireAdminPermission(req, 'auth.accounts.global_manage');
      await identityModel.approveRecovery(
        req.body && req.body.recoveryRequestId,
        globalActor,
        metadata(req)
      );
      return res.json({ status: 'success', message: localeCopy.copy_cbea0ead4a });
    }
    throw new identityModel.IdentityError('invalid_action', localeCopy.copy_e6669be1f4, 400);
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/accounts', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.accounts.recover');
    const action = safeString(req.body && req.body.action) || 'list';
    if (action === 'list') {
      const orgId = actor.adminLevel === 'super_admin'
        ? safeString(req.body && req.body.organizationId)
        : actor.organizationId;
      const rows = await identityModel.listAccounts(orgId, { limit: req.body && req.body.limit, search: req.body && req.body.search });
      return res.json({
        status: 'success',
        list: rows.map((row) => ({
          accountId: safeString(row.account_id),
          personId: safeString(row.person_id),
          name: safeString(row.name),
          studentId: safeString(row.student_id),
          accountStatus: safeString(row.status),
          hasActiveBinding: Boolean(row.has_active_binding),
          hasRecoveryCode: Boolean(row.has_recovery_code),
          isSuperAdmin: Boolean(row.is_super_admin),
          verifiedAt: row.verified_at,
          recoveryRequiredAt: row.recovery_required_at
        }))
      });
    }
    if (action === 'freeze' || action === 'unfreeze') {
      const globalActor = await requireAdminPermission(req, 'auth.accounts.global_manage');
      const result = await identityModel.setAccountFrozen(
        req.body && req.body.personId,
        action === 'freeze',
        globalActor,
        metadata(req)
      );
      return res.json({
        status: 'success',
        accountStatus: result.status,
        message: action === 'freeze' ? personnelCopy.accountFrozen : personnelCopy.accountUnfrozen
      });
    }
    throw new identityModel.IdentityError('invalid_action', localeCopy.copy_e6669be1f4, 400);
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.get('/admin/auth/policy', async (req, res) => {
  try {
    await requireAdminPermission(req, 'auth.policy.manage');
    return res.json({ status: 'success', policy: await identityModel.getPolicy() });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/policy', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.policy.manage');
    if (safeString(req.body && req.body.action) === 'get') {
      return res.json({ status: 'success', policy: await identityModel.getPolicy() });
    }
    const policy = await identityModel.savePolicy(req.body || {}, actor);
    return res.json({ status: 'success', policy });
  } catch (error) {
    return sendError(req, res, error);
  }
});

router.post('/admin/auth/audit', async (req, res) => {
  try {
    const actor = await requireAdminPermission(req, 'auth.accounts.audit');
    const orgId = actor.adminLevel === 'super_admin'
      ? safeString(req.body && req.body.organizationId)
      : actor.organizationId;
    const rows = await identityModel.listAuditEvents(orgId, req.body && req.body.limit);
    return res.json(await withSystemTimezone({
      status: 'success',
      list: rows.map((row) => ({
        id: safeString(row.id),
        eventType: safeString(row.event_type),
        actorName: safeString(row.actor_name),
        targetName: safeString(row.target_name),
        organizationId: safeString(row.organization_id),
        outcome: safeString(row.outcome),
        createdAt: row.created_at
      }))
    }));
  } catch (error) {
    return sendError(req, res, error);
  }
});

module.exports = router;
