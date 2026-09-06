process.umask(0o077);

const localeCopy = require('./locales/zh-CN/generated/index');
require('dotenv').config();
const helmet = require('helmet');
const express = require('express');
const cors = require('cors');
const pool = require('./config/db');
const morgan = require('morgan');
const { logger, createRequestLogger } = require('./utils/logger');
const requestContext = require('./middleware/requestContext');
const { authMiddleware } = require('./middleware/auth');
const { orgContextMiddleware } = require('./middleware/orgContext');
const { adminPermissionMiddleware } = require('./middleware/adminPermission');
const { timeReviewPresentationMiddleware } = require('./middleware/timeReviewPresentation');
const { clientVersionMiddleware } = require('./middleware/clientVersion');
const { createRateLimiter, createSharedRateLimiter } = require('./middleware/rateLimiter');
const sharedRateLimitModel = require('./core/models/sharedRateLimit');
const { verifySchemaContract } = require('./utils/schemaContract');
const unifiedIdentityModel = require('./core/models/unifiedIdentity');
const notificationOutboxModel = require('./modules/audit/models/notificationOutbox');
const auditFileStorageMaintenance = require('./modules/audit/services/auditFileStorageMaintenance');
const { protectPublicMessage } = require('./utils/publicMessage');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const startTime = Date.now();
const REQUEST_TIMEOUT_MS = 30000;
const MAX_JSON_BODY_BYTES = 500000;
const MAX_UPLOAD_JSON_BODY_BYTES = 15 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_DEFAULT_MAX = 180;
const RATE_LIMIT_LOGIN_MAX = 30;
const HEALTH_CACHE_MS = 2000;
let healthCache = null;
let healthCheckPromise = null;
const PUBLIC_BODY_ROUTES = new Set([
  '/api/userLogin',
  '/api/adminLogin',
  '/api/auth/wechat/session',
  '/api/auth/claims',
  '/api/auth/claims/verify',
  '/api/auth/claims/redeem',
  '/api/auth/password/session',
  '/api/auth/recovery/start',
  '/api/auth/recovery/complete'
]);
const SHARED_IP_RATE_POLICIES = Object.freeze({
  '/api/ping': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 120 },
  '/api/health': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 30 },
  '/api/userLogin': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/adminLogin': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/wechat/session': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/claims': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/claims/verify': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/claims/redeem': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/password/session': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/recovery/start': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/auth/recovery/complete': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_LOGIN_MAX },
  '/api/uploadAuditFile': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 30 }
});
const SHARED_ACCOUNT_RATE_POLICIES = Object.freeze({
  '/api/uploadAuditFile': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 20 },
  '/api/parseTableFile': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 6 },
  '/api/verifyAuditFile': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 8 },
  '/api/verifyFileSignature': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 4 },
  '/api/verifySignatureChain': { windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: 4 }
});

// Trust the Nginx reverse proxy for correct client IP / protocol detection
app.set('trust proxy', 1);

// ---------- 请求上下文 ----------
app.use(requestContext);
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = function(body) {
    if (req.timedOut && res.writableEnded) return res;
    if (body && typeof body === 'object' && !Array.isArray(body) && !body.requestId) {
      body.requestId = req.requestId || '';
    }
    return sendJson(protectPublicMessage(body));
  };
  next();
});

app.use((req, res, next) => {
  const controller = new AbortController();
  req.abortController = controller;
  req.signal = controller.signal;
  const timer = setTimeout(() => {
    req.timedOut = true;
    controller.abort(new Error('request_timeout'));
    if (!res.headersSent) res.status(503).json({ status: 'request_timeout', message: localeCopy.copy_e58fa637eb });
  }, REQUEST_TIMEOUT_MS);
  const clear = () => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);
  next();
});

// ---------- morgan custom tokens ----------
morgan.token('ip', req => req.ip || '-');
morgan.token('rid', req => req.requestId || '-');
morgan.token('ua', req => (req.get('user-agent') || '-').slice(0, 80));
morgan.token('ref', req => (req.get('referer') || '-').slice(0, 60));
morgan.token('res-size', (req, res) => res.get('content-length') || '-');

// ---------- middleware ----------
app.use(morgan(':method :url :status :response-time ms ip=:ip ua=:ua ref=:ref rid=:rid size=:res-size', {
  stream: createRequestLogger(),
  skip: (req) => req.path === '/api/ping' || req.path === '/api/health'
}));
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://accumulation93.com',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Active-Org', 'X-Role', 'X-Client-Version', 'X-Request-Id']
}));
app.use(clientVersionMiddleware);

app.use(createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  defaultMax: RATE_LIMIT_DEFAULT_MAX,
  loginMax: RATE_LIMIT_LOGIN_MAX,
  capacity: 5000
}));
// 高风险入口必须再经过 MySQL 共享桶；数据库不可用时安全失败，不能退回进程内额度。
app.use(createSharedRateLimiter({
  store: sharedRateLimitModel,
  policies: SHARED_IP_RATE_POLICIES,
  keyResolver: (req) => 'ip:' + String(req.ip || '-')
}));

// 公共健康检查也必须位于共享限流与基础安全响应头之后。
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/health', async (req, res) => {
  const now = Date.now();
  if (!healthCache || healthCache.expiresAt <= now) {
    if (!healthCheckPromise) {
      healthCheckPromise = pool.query('SELECT 1')
        .then(() => ({ statusCode: 200, body: { status: 'ok' } }))
        .catch(() => ({ statusCode: 503, body: { status: 'degraded' } }))
        .then((result) => {
          healthCache = Object.assign({ expiresAt: Date.now() + HEALTH_CACHE_MS }, result);
          return healthCache;
        })
        .finally(() => { healthCheckPromise = null; });
    }
    await healthCheckPromise;
  }
  return res.status(healthCache.statusCode).json(healthCache.body);
});

const LARGE_JSON_ROUTES = new Set([
  '/api/uploadAuditFile',
  '/api/parseTableFile',
  '/api/verifySignatureChain',
  '/api/verifyFileSignature'
]);

function parseJsonBody(req, res, next) {
  const bodyLimit = LARGE_JSON_ROUTES.has(req.path) ? MAX_UPLOAD_JSON_BODY_BYTES : MAX_JSON_BODY_BYTES;
  const contentLength = Number(req.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
    return res.status(413).json({ status: 'payload_too_large', message: localeCopy.copy_ac4ff526e9 });
  }
  return express.json({ limit: bodyLimit, strict: true })(req, res, next);
}

function requestComplexityGuard(req, res, next) {
  if (!req.body || typeof req.body !== 'object') return next();
  const stack = [{ value: req.body, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (current.depth > 24 || nodes > 100000) {
      return res.status(413).json({ status: 'payload_too_complex', message: localeCopy.copy_ac4ff526e9 });
    }
    if (!current.value || typeof current.value !== 'object') continue;
    for (const value of Object.values(current.value)) {
      if (value && typeof value === 'object') stack.push({ value, depth: current.depth + 1 });
    }
  }
  next();
}

const parseUrlEncodedBody = express.urlencoded({ extended: false, limit: '64kb' });

// 登录、认领和恢复是公开入口，先以普通 500KB 上限解析请求体，再交给认证中间件放行。
app.use((req, res, next) => PUBLIC_BODY_ROUTES.has(req.path) ? parseJsonBody(req, res, next) : next());
app.use((req, res, next) => PUBLIC_BODY_ROUTES.has(req.path) ? parseUrlEncodedBody(req, res, next) : next());
app.use((req, res, next) => PUBLIC_BODY_ROUTES.has(req.path) ? requestComplexityGuard(req, res, next) : next());

// Remove Express fingerprint header
app.disable('x-powered-by');

app.use(authMiddleware);

// 上传入口在 JWT 会话校验后再按账号使用共享桶，避免多 IP 绕过单账号边界。
app.use(createSharedRateLimiter({
  store: sharedRateLimitModel,
  policies: SHARED_ACCOUNT_RATE_POLICIES,
  keyResolver: (req) => 'account:' + String(req.authAccount && req.authAccount.id || '')
}));

// 所有受保护请求都先认证，再解析可能达到 15MB 的 JSON 请求体。
app.use((req, res, next) => PUBLIC_BODY_ROUTES.has(req.path) ? next() : parseJsonBody(req, res, next));
app.use((req, res, next) => PUBLIC_BODY_ROUTES.has(req.path) ? next() : parseUrlEncodedBody(req, res, next));
app.use((req, res, next) => PUBLIC_BODY_ROUTES.has(req.path) ? next() : requestComplexityGuard(req, res, next));

// 组织上下文中间件（基于 X-Active-Org header，注入 ALS）
app.use(orgContextMiddleware);

// 管理端细粒度权限由服务端统一强制执行；前端隐藏入口仅用于改善体验。
app.use(adminPermissionMiddleware);

// 历史绝对时间逐记录待核对状态必须随业务响应下发，禁止把未证明的墙上时间静默当作 UTC。
app.use(timeReviewPresentationMiddleware);

app.get('/api/admin/health', async (req, res) => {
  const startedAt = Date.now();
  try {
    const [, deadLetterCount] = await Promise.all([
      pool.query('SELECT 1'),
      notificationOutboxModel.getDeadLetterCount()
    ]);
    res.json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      databaseLatencyMs: Date.now() - startedAt,
      processId: process.pid,
      notificationDeadLetters: deadLetterCount,
      warnings: deadLetterCount > 0 ? ['notification_dead_letters_pending'] : []
    });
  } catch (e) {
    req.logger.error('Protected health check failed', { error: e.message });
    res.status(503).json({ status: 'degraded', message: localeCopy.copy_73f0b7a29a });
  }
});

// ---------- 诊断：拦截并记录所有错误响应 ----------
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = function (body) {
    if (body && body.status === 'error' && body.message) {
      logger.error('Route error response', {
        event: 'route.error',
        path: req.path,
        method: req.method,
        message: body.message,
        accountId: req.authAccount ? req.authAccount.id : undefined,
        requestId: req.requestId,
        stack: new Error().stack
      });
    }
    return _json(body);
  };
  next();
});

// ---------- business routes ----------
app.use('/api', require('./core/routes/unifiedAuth'));
app.use('/api', require('./core/routes/auth'));
app.use('/api', require('./core/routes/org'));
app.use('/api', require('./core/routes/departments'));
app.use('/api', require('./core/routes/identities'));
app.use('/api', require('./core/routes/workGroups'));
app.use('/api', require('./core/routes/hr'));
app.use('/api', require('./core/routes/admin'));
app.use('/api', require('./core/routes/adminPermissions'));
app.use('/api', require('./core/routes/user'));
app.use('/api', require('./modules/scoring/routes/scoring'));
app.use('/api', require('./modules/scoring/routes/activities'));
app.use('/api', require('./modules/scoring/routes/templates'));
app.use('/api', require('./modules/scoring/routes/rules'));
app.use('/api', require('./modules/scoring/routes/results'));
app.use('/api', require('./core/routes/hrProfile'));
app.use('/api', require('./core/routes/system'));
app.use('/api', require('./core/routes/parseTableFile'));
app.use('/api', require('./core/routes/buildTableFile'));
app.use('/api', require('./modules/scoring/routes/publications'));
app.use('/api', require('./modules/audit/routes/auditAdmin'));
app.use('/api', require('./modules/audit/routes/auditUser'));
app.use('/api', require('./modules/audit/routes/auditSignature'));
app.use('/api', require('./modules/audit/routes/auditFile'));
app.use('/api', require('./modules/audit/routes/notification'));

// ---------- Venue Booking ----------
app.use('/api', require('./modules/venue/routes/venueAdmin'));
app.use('/api', require('./modules/venue/routes/venueUser'));
app.use('/api', require('./modules/venue/routes/venueApprovalAdmin'));

// ---------- 404 handler (fail fast for unknown routes) ----------
app.use('/api', (req, res) => {
  res.status(404).json({ status: 'not_found', message: localeCopy.copy_e6669be1f4 });
});

// ---------- error handler ----------
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    event: 'server.error',
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    ip: req.ip,
    requestId: req.requestId,
    openid: (req.openid || '').slice(0, 12) || undefined
  });
  res.status(500).json({ status: 'error', message: localeCopy.copy_73f0b7a29a });
});

let server = null;
async function startServer() {
  try {
    require('./modules/audit/services/signingEvidenceKeys').assertSigningReadiness();
    const t0 = Date.now();
    await pool.query('SELECT 1');
    const bindingUpgrade = await unifiedIdentityModel.upgradeLegacyWechatBindings();
    const schema = await verifySchemaContract(pool);
    auditFileStorageMaintenance.securePermissions();
    logger.info('Database connected', {
      event: 'db.connect',
      latency: Date.now() - t0,
      schemaRevision: schema.revision,
      upgradedWechatBindings: bindingUpgrade.upgraded
    });
  } catch (e) {
    logger.error('Database or schema unavailable', { event: 'db.error', error: e.message, code: e.code });
    await pool.end().catch(() => {});
    process.exitCode = 1;
    return;
  }
  server = app.listen(PORT, '127.0.0.1', () => {
    logger.info('Server is ready', {
      event: 'server.start',
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      node: process.version,
      pid: process.pid
    });
  });
  auditFileStorageMaintenance.start();
}

startServer();

// ---------- graceful shutdown ----------
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  auditFileStorageMaintenance.stop();
  logger.info(signal + ' received, shutting down...', {
    event: 'server.shutdown',
    signal,
    uptime: Math.floor((Date.now() - startTime) / 1000)
  });
  if (!server) {
    pool.end().then(() => { process.exit(0); }).catch(() => { process.exit(0); });
    return;
  }
  server.close(() => {
    logger.info('HTTP server closed');
    pool.end().then(() => { process.exit(0); }).catch(() => { process.exit(0); });
  });
  setTimeout(() => { process.exit(1); }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  if (!shuttingDown) { shuttingDown = true; process.exit(1); }
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled rejection', { error: error.message, stack: error.stack });
  if (!shuttingDown) { shuttingDown = true; process.exit(1); }
});
