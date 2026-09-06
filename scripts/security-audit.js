'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['miniprogram', 'server'];
const RULES = [
  { id: 'dynamic-code', severity: 'critical', pattern: /\b(?:eval|Function)\s*\(/g },
  {
    id: 'insecure-http',
    severity: 'high',
    pattern: /["']http:\/\//g,
    allow: (match, relativeFile) => {
      const candidate = match.input.slice(match.index, match.index + 120);
      // 仅隔离服务端测试允许回环 HTTP；生产代码及任何外部测试地址仍要求 HTTPS。
      if (relativeFile.startsWith('server/test/') && /^['"]http:\/\/127\.0\.0\.1(?=[:/])/.test(candidate)) return true;
      return candidate.includes('http://www.w3.org/')
        || candidate.includes('http://schemas.openxmlformats.org/');
    }
  },
  { id: 'token-log', severity: 'high', pattern: /console\.(?:log|info|warn)\([^\n]*\b(?:token|authorization)\b/gi },
  { id: 'unsafe-temp-path', severity: 'high', pattern: /USER_DATA_PATH[^\n]+(?:fileId|fileName)/g },
  {
    id: 'dynamic-navigation',
    severity: 'medium',
    pattern: /wx\.(?:navigateTo|redirectTo)\(\{\s*url\s*:\s*[A-Za-z_$][\w$]*/g,
    allow: (_match, relativeFile) => relativeFile === 'miniprogram/utils/trustedNavigation.js'
  }
];

function addFinding(severity, rule, file, source, offset) {
  findings.push({ severity, rule, file, line: lineAt(source, Math.max(0, offset || 0)) });
}

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'coverage', 'dist', '.git'].includes(entry.name)) walk(fullPath, output);
    else if (/\.(?:js|wxs)$/.test(entry.name)) output.push(fullPath);
  }
  return output;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

const findings = [];
for (const target of TARGETS) {
  for (const file of walk(path.join(ROOT, target))) {
    const source = fs.readFileSync(file, 'utf8');
    const relativeFile = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source))) {
        if (rule.allow && rule.allow(match, relativeFile, source)) continue;
        findings.push({
          severity: rule.severity,
          rule: rule.id,
          file: relativeFile,
          line: lineAt(source, match.index)
        });
      }
    }

    if (relativeFile.startsWith('server/src/')) {
      const consoleLog = source.search(/console\.log\s*\(/);
      if (consoleLog >= 0) addFinding('high', 'server-console-log', relativeFile, source, consoleLog);
      const runtimeDdl = source.search(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX|DATABASE)\b/i);
      if (runtimeDdl >= 0) addFinding('high', 'runtime-ddl', relativeFile, source, runtimeDdl);
      const legacySpreadsheet = source.search(/require\(['"]xlsx['"]\)/);
      if (legacySpreadsheet >= 0) addFinding('high', 'legacy-xlsx-runtime', relativeFile, source, legacySpreadsheet);
      const legacyUuid = source.search(/require\(['"]uuid['"]\)/);
      if (legacyUuid >= 0) addFinding('high', 'legacy-uuid-runtime', relativeFile, source, legacyUuid);
      const clientTempPath = source.search(/req\.body\.(?:tmpPath|tempPath|filePath)\b/);
      if (clientTempPath >= 0) addFinding('high', 'client-file-path-trust', relativeFile, source, clientTempPath);
    }

    if (/server\/src\/(?:core|modules)\/.+\/routes\/.+\.js$/.test(relativeFile) ||
      /server\/src\/core\/routes\/.+\.js$/.test(relativeFile)) {
      const directSql = source.search(/pool\.(?:query|execute)\s*\(/);
      if (directSql >= 0) addFinding('info', 'route-direct-sql', relativeFile, source, directSql);
    }

    if (relativeFile.startsWith('server/src/core/routes/') && source.includes('pool.')) {
      const poolImport = source.search(/const\s+pool\s*=\s*require\(['"]\.\.\/\.\.\/config\/db['"]\)/);
      const firstRoute = source.indexOf('router.');
      if (poolImport < 0 || (firstRoute >= 0 && poolImport > firstRoute)) {
        findings.push({
          severity: 'high',
          rule: 'route-pool-scope',
          file: relativeFile,
          line: lineAt(source, source.indexOf('pool.'))
        });
      }
    }
  }
}

function hydrateLocaleCopy(source, file) {
  const match = source.match(/const\s+localeCopy\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)/);
  if (!match) return source;
  const localeFile = require.resolve(path.resolve(path.dirname(file), match[2]));
  delete require.cache[localeFile];
  const localeCopy = require(localeFile);
  return source.replace(/\blocaleCopy\.([A-Za-z0-9_]+)\b/g, (raw, key) => {
    if (!Object.prototype.hasOwnProperty.call(localeCopy, key)) return raw;
    return `'${String(localeCopy[key]).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  });
}

function requireSourceContract(relativeFile, checks) {
  const file = path.join(ROOT, relativeFile);
  const source = hydrateLocaleCopy(fs.readFileSync(file, 'utf8'), file);
  for (const check of checks) {
    if (check.test(source)) continue;
    addFinding(check.severity || 'high', check.rule, relativeFile, source, 0);
  }
}

requireSourceContract('server/src/middleware/orgContext.js', [
  {
    rule: 'org-session-context-required',
    test: source => source.includes('const authContext = req.authContext')
      && source.includes('authContext.organizationId')
      && source.includes("req.headers['x-active-org'] = orgId")
      && !source.includes('async function _userCanAccessOrg')
  },
  { rule: 'org-no-default-fallback', test: source => !/current_organization|systemConfigModel/.test(source) }
]);
requireSourceContract('server/src/core/services/adminAuthorization.js', [
  { rule: 'admin-two-level-matrix', test: source => source.includes("const ADMIN_LEVELS = [SUPER_ADMIN_LEVEL, REGULAR_ADMIN_LEVEL]") && !source.includes('root_admin') },
  { rule: 'admin-self-management-blocked', test: source => source.includes('operator.id === target.id') },
  { rule: 'admin-last-super-protected', test: source => source.includes('Number(activeSuperAdminCount) > 1') }
]);
requireSourceContract('server/src/core/models/adminInfo.js', [
  {
    rule: 'legacy-admin-invite-isolated',
    test: source => source.includes('async function updateInvite(')
      && source.includes('module.exports')
  }
]);
requireSourceContract('server/src/core/routes/admin.js', [
  {
    rule: 'admin-invite-disabled',
    test: source => source.includes("router.post('/createAdminInvite'")
      && source.includes("router.post('/generateAdminInviteCode'")
      && (source.match(/status: 'legacy_auth_disabled'/g) || []).length >= 2
      && !source.includes('createInviteCredential')
  }
]);
requireSourceContract('server/src/core/routes/auth.js', [
  {
    rule: 'admin-invite-binding-disabled',
    test: source => source.includes("router.post('/bindAdminInfo'")
      && source.includes("message: '请更新小程序并使用微信登录'")
      && !source.includes('WHERE invite_code = ?')
  },
  {
    rule: 'auth-role-from-body',
    test: source => source.includes("const role = safeString(req.headers['x-role']).toLowerCase()")
      && !source.includes("req.headers['x-role'] || req.body.role")
      && !source.includes("safeString(req.body.role || 'user')")
  }
]);
requireSourceContract('server/src/core/services/adminPermissions.js', [
  {
    rule: 'hr-template-permission-split',
    test: source => source.includes("key: 'hr.profile_templates.manage'")
      && source.includes("key: 'hr.profile_templates.select'")
      && !/mapRoutes\('hr\.profile_review',\s*\[[^\]]*saveHrProfileTemplate/.test(source)
  }
]);
requireSourceContract('server/src/middleware/adminPermission.js', [
  {
    rule: 'admin-role-header-bypass',
    test: source => source.includes("status: 'admin_role_required'")
      && source.includes('rule.allowUserRole')
      && !source.includes("if (!rule || req.get('X-Role') !== 'admin') return next()")
  }
]);
requireSourceContract('server/src/modules/venue/utils/venueApprovalRuleMatcher.js', [
  {
    rule: 'venue-specific-empty-deny',
    test: source => source.includes('if (!departmentIds.length || !departmentIds.includes')
      && source.includes('if (!workGroupIds.length || !workGroupIds.includes')
      && source.includes('if (!identityIds.length || !identityIds.includes')
  }
]);
requireSourceContract('server/src/modules/scoring/models/scoreRecord.js', [
  {
    rule: 'score-record-column-allowlist',
    test: source => source.includes('const CONDITION_COLUMNS = Object.freeze')
      && source.includes('const dbKey = CONDITION_COLUMNS[key]')
      && !source.includes("key.replace(/([A-Z])/g")
  }
]);
requireSourceContract('server/src/modules/audit/routes/auditSignature.js', [
  {
    rule: 'audit-signature-role-confusion',
    test: source => source.includes('const actorResult = await resolveCurrentActor(req)')
      && source.includes("actorResult.actor.type === 'admin'")
      && source.includes("actorResult.actor.type !== 'user'")
      && !source.includes("req.get('X-Role')")
      && !source.includes("req.headers['x-role']")
  }
]);
requireSourceContract('server/src/modules/audit/routes/auditUser.js', [
  {
    rule: 'audit-detail-role-confusion',
    test: source => source.includes('const detailActorResult = await resolveCurrentActor(req)')
      && source.includes("const detailActor = currentActor.type === 'user'")
      && source.includes("const admin = currentActor.type === 'admin'")
      && !source.includes("req.get('X-Role')")
      && !source.includes("req.headers['x-role']")
  },
  {
    rule: 'audit-detail-diagnostic-leak',
    test: source => !source.includes('_diag:')
      && !source.includes('operatorHrId: safeString(e.operator_hr_id)')
      && !/catch \(_\) \{\s*stepHasExplicitConds = false/.test(source)
      && !/catch \(_\) \{\s*hasExplicitConditions = false/.test(source)
  }
]);
requireSourceContract('server/src/modules/audit/models/auditSubmissionStep.js', [
  {
    rule: 'audit-specific-empty-deny',
    test: source => source.includes('if (!specificDeptId || !inCsv')
      && source.includes('if (!specificWgId || !inCsv')
      && source.includes('if (!specificIdentId || !inCsv')
  },
  {
    rule: 'audit-corrupt-condition-deny',
    test: source => {
      const snapshotParse = source.match(
        /if \(!row\.step_conditions_json\) continue;\s*try \{\s*const conditions = JSON\.parse\(row\.step_conditions_json\);[\s\S]*?\} catch \(_\) \{([\s\S]*?)\n\s*\}/
      );
      return Boolean(snapshotParse)
        && !/rows\.push|return\s+true|hasExplicitConditions\s*=\s*false/.test(snapshotParse[1])
        && !/catch \(e\) \{\s*hasExplicitConditions = false/.test(source);
    }
  }
]);
requireSourceContract('server/src/modules/scoring/routes/scoring.js', [
  {
    rule: 'scoring-role-from-body',
    test: source => source.includes("router.post('/getRateTargets'")
      && source.includes('const actorResult = await resolveCurrentActor(req)')
      && source.includes("actorResult.actor.type === 'admin'")
      && source.includes("actorResult.actor.type !== 'user'")
      && !source.includes("req.get('X-Role')")
      && !source.includes("req.headers['x-role']")
      && !source.includes('req.body.role')
  }
]);
requireSourceContract('miniprogram/utils/trustedNavigation.js', [
  {
    rule: 'trusted-navigation-allowlist',
    test: source => source.includes('const TRUSTED_ROUTES = {')
      && source.includes('TRUSTED_ROUTES[pathname] === true')
  }
]);
requireSourceContract('server/src/core/services/hrProfileTemplateLibrary.js', [
  {
    rule: 'hr-template-switch-atomic-org-scope',
    test: source => source.includes('pool.withTransaction(async (connection)')
      && source.includes('WHERE org_id = ? AND field_id = ?')
      && source.includes('actionsHash')
      && source.includes('valueStateHash')
      && source.includes('delete_confirmation_required')
  }
]);
requireSourceContract('server/src/core/routes/hrProfile.js', [
  {
    rule: 'hr-template-legacy-save-disabled',
    test: source => source.includes("router.post('/saveHrProfileTemplate', (req, res) =>")
      && source.includes('return res.status(410).json({')
      && source.includes("status: 'legacy_api_retired'")
      && !source.includes('INSERT INTO hr_profile_templates (id, template_key')
  }
]);
requireSourceContract('server/src/modules/audit/utils/fileSecurity.js', [
  { rule: 'signed-file-token', test: source => /createHmac\(['"]sha256['"]/.test(source) && /timingSafeEqual/.test(source) }
]);
requireSourceContract('server/src/middleware/requestContext.js', [
  { rule: 'crypto-request-id', test: source => /randomUUID/.test(source) && !/require\(['"]uuid['"]\)/.test(source) }
]);

const summary = findings.reduce((result, finding) => {
  result[finding.severity] += 1;
  return result;
}, { critical: 0, high: 0, medium: 0, info: 0 });

console.log('WHUSU Smart Workspace security audit');
console.table(summary);
if (findings.length) console.table(findings);

if (process.argv.includes('--strict') && (summary.critical || summary.high)) process.exitCode = 1;
