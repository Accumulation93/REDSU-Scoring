const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const adminRoot = path.resolve(__dirname, '..');
const wxml = fs.readFileSync(path.join(adminRoot, 'admin.wxml'), 'utf8');
const directoryControlsWxml = fs.readFileSync(path.join(adminRoot, 'components', 'hrDirectoryControls', 'hrDirectoryControls.wxml'), 'utf8');
const deletionDialogWxml = fs.readFileSync(path.join(adminRoot, 'components', 'hrPermanentDeletionDialog', 'hrPermanentDeletionDialog.wxml'), 'utf8');
const hrBehavior = fs.readFileSync(path.join(adminRoot, 'modules', 'hrInfoBehavior.js'), 'utf8');
const authBehavior = fs.readFileSync(path.join(adminRoot, 'modules', 'authPersonnelBehavior.js'), 'utf8');
const resultBehavior = fs.readFileSync(path.join(adminRoot, 'modules', 'resultBehavior.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(adminRoot, 'admin.js'), 'utf8');
const adminWxss = fs.readFileSync(path.join(adminRoot, 'admin.wxss'), 'utf8');
const appJs = fs.readFileSync(path.resolve(adminRoot, '../../../../app.js'), 'utf8');
const submissionDetailJs = fs.readFileSync(path.resolve(adminRoot, '../../../audit/pages/submissionDetail/submissionDetail.js'), 'utf8');
const copyAuditJs = fs.readFileSync(path.resolve(adminRoot, '../../../../../scripts/user-visible-copy-audit.js'), 'utf8');
const { buildHrProfileFilterOptions, emptyHrProfileFilters, applyHrProfileFilters } = require('../modules/adminUtils');
const dateTime = require('../../../../../utils/dateTime');

test('岗位编辑器不再展示或提交自由文本岗位名称', () => {
  assert.doesNotMatch(wxml, /membershipAssignmentForm\.title|data-field="title"|assignmentItem\.title/);
  const saveStart = hrBehavior.indexOf("callCloud('saveMembershipAssignment'");
  const saveCall = hrBehavior.slice(saveStart, hrBehavior.indexOf('\n        });', saveStart));
  assert.doesNotMatch(saveCall, /\.\.\.form|title\s*:/);
});

test('账号高危控件只由全局账号治理权限控制', () => {
  assert.doesNotMatch(wxml, /wx:if="\{\{canRecoverAccounts && detailHrGovernance/);
  assert.match(wxml, /canGlobalAccountManage && detailHrGovernance\.canIssueRecovery/);
  assert.match(wxml, /canGlobalAccountManage && detailHrGovernance\.personId/);
  assert.match(authBehavior, /async toggleAuthAccountFrozen\(e\) \{\s+if \(!this\.data\.canGlobalAccountManage\) return;/);
  assert.match(hrBehavior, /async unbindHrWechat\(e\) \{\s+if \(!this\.data\.canGlobalAccountManage\) return;/);
});

test('无账号成员可初始化口令且保存表单使用标准详情按钮规格', () => {
  assert.match(hrBehavior, /canGlobalAccountManage && governance\.personId/);
  assert.doesNotMatch(hrBehavior, /canGlobalAccountManage && governance\.personId && governance\.accountId/);
  const formStart = wxml.indexOf('class="hr-account-security-form"');
  const formEnd = wxml.indexOf('</view>\n            </view>', formStart);
  const form = wxml.slice(formStart, formEnd);
  assert.match(form, /button-row hr-account-security-form-actions/);
  assert.match(form, /localeCopy\.savePassphrase/);
  assert.doesNotMatch(form, /compact-action/);
  assert.match(authBehavior, /'detailHrSecurity\.accountExists': true/);
  assert.match(authBehavior, /'detailHrGovernance\.accountId': String\(result\.accountId/);
});

test('认证码和恢复码撤销冻结目标并统一经过受控确认', () => {
  assert.match(wxml, /wx:if="\{\{authMemberConfirmVisible\}\}"/);
  assert.match(authBehavior, /function freezeCredentialTargets\(rows\)/);
  assert.match(authBehavior, /_authMemberConfirmPayload = Object\.freeze\(\{/);
  assert.match(authBehavior, /revokeHrMemberVerificationCode\(e\) \{\s+if \(!this\.data\.canVerifyIdentity\) return;/);
  assert.match(authBehavior, /revokeSelectedHrVerificationCodes\(\) \{\s+if \(!this\.data\.canVerifyIdentity\) return;/);
  assert.match(authBehavior, /revokeHrMemberRecoveryCode\(e\) \{\s+if \(!this\.data\.canGlobalAccountManage\) return;/);
  assert.match(authBehavior, /revokeSelectedHrRecoveryCodes\(\) \{\s+if \(!this\.data\.canGlobalAccountManage\) return;/);
  assert.match(authBehavior, /_openCredentialRevokeConfirm\('verification', \[row\], false\)/);
  assert.match(authBehavior, /_openCredentialRevokeConfirm\('verification', rows, true\)/);
  assert.match(authBehavior, /_openCredentialRevokeConfirm\('recovery', \[row\], false\)/);
  assert.match(authBehavior, /_openCredentialRevokeConfirm\('recovery', rows, true\)/);
  assert.match(authBehavior, /closeAuthMemberConfirm\(\) \{[\s\S]*this\._authMemberConfirmPayload = null;/);
  assert.match(authBehavior, /action === 'verification-code-revoke'[\s\S]*!this\.data\.canVerifyIdentity/);
  assert.match(authBehavior, /action === 'recovery-code-revoke'[\s\S]*!this\.data\.canGlobalAccountManage/);
  assert.match(authBehavior, /async _revokeHrVerificationTargets\(targets, isBatch\) \{\s+if \(!this\.data\.canVerifyIdentity/);
  assert.match(authBehavior, /async _revokeHrRecoveryTargets\(targets, isBatch\) \{\s+if \(!this\.data\.canGlobalAccountManage/);
  const openStart = authBehavior.indexOf('_openCredentialRevokeConfirm(kind, rows, isBatch)');
  const executeStart = authBehavior.indexOf('async _revokeHrVerificationTargets', openStart);
  const closeStart = authBehavior.indexOf('closeAuthMemberConfirm()');
  const confirmStart = authBehavior.indexOf('confirmAuthMemberAction()', closeStart);
  assert.doesNotMatch(authBehavior.slice(openStart, executeStart), /callFunction|runBatchedAuthAction/);
  assert.doesNotMatch(authBehavior.slice(closeStart, confirmStart), /callFunction|runBatchedAuthAction/);
});

test('姓名和学号仅由全局账号治理者通过受控纠错修改', () => {
  assert.match(wxml, /disabled="\{\{!canGlobalAccountManage \|\| detailHrReadOnly\}\}" data-field="_name"/);
  assert.match(wxml, /disabled="\{\{!canGlobalAccountManage \|\| detailHrReadOnly\}\}" data-field="_studentId"/);
  assert.match(hrBehavior, /onDetailBasicFieldInput\(e\) \{\s+if \(!this\.data\.canGlobalAccountManage \|\| this\.data\.detailHrReadOnly\) return;/);
  assert.match(hrBehavior, /hasBasicIdentityChange[\s\S]*if \(!this\.data\.canGlobalAccountManage\) return;[\s\S]*previewPersonIdentityCorrection/);
});

test('自然人合并前先保存本次补充资料且失败时中止合并', () => {
  const helperStart = hrBehavior.indexOf('async _saveCorrectionProfileBeforeMerge(preview)');
  const mergeStart = hrBehavior.indexOf('if (preview.mergeRequired)', helperStart);
  const mergeCall = hrBehavior.indexOf("callCloud('mergePersons'", mergeStart);
  assert.ok(helperStart >= 0);
  assert.match(hrBehavior.slice(helperStart, mergeStart), /callCloud\('saveHrPersonFull'/);
  assert.match(hrBehavior.slice(helperStart, mergeStart), /preview && preview\.current/);
  assert.ok(hrBehavior.indexOf('await this._saveCorrectionProfileBeforeMerge(preview)', mergeStart) < mergeCall);
  assert.match(hrBehavior.slice(mergeStart, mergeCall), /if \(!profileSaved\) return;/);
});

test('资料驳回必须通过受控原因弹窗提交非空原因', () => {
  assert.match(wxml, /profileRejectVisible/);
  assert.match(wxml, /bindinput="onProfileRejectReasonInput"/);
  assert.match(hrBehavior, /const reason = String\(this\.data\.profileRejectReason \|\| ''\)\.trim\(\);/);
  assert.match(hrBehavior, /action: 'reject', reason/);
  assert.match(hrBehavior, /profileRejectHrId/);
  assert.match(hrBehavior, /\{ hrId, studentId, action: 'reject', reason \}/);
});

test('资料审核与账号状态使用稳定的人事事实源', () => {
  assert.match(hrBehavior, /\{ hrId, studentId, action: 'approve' \}/);
  assert.match(authBehavior, /auth.status === 'verified'/);
  assert.doesNotMatch(authBehavior, /else if \(bindStatus ===/);
});

test('离任成员并入成员资料目录且详情只读并可重新加入', () => {
  assert.doesNotMatch(wxml, /data-mode="former"/);
  assert.doesNotMatch(hrBehavior, /callCloud\('listFormerHrMembers'/);
  assert.match(wxml, /item\.membershipStatusText/);
  assert.match(wxml, /detailHrReadOnly/);
  assert.match(wxml, /catchtap="reactivateHrMembership"/);
  assert.match(hrBehavior, /callCloud\('reactivateHrMembership'/);
});

test('成员目录筛选位于语义控制卡并提供字段搜索、多选筛选和排序', () => {
  assert.match(wxml, /<hr-directory-controls/);
  assert.match(directoryControlsWxml, /section-control-card[^\n]*hr-directory-control-card/);
  assert.match(directoryControlsWxml, /bindchange="emitSearchFieldChange"/);
  assert.match(directoryControlsWxml, /bindchange="emitFilterGroupChange"/);
  assert.match(directoryControlsWxml, /bindchange="emitSortChange"/);
  assert.match(directoryControlsWxml, /class="hr-member-tools"/);
  assert.doesNotMatch(wxml, /class="hr-member-tools"/);
});

test('成员详情异步请求必须以请求序号和当前成员双重隔离', () => {
  assert.match(hrBehavior, /const detailRequestId = Number\(this\._hrPersonDetailRequestId \|\| 0\) \+ 1;/);
  assert.match(hrBehavior, /this\._hrPersonDetailRequestId !== detailRequestId/);
  assert.match(hrBehavior, /String\(this\.data\.detailHrId \|\| ''\) !== hrId/);
  assert.match(hrBehavior, /async loadPersonIdentities\(hrId, detailRequestId\)/);
  assert.match(authBehavior, /async loadDetailHrSecurity\(personId, detailRequestId\)/);
  assert.match(authBehavior, /const currentGovernance = this\.data\.detailHrGovernance \|\| \{\};[\s\S]*String\(currentGovernance\.personId \|\| ''\) !== expectedPersonId/);
});

test('永久删除必须经过引用预检且彻底删除要求学号确认', () => {
  assert.match(wxml, /data-scope="membership"[\s\S]*catchtap="previewPermanentHrDeletion"/);
  assert.match(wxml, /wx:if="\{\{isSuperAdmin\}\}" data-scope="person"/);
  assert.match(wxml, /<hr-permanent-deletion-dialog/);
  assert.match(wxml, /blockers="\{\{hrPermanentDeletionBlockers\}\}"/);
  assert.match(wxml, /cleanup="\{\{hrPermanentDeletionCleanup\}\}"/);
  assert.match(wxml, /cleanup-accepted="\{\{hrPermanentDeletionCleanupAccepted\}\}"/);
  assert.match(wxml, /result="\{\{hrPermanentDeletionResult\}\}"/);
  assert.match(wxml, /confirmation="\{\{hrPermanentDeletionConfirmation\}\}"/);
  assert.match(deletionDialogWxml, /preview\.eligible/);
  assert.match(deletionDialogWxml, /preview\.organizations/);
  assert.match(deletionDialogWxml, /bindchange="emitCleanupAcceptance"/);
  assert.match(deletionDialogWxml, /cleanup\.length && !cleanupAccepted/);
  assert.match(deletionDialogWxml, /result\.affectedRules/);
  assert.match(hrBehavior, /callCloud\('previewHrMemberDeletion'/);
  assert.match(hrBehavior, /scope === 'person' \? 'deletePersonPermanently' : 'deleteHrMembershipPermanently'/);
  assert.match(hrBehavior, /expectedVersion: preview\.version/);
  assert.match(hrBehavior, /clientRequestId: this\._hrPermanentDeletionClientRequestId/);
  assert.match(hrBehavior, /this\._hrPermanentDeletionClientRequestId = createPermanentDeletionClientRequestId\(\)/);
  assert.match(hrBehavior, /closePermanentHrDeletion\(\)[\s\S]*this\._hrPermanentDeletionClientRequestId = ''/);
  assert.match(hrBehavior, /acceptCleanup: !cleanupRequired \|\| this\.data\.hrPermanentDeletionCleanupAccepted/);
  assert.match(hrBehavior, /result\.result && typeof result\.result === 'object'/);
  assert.match(hrBehavior, /deletionResult\.cleanupCounts/);
  assert.match(hrBehavior, /deletionResult\.affectedRules/);
  assert.match(hrBehavior, /deletionResult\.disabledRules/);
  assert.match(hrBehavior, /resetHrProfileFilters\(\) \{\s+this\.clearHrInfoKeywordTimer\(\);/);
  assert.match(wxml, /assignmentItem\.historical[\s\S]*localeCopy\.hrHistoricalPosition/);
});

test('列表与详情时间使用共享精度且全局复核状态不污染具体记录', () => {
  assert.match(
    resultBehavior,
    /submittedAtText: formatAuditTime\(normalizedItem\.submittedAt, normalizedItem\.submittedAtReviewStatus\)/
  );
  assert.match(
    resultBehavior,
    /submittedAtText: formatAuditDetailTime\(\s*result\.recordDetail\.submittedAt,\s*result\.recordDetail\.submittedAtReviewStatus\s*\)/
  );
  assert.match(
    submissionDetailJs,
    /signedAtText: formatAuditDetailTime\(item\.signedAt, item\.signedAtReviewStatus\)/
  );
  assert.match(
    authBehavior,
    /lastSeenText: item\.lastSeenAt\s*\? formatAuditDetailTime\(item\.lastSeenAt, item\.lastSeenAtReviewStatus\)/
  );

  dateTime.setSystemTimezoneConfig(8, 'test-version', true, 'review-version');
  const utcSample = new Date(Date.UTC(2026, 7, 23, 11, 10, 16)).toISOString();
  assert.equal(dateTime.formatListTime(utcSample), '2026-08-23 19:10');
  assert.match(
    dateTime.formatListTime(utcSample, { reviewStatus: 'review_required' }),
    /历史时区待核对/
  );
});

test('系统时区变化会刷新真实当前页而不是遍历空钩子', () => {
  assert.match(appJs, /const page = pages\.length \? pages\[pages\.length - 1\] : null;/);
  assert.match(appJs, /else if \(typeof page\.onShow === 'function'\)/);
  assert.match(adminJs, /onSystemTimezoneChanged\(\) \{[\s\S]*_refreshActiveOrganizationTab\(this\.data\.activeTab\)/);
  assert.match(submissionDetailJs, /onSystemTimezoneChanged\(\) \{[\s\S]*return this\.loadDetail\(\)/);
});

test('认证治理降级目录可进入详情并构造完整岗位元组', () => {
  assert.match(hrBehavior, /function buildGovernanceAssignments\(item\)/);
  assert.match(hrBehavior, /item\.assignments\.filter\(\(assignment\) => assignment && assignment\.assignmentId\)/);
  assert.doesNotMatch(hrBehavior, /legacy-department:|legacy-identity:|legacy-work-group:/);
  assert.match(authBehavior, /auth\.hasActiveBinding \? 'bound' : 'unbound'/);
  assert.match(authBehavior, /wxBindStatus: bindStatus/);
  assert.match(hrBehavior, /canOpenGovernanceDetail = this\.data\.canVerifyIdentity[\s\S]*this\.data\.canGlobalAccountManage/);
  assert.match(wxml, /canBrowseHrInfo \|\| canVerifyIdentity \|\| canRecoverAccounts \|\| canGlobalAccountManage/);
  assert.match(adminJs, /canVerifyIdentity \|\| this\.data\.canRecoverAccounts \|\| this\.data\.canGlobalAccountManage/);
});

test('离任详情展示历史字段与资料审核历史且历史字段不可编辑', () => {
  assert.match(hrBehavior, /buildHistoricalProfileFields\(result\.historicalFields\)/);
  assert.match(hrBehavior, /buildProfileReviewHistory\(result\.reviewHistory\)/);
  assert.match(wxml, /detailHrHistoricalFields\.length[\s\S]*hrHistoricalProfileFields/);
  assert.match(wxml, /detailHrReviewHistory\.length[\s\S]*hrProfileReviewHistory/);
  const historicalSection = wxml.slice(
    wxml.indexOf('detailHrHistoricalFields.length'),
    wxml.indexOf('detailHrReviewHistory.length')
  );
  assert.doesNotMatch(historicalSection, /bindinput|bindchange|<input|<picker/);
});

test('数字型 placeholder 必须通过 locale，审计器可识别回归', () => {
  assert.match(copyAuditJs, /numeric-placeholder-must-use-locale/);
  assert.match(copyAuditJs, /fragment\.attribute === 'placeholder' && \/\\d\//);
  assert.doesNotMatch(wxml, /placeholder=["'](?:0|1|10|100|0\.5|00:00|23:59)["']/);
});

test('离任详情岗位与管理员操作在模板和方法层均只读', () => {
  assert.match(wxml, /!detailHrReadOnly && orgItem\.canEditAssignments/);
  assert.match(wxml, /!detailHrReadOnly && orgItem\.canAddAdmin/);
  assert.match(wxml, /!detailHrReadOnly && orgItem\.canEditAdmins/);
  ['startCreateMembershipAssignment', 'editMembershipAssignment', 'saveMembershipAssignment',
    'deleteMembershipAssignment', 'addPersonAdminIdentity', 'addPersonSuperAdmin',
    'removePersonAdminIdentity', 'confirmIdentityAction'].forEach((methodName) => {
    const methodStart = hrBehavior.indexOf(methodName + '(');
    assert.ok(methodStart >= 0, methodName);
    assert.match(hrBehavior.slice(methodStart, methodStart + 220), /detailHrReadOnly/);
  });
});

test('永久删除预检冻结目标并以请求序号隔离迟到响应', () => {
  assert.match(wxml, /disabled="\{\{hrPermanentDeletionLoading\}\}"[\s\S]*catchtap="previewPermanentHrDeletion"/);
  assert.match(hrBehavior, /const requestSeq = Number\(this\._hrPermanentDeletionPreviewSeq \|\| 0\) \+ 1;/);
  assert.match(hrBehavior, /this\._hrPermanentDeletionPreviewSeq !== requestSeq/);
  assert.match(hrBehavior, /hrPermanentDeletionTarget: target/);
  assert.match(hrBehavior, /const target = this\.data\.hrPermanentDeletionTarget;/);
  assert.match(hrBehavior, /hrId: target\.hrId[\s\S]*personId: target\.personId[\s\S]*organizationId: target\.organizationId/);
});

test('重新加入使用可禁用按钮并在行为层阻止重复提交', () => {
  assert.match(wxml, /<button class="secondary-btn compact-action hr-action-chip[\s\S]*disabled="\{\{reactivatingHrId\}\}"[\s\S]*catchtap="reactivateHrMembership"/);
  assert.match(hrBehavior, /if \(!hrId \|\| !this\.data\.canManageHrPeople \|\| this\.data\.reactivatingHrId\) return;/);
});

test('岗位筛选使用字典 ID 且同名职能组按部门区分', () => {
  const rows = [{
    assignments: [
      { departmentId: 'department-a', department: '甲部门', identityCategoryId: 'identity-a', identityCategoryName: '成员', workGroupId: 'group-a', workGroup: '项目组' },
      { departmentId: 'department-b', department: '乙部门', identityCategoryId: 'identity-a', identityCategoryName: '成员', workGroupId: 'group-b', workGroup: '项目组' }
    ],
    membershipStatus: 'active', assignmentCount: 2, auditStatus: 'none', accountState: 'unbound', wxBindStatus: 'unbound'
  }];
  const options = buildHrProfileFilterOptions(rows);
  assert.deepEqual(options.workGroups.map((item) => item.value).sort(), ['group-a', 'group-b']);
  assert.deepEqual(options.workGroups.map((item) => item.label).sort(), ['项目组 · 乙部门', '项目组 · 甲部门'].sort());
  const filters = emptyHrProfileFilters();
  filters.departments = ['department-a'];
  filters.workGroups = ['group-b'];
  assert.equal(applyHrProfileFilters(rows, filters).length, 0);
  filters.workGroups = ['group-a'];
  assert.equal(applyHrProfileFilters(rows, filters).length, 1);
});

test('手机账号长按钮最多两列', () => {
  const phoneStart = adminWxss.lastIndexOf('@media (max-width: 519px)');
  const phoneBlock = adminWxss.slice(phoneStart, adminWxss.indexOf('@media (min-width: 520px)', phoneStart));
  assert.match(phoneBlock, /\.hr-account-actions[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(phoneBlock, /\.hr-account-actions[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
});
