'use strict';

const fs = require('fs');
const path = require('path');
const { ROUTE_RULES } = require('../server/src/core/services/adminPermissions');

const ROOT = path.resolve(__dirname, '../server/src');
const EXPLICIT_SHARED_ROUTES = new Set([
  '/adminLogin',
  '/activateOrganization',
  '/admin/listMyOrganizations',
  '/unbindRole',
  '/getRateTargets'
]);

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, output);
    else if (entry.name.endsWith('.js') && fullPath.includes(`${path.sep}routes${path.sep}`)) output.push(fullPath);
  }
  return output;
}

const missing = [];
for (const file of walk(ROOT)) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = [...source.matchAll(/router\.post\(\s*(?:\[\s*)?['"]([^'"]+)['"]/g)];
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const routeBlock = source.slice(match.index, end);
    const performsAdminLookup = /ensureAdmin\s*\(|requireAdmin\s*\(|resolveRequestAdmin\s*\(|requireAdminOrganizationPermission\s*\(/.test(routeBlock);
    if (!performsAdminLookup || EXPLICIT_SHARED_ROUTES.has(match[1]) || ROUTE_RULES.has(match[1])) return;
    missing.push({
      route: match[1],
      file: path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/'),
      line: source.slice(0, match.index).split('\n').length
    });
  });
}

console.log(`管理员路由权限覆盖审计：缺失 ${missing.length} 个`);
if (missing.length) console.table(missing);
if (process.argv.includes('--strict') && missing.length) process.exitCode = 1;
