'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_ROOT = path.join(ROOT, 'server/src');
function listSqlFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) listSqlFiles(fullPath, output);
    else if (entry.name.endsWith('.sql')) output.push(fullPath);
  }
  return output;
}

const schemaFiles = listSqlFiles(path.join(ROOT, 'server/db'));
const initSql = schemaFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const scopedTables = [];

for (const match of initSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?\s*\(([\s\S]*?)\)\s*ENGINE=/g)) {
  if (/\borg_id\b/i.test(match[2])) scopedTables.push(match[1]);
}

// 跨组织例外必须由已认证账号自然人、已授权主键、一次性邀请或后台维护范围限定。
// 微信不得用于业务操作者发现；旧绑定仅允许显式恢复、迁移与清理路径。
const CROSS_ORG_ALLOWLIST = [
  { file: 'server/src/modules/audit/models/signingEvidence.js', sql: /SELECT input_file_path, output_file_path FROM audit_signing_evidence\s+WHERE input_file_path IN/i, reason: '后台全组织附件清理只按绝对候选路径交集检查历史凭证引用，不返回业务或身份信息' },
  { file: 'server/src/core/models/adminInfo.js', sql: /FROM admin_info WHERE id = \? AND admin_level IN/i, reason: '权限管理精确主键锁定' },
  { file: 'server/src/core/models/adminInfo.js', sql: /FROM admin_info\s+WHERE invite_code = \?/i, reason: '一次性邀请码查找' },
  { file: 'server/src/core/models/hrInfo.js', sql: /FROM hr_info WHERE student_id = \?/i, reason: '登录时跨组织身份匹配' },
  { file: 'server/src/core/models/userInfo.js', sql: /DELETE FROM user_info WHERE openid IN/i, reason: '管理员按已锁定 OpenID 从所有组织解绑普通用户微信' },
  { file: 'server/src/modules/venue/routes/venueUser.js', sql: /SELECT id, name FROM admin_info WHERE id IN/i, reason: '全局场地记录展示创建管理员名称' },
  { file: 'server/src/modules/venue/routes/venueUser.js', sql: /SELECT \* FROM hr_info WHERE id IN/i, reason: '跨组织可见借用记录按人事主键解析借用人' },
  { file: 'server/src/modules/venue/routes/venueUser.js', sql: /SELECT id, name FROM hr_info WHERE id IN/i, reason: '跨组织可见借用记录解析审批快照审批人姓名' },
  { file: 'server/src/modules/venue/routes/venueAdmin.js', sql: /SELECT id, name FROM admin_info WHERE id IN/i, reason: '全局场地记录展示创建管理员名称' },
  { file: 'server/src/modules/venue/routes/venueAdmin.js', sql: /SELECT \* FROM hr_info WHERE id IN/i, reason: '跨组织可见借用记录按人事主键解析借用人' },
  { file: 'server/src/modules/venue/routes/venueAdmin.js', sql: /SELECT id, name FROM hr_info WHERE id IN/i, reason: '跨组织可见借用记录解析审批快照审批人姓名' },
  { file: 'server/src/modules/audit/models/notification.js', sql: /DELETE FROM notifications WHERE created_at </i, reason: '后台全局保留期清理' },
  { file: 'server/src/modules/audit/models/notificationOutbox.js', sql: /notification_outbox/i, reason: '后台工作进程跨组织领取与清理事件' },
  { file: 'server/src/modules/audit/models/auditSubmissionFile.js', sql: /SUM\(CASE WHEN signing_key_private/i, reason: '离线私钥迁移工具只汇总全库加密状态，不返回文件或人员业务内容' },
  { file: 'server/src/modules/audit/services/auditFileStorageMaintenance.js', sql: /SELECT id\s+FROM audit_submission_files\s+WHERE file_path = \?/i, reason: '全局附件存储维护任务在删除候选文件前按绝对路径二次确认数据库引用' },
  { file: 'server/src/modules/audit/services/auditFileStorageMaintenance.js', sql: /SELECT file_path\s+FROM audit_submission_files\s+WHERE file_path IS NOT NULL/i, reason: '全局附件存储维护任务建立引用集合，防止跨组织共享存储中的有效文件被误删' },
  { file: 'server/src/modules/audit/utils/fileSecurity.js', sql: /SELECT file_path\s+FROM audit_submission_files\s+WHERE file_path IN/i, reason: '临时文件保留期清理仅按服务端生成的绝对候选路径检查全库引用，避免误删已归档附件' },
  { file: 'server/src/utils/requestDeduplication.js', sql: /DELETE FROM request_deduplication/i, reason: '后台全局幂等记录保留期清理' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /FROM organization_memberships WHERE legacy_hr_id = \?/i, reason: '由已授权的旧人员主键解析统一成员关系' },
  { file: 'server/src/core/models/personIdentityOverview.js', sql: /FROM organization_memberships om[\s\S]*WHERE om\.legacy_hr_id = \?/i, reason: '由当前人事列表已授权的旧人员主键解析自然人，后续结果仍按服务端可访问组织过滤' },
  { file: 'server/src/core/models/personGovernance.js', sql: /DELETE FROM user_info WHERE openid = \?/i, reason: '自然人合并事务按已锁定源账号微信标识清除全部旧组织兼容绑定' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /FROM admin_grants grant_row[\s\S]*admin_level = 'super_admin'/i, reason: '永久删除前跨组织锁定并保护最后一名有效超级管理员' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /DELETE FROM identity_verification_invites WHERE issued_by_person_id = \? OR person_id = \?/i, reason: '超级管理员彻底删除自然人时清理其全部认证邀请及发放的未执行邀请' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /UPDATE admin_permission_audit_logs[\s\S]*operator_admin_id IN/i, reason: '超级管理员彻底删除自然人时按已锁定旧管理员主键去标识化审计快照并保留审计事实' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /SELECT id FROM merit_list_designations[\s\S]*WHERE \$\{scoped\.sql\}/i, reason: '永久删除预检使用 addOrgScope：组织删除限定当前组织，自然人删除在超级管理员授权下检查全部组织历史指定' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /SELECT COUNT\(\*\) AS count FROM personnel_migration_audit WHERE \$\{clauses\.join/i, reason: '超级管理员彻底删除自然人预检按已锁定自然人、成员及岗位主键定位全局迁移审计，组织范围删除不执行此分支' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /UPDATE merit_list_designations[\s\S]*designated_by_person_id = NULL/i, reason: '超级管理员彻底删除自然人时按已解密旧 OpenID 或自然人主键去标识历史荣誉指定，保留业务事实' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /UPDATE personnel_migration_audit[\s\S]*record_id = CONCAT\('deleted:'/i, reason: '超级管理员彻底删除自然人时按预检锁定的自然人、成员和岗位主键去标识全局迁移审计' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /UPDATE admin_permission_overrides[\s\S]*configured_by IN/i, reason: '超级管理员彻底删除自然人时按已锁定旧管理员主键去标识化历史授权人引用' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /DELETE FROM admin_info WHERE id IN/i, reason: '超级管理员彻底删除自然人时按已锁定全局唯一旧管理员主键清理兼容记录' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /DELETE FROM admin_grants WHERE person_id = \?/i, reason: '超级管理员彻底删除自然人时清理其全部组织及全局管理员授权' },
  { file: 'server/src/core/models/hrMemberDeletion.js', sql: /SELECT legacy_admin_id FROM admin_grants WHERE person_id = \?/i, reason: '超级管理员彻底删除自然人时按已锁定自然人解析全部旧管理员兼容主键' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /FROM membership_assignments\s+WHERE membership_id = \?/i, reason: '在已授权成员关系内解析岗位' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE membership_assignments\s+SET assignment_kind = \?/i, reason: '按已授权岗位主键更新岗位' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE membership_assignments\s+SET status = 'revoked'[\s\S]*WHERE id = \?/i, reason: '按已授权岗位主键撤销岗位' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /DELETE FROM membership_assignments WHERE membership_id = \?/i, reason: '旧人事删除事务同步清理成员岗位' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /DELETE FROM organization_memberships WHERE id = \?/i, reason: '旧人事删除事务同步清理成员关系' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /FROM organization_memberships WHERE person_id = \?/i, reason: '判断自然人是否仍有任一组织成员关系' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /FROM admin_grants WHERE person_id = \?/i, reason: '解析自然人的全局管理员授权' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /FROM admin_info WHERE id = \? LIMIT 1 FOR UPDATE/i, reason: '按已授权管理员主键锁定旧映射' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /FROM admin_grants WHERE legacy_admin_id = \?/i, reason: '由已授权旧管理员主键解析统一授权' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT ag\.legacy_admin_id, a\.status AS account_status/i, reason: '管理员列表批量解析统一账号认证状态' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE admin_info(?:\s+ai)?[\s\S]*(?:JOIN admin_grants|WHERE id = \?)/i, reason: '统一账号换绑事务同步旧管理员只读映射' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT ag\.\*, a\.id AS account_id, a\.status AS account_status\s+FROM admin_grants ag[\s\S]*WHERE ag\.legacy_admin_id = \?\s+LIMIT 1 FOR UPDATE/i, reason: '目标组织权限已在事务内验证，再按管理员精确主键锁定统一授权以保护最后有效超级管理员；不按微信发现操作者' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT DISTINCT other\.person_id\s+FROM admin_grants/i, reason: '全局超级管理员存续保护' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE admin_grants SET status = 'revoked'[\s\S]*WHERE id = \?/i, reason: '按已授权管理员授权主键撤销' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT a\.id AS account_id[\s\S]*FROM accounts a/i, reason: '获授权账号治理列表跨组织汇总' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT a\.\*,[\s\S]*FROM accounts a[\s\S]*WHERE a\.person_id = \?/i, reason: '获授权账号治理按自然人锁定账号' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT DISTINCT ag\.person_id\s+FROM admin_grants\s+ag/i, reason: '全局超级管理员存续保护' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE identity_verification_invites SET status = 'revoked'/i, reason: '按服务端已核准范围撤销初始化认证码' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE identity_verification_invites SET failed_attempts/i, reason: '按单个认证邀请控制失败次数和锁定' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /UPDATE identity_verification_invites SET status = 'consumed'/i, reason: '按已验证的一次性邀请单元消费' },
  { file: 'server/src/core/models/unifiedIdentity.js', sql: /SELECT 1\s+FROM admin_grants\s+WHERE person_id = \? AND admin_level = 'super_admin'/i, reason: '锁定目标自然人的超级管理员授权' },
  { file: 'server/src/utils/schemaContract.js', sql: /SELECT\s+\(SELECT COUNT\(\*\)\s+FROM persons p\s+LEFT JOIN organization_memberships/i, reason: '启动时统一身份全局一致性检查' },
  { file: 'server/src/utils/schemaContract.js', sql: /SELECT COUNT\(\*\) AS invalid_count\s+FROM audit_submission_files\s+WHERE signing_key_private/i, reason: '启动时全库阻断任何未完成静态加密迁移的 PDF 签名私钥' },
  { file: 'server/src/utils/schemaContract.js', sql: /SELECT\s+COUNT\(DISTINCT ag\.id\) AS total,\s+COUNT/i, reason: '启动时超级管理员绑定存续检查' }
];

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, output);
    else if (entry.name.endsWith('.js')) output.push(fullPath);
  }
  return output;
}

function isAllowed(relativeFile, sql) {
  return CROSS_ORG_ALLOWLIST.some((entry) => entry.file === relativeFile && entry.sql.test(sql));
}

const findings = [];
for (const file of walk(SERVER_ROOT)) {
  const source = fs.readFileSync(file, 'utf8');
  const relativeFile = path.relative(ROOT, file).replace(/\\/g, '/');
  for (const match of source.matchAll(/([`'"])([\s\S]*?)\1/g)) {
    const sql = match[2].trim();
    if (!/^(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql)) continue;
    const referenced = scopedTables.filter((table) => new RegExp('\\b' + table + '\\b', 'i').test(sql));
    if (!referenced.length || /\borg_id\b/i.test(sql) || isAllowed(relativeFile, sql)) continue;
    findings.push({
      file: relativeFile,
      line: source.slice(0, match.index).split('\n').length,
      tables: referenced.join(', '),
      sql: sql.replace(/\s+/g, ' ').slice(0, 140)
    });
  }
}

console.log(`租户 SQL 审计：${scopedTables.length} 张组织表，未解释的跨组织语句 ${findings.length} 条`);
if (findings.length) console.table(findings);
if (findings.length) process.exitCode = 1;
