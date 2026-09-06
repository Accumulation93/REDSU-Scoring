const localeCopy = require('../locales/zh-CN/generated/middleware/auth');
const jwt = require('jsonwebtoken');
const { logger } = require('../utils/logger');
const unifiedIdentityModel = require('../core/models/unifiedIdentity');
const { validateIdentityCryptoConfig } = require('../core/services/identityCrypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required but not set');
}
if (process.env.NODE_ENV === 'production' && Buffer.byteLength(JWT_SECRET, 'utf8') < 32) {
  throw new Error('JWT_SECRET must contain at least 32 bytes in production');
}
if (process.env.NODE_ENV === 'production') validateIdentityCryptoConfig();

// 无需认证的入口；认领/恢复入口独立验证受限引导令牌。
const PUBLIC_PATHS = new Set([
  '/api/ping',
  '/api/health',
  '/api/userLogin',
  '/api/adminLogin',
  '/api/getTimeConfig',
  '/api/auth/wechat/session',
  '/api/auth/claims',
  '/api/auth/claims/verify',
  '/api/auth/claims/redeem',
  '/api/auth/password/session',
  '/api/auth/recovery/start',
  '/api/auth/recovery/complete'
]);

// 业务请求只接收服务端会话确认的账号、自然人和工作角色；微信仅属于登录凭据。
async function authMiddleware(req, res, next) {
  req.openid = ''; // 保留空兼容字段，禁止把任何微信标识当作业务调用者。
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }

  // 受保护入口必须同时通过令牌、服务端会话和工作角色验证。
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    req.openid = '';
    logger.warn('Missing auth token', { requestId: req.requestId, path: req.path });
    return res.status(401).json({ status: 'auth_failed', message: localeCopy.copy_20ca49e5e7 });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.kind === 'unified_access') {
      jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256'],
        audience: 'whusu-smart-workspace-api',
        issuer: 'whusu-smart-workspace'
      });
      const loaded = await unifiedIdentityModel.loadSession(decoded.sid);
      if (!loaded
        || loaded.session.account_id !== decoded.accountId
        || Number(loaded.session.token_version) !== Number(decoded.tokenVersion)
        || loaded.context.contextId !== decoded.contextId) {
        logger.warn('Unified auth session unavailable', {
          requestId: req.requestId,
          path: req.path,
          sessionId: decoded.sid || ''
        });
        return res.status(401).json({ status: 'auth_failed', message: localeCopy.copy_b10d64a68c });
      }
      req.authSession = loaded.session;
      req.authAccount = {
        id: loaded.session.account_id,
        personId: loaded.session.person_id,
        tokenVersion: loaded.session.account_token_version,
        name: loaded.session.name,
        studentId: loaded.session.student_id
      };
      req.authContext = loaded.context;
      // 统一身份令牌中的服务端上下文是唯一授权来源。请求头仅保留给旧客户端兼容。
      req.headers['x-active-org'] = loaded.context.organizationId;
      req.headers['x-role'] = loaded.context.role;
    } else {
      logger.warn('Legacy auth token rejected', {
        requestId: req.requestId,
        path: req.path
      });
      return res.status(401).json({ status: 'auth_failed', message: localeCopy.copy_b10d64a68c });
    }
  } catch (e) {
    req.openid = '';
    logger.warn('Invalid or expired JWT', { requestId: req.requestId, path: req.path, error: e.message });
    return res.status(401).json({ status: 'auth_failed', message: localeCopy.copy_b10d64a68c });
  }
  next();
}

module.exports = { authMiddleware, JWT_SECRET };
