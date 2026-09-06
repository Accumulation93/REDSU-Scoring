const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function hydrateLocale(source, locale, variableName) {
  return Object.entries(locale).reduce((result, entry) => {
    const pattern = new RegExp(`\\b${variableName}\\.${entry[0]}\\b`, 'g');
    return result.replace(pattern, String(entry[1]));
  }, source);
}

const homeCopy = require('../miniprogram/locales/zh-CN/home').text;
const adminCopy = require('../miniprogram/locales/zh-CN/generated/subpackages/scoring/pages/admin/admin');
const homeWxml = hydrateLocale(
  fs.readFileSync(path.join(root, 'miniprogram/subpackages/workspace/pages/home/home.wxml'), 'utf8'),
  homeCopy,
  'copy'
);
const homeWxss = fs.readFileSync(path.join(root, 'miniprogram/subpackages/main/styles/home.wxss'), 'utf8');
const profilePageWxss = fs.readFileSync(path.join(root, 'miniprogram/subpackages/workspace/pages/home/home.wxss'), 'utf8');
const retryStyle = profilePageWxss.match(/\.profile-load-error \.profile-retry-btn\s*\{([^}]+)\}/);
assert(retryStyle && /flex:\s*none;/.test(retryStyle[1]) && /height:\s*auto;/.test(retryStyle[1])
    && ['width', 'min-width', 'max-width'].every((property) => retryStyle[1].includes(property + ': 100%;')),
  '纵向错误卡内的重试按钮必须解除双列 flex-basis，并遵循全宽自然高度契约');
const adminWxmlSource = fs.readFileSync(
  path.join(root, 'miniprogram/subpackages/scoring/pages/admin/admin.wxml'),
  'utf8'
);
const adminWxml = hydrateLocale(
  adminWxmlSource,
  adminCopy,
  'localeCopy'
);
const hrDirectoryControlsWxml = hydrateLocale(
  fs.readFileSync(path.join(root, 'miniprogram/subpackages/scoring/pages/admin/components/hrDirectoryControls/hrDirectoryControls.wxml'), 'utf8'),
  adminCopy,
  'localeCopy'
);
const adminWxss = fs.readFileSync(path.join(root, 'miniprogram/subpackages/scoring/pages/admin/admin.wxss'), 'utf8');
const hrInfoBehavior = fs.readFileSync(path.join(root, 'miniprogram/subpackages/scoring/pages/admin/modules/hrInfoBehavior.js'), 'utf8');
const authPersonnelBehavior = fs.readFileSync(path.join(root, 'miniprogram/subpackages/scoring/pages/admin/modules/authPersonnelBehavior.js'), 'utf8');
const authManagementJs = fs.readFileSync(path.join(root, 'miniprogram/subpackages/org/pages/authManagement/authManagement.js'), 'utf8');
const accountSecurityJs = fs.readFileSync(path.join(root, 'miniprogram/subpackages/org/pages/accountSecurity/accountSecurity.js'), 'utf8');
const identityModel = fs.readFileSync(path.join(root, 'server/src/core/models/unifiedIdentity.js'), 'utf8');
const hrProfileRoute = fs.readFileSync(path.join(root, 'server/src/core/routes/hrProfile.js'), 'utf8');
const portalJs = fs.readFileSync(path.join(root, 'miniprogram/subpackages/main/pages/portal/portal.js'), 'utf8');

assert(
  /\.field-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(homeWxss),
  '普通用户人事信息必须在所有设备使用稳定的两列网格'
);
assert(
  /class="info-block info-block-wide" wx:if="\{\{user\.workGroup\}\}"/.test(homeWxml),
  '未设置工作分工时必须隐藏整行'
);
assert(!/user\.workGroup\s*\|\|\s*['"]未设置['"]/.test(homeWxml), '不得恢复工作分工占位卡');
assert(
  (homeWxml.match(/工作分工（职能组）/g) || []).length >= 1,
  '普通用户人事信息必须显示完整字段名称'
);
assert(/class="hr-member-person"/.test(adminWxml), '成员姓名和学号必须使用稳定的个人信息区');
assert(
  !/hr-member-fact-label/.test(adminWxml),
  '管理端成员卡不得展示属于岗位的部门、身份或工作分工'
);
assert(
  /class="assignment-fact"[\s\S]*?所属部门[\s\S]*?class="assignment-fact"[\s\S]*?身份[\s\S]*?工作分工（职能组）/.test(adminWxml),
  '部门、身份和工作分工必须在岗位详情中分别展示'
);
assert(
  /class="[^"]*modal-body[^"]*detail-body[^"]*ui-dialog-body[^"]*ui-dialog-content[^"]*ui-dialog-content--stack[^"]*ui-dialog-scroll--pane[^"]*"[\s\S]*?scroll-into-view="\{\{detailScrollTarget\}\}"/.test(adminWxml),
  '岗位和补充资料编辑必须位于可滚动详情视口中'
);
assert(
  !/主要岗位|设为主要岗位|isPrimary/.test(adminWxml),
  '人事界面不得保留主要岗位概念'
);
assert(
  /function buildHrProfileRenderState\([\s\S]*?source\.slice\(0, normalizedVisibleCount\)\.map\(toHrProfileListRow\)/.test(hrInfoBehavior)
    && /this\._hrProfileRawRows/.test(hrInfoBehavior)
    && /this\._hrProfileFilteredRows/.test(hrInfoBehavior)
    && /buildHrProfileRenderState\(synchronizedRows\)/.test(hrInfoBehavior),
  '人事列表必须只向视图传递摘要字段，完整补充资料应留在逻辑层供筛选和导出'
);
const createMemberForm = adminWxml.match(/<view class="edit-box" wx:if="\{\{activeTab === 'hrInfo'[\s\S]*?<\/view>\s*<view class="edit-box hr-template-editor"/);
assert(createMemberForm, '应保留新增成员表单');
assert(!/所属部门|工作分工（职能组）/.test(createMemberForm[0]), '新增成员表单只能填写人员基础信息');
assert(/保存并完善资料/.test(createMemberForm[0]), '新增成员后应继续进入详情完善岗位和补充资料');

assert(/activeTab === 'hrInfo' && hrInfoMode === 'profiles'/.test(adminWxml)
    && /bindissueverification="issueSelectedHrVerificationCodes"/.test(adminWxml)
    && /bindrevokeverification="revokeSelectedHrVerificationCodes"/.test(adminWxml)
    && /bindissuerecovery="issueSelectedHrRecoveryCodes"/.test(adminWxml)
    && /bindrevokerecovery="revokeSelectedHrRecoveryCodes"/.test(adminWxml)
    && /disabled="\{\{governanceUnavailable \|\| authActionLoadingKey/.test(hrDirectoryControlsWxml),
  '人员认证和账号恢复的批量操作必须常驻成员资料工具区，并在不可用时原生禁用');
const memberCard = adminWxml.match(/<view class="hr-member-card[\s\S]*?<\/view>\s*<view class="empty-inline"/);
assert(memberCard, '应保留成员资料卡片');
assert(/accountStateText/.test(memberCard[0]), '成员外卡只需展示合并账号状态');
assert(/item\.isFormer \? localeCopy\.hrViewDetail/.test(adminWxmlSource),
  '已离开成员的外卡操作必须显示“查看”，不得暗示仍可编辑');
assert(!/冻结账号|解绑微信|生成认证码|生成恢复码/.test(memberCard[0]),
  '单人账号操作不得暴露在成员外卡');
assert(/governance\.membershipStatus !== 'left'/.test(hrInfoBehavior),
  '已离开成员详情不得请求仅面向在职成员的账号治理接口');
const detailAccountSection = adminWxml.match(/<view class="detail-section hr-account-detail-section[\s\S]*?<view class="identity-overview-section/);
assert(detailAccountSection, '成员详情必须包含账号与认证分区');
assert(!/>当前状态</.test(detailAccountSection[0])
    && !/>微信绑定</.test(detailAccountSection[0])
    && !/>恢复方式</.test(detailAccountSection[0]),
  '成员详情不得用字段卡重复展示顶部账号状态，也不得创造微信绑定或恢复方式重复字段');
assert(/issueHrMemberVerificationCode/.test(detailAccountSection[0])
    && /issueHrMemberRecoveryCode/.test(detailAccountSection[0])
    && /requestAuthAccountFreeze/.test(detailAccountSection[0])
    && /requestHrWechatUnbind/.test(detailAccountSection[0]),
  '单人认证、恢复、冻结和解绑必须位于成员详情');
assert(/hrInfoMode === 'policy'/.test(adminWxml) && /认证设置/.test(adminWxml)
    && !/hrInfoMode === 'auth'/.test(adminWxml)
    && !/activeAuthPersonnelTab/.test(adminWxml),
  '认证设置可以独立显示，但不得保留重复的认证人员目录模式');
assert(/loadHrGovernanceRows/.test(authPersonnelBehavior)
    && /selectedHrMemberIds/.test(authPersonnelBehavior)
    && /patchHrGovernance/.test(authPersonnelBehavior),
  '成员资料必须直接合并账号治理数据并支持局部状态更新');
assert(/\.hr-member-tools-actions\s*\{[\s\S]*?display:\s*grid;[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(adminWxss)
    && /@media\s*\(min-width:\s*520px\)[\s\S]*?\.hr-member-tools-actions\s*\{[\s\S]*?repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(adminWxss),
  '成员批量工具必须在手机双列、Pad 四列并排，不能退化为每个按钮独占一行');
assert(/\.status-chip\s*\{[\s\S]*?border-radius:\s*18rpx;/.test(adminWxss),
  '成员状态标签必须保留柔和圆角，不能退化成方形');
assert(!/操作记录|安全审计/.test(adminWxml), '管理员页面不得向用户展示内部操作记录');
assert(!/label:\s*['"]身份认证['"]|label:\s*['"]账号安全['"]/.test(portalJs),
  '应用服务不得继续展示独立身份认证或账号安全入口');
assert(/id="account-and-login"/.test(homeWxml) && /账号与登录/.test(homeWxml),
  '普通用户账号设置必须并入人事信息');
assert(/tab=hrInfo/.test(authManagementJs), '旧认证管理地址必须重定向到成员资料');
assert(/subApp=hr&section=account/.test(accountSecurityJs), '旧账号安全地址必须重定向到普通用户人事信息');
assert(/const DIRECTORY_LIMIT = 2000/.test(authPersonnelBehavior)
    && /const MAX_AUTH_DIRECTORY_LIMIT = 2000/.test(identityModel),
  '账号与认证目录必须一次加载完整人员范围，不得沿用 100/200 条截断');
assert(/runBatchedAuthAction/.test(authPersonnelBehavior)
    && /batchSize: 50/.test(authPersonnelBehavior)
    && /batchSize: 100/.test(authPersonnelBehavior),
  '全选批量操作必须按服务端安全批次处理全部选中人员');
const freezeMethod = authPersonnelBehavior.match(/async toggleAuthAccountFrozen\(e\)\s*\{[\s\S]*?\r?\n\s*\},\r?\n\r?\n\s*async issueSelectedRecoveryCodes/);
assert(freezeMethod, '应保留账号冻结操作');
assert(!/loadAuthPersonnel|loadAuthAccounts|loadActiveTab/.test(freezeMethod[0]),
  '冻结账号只能局部更新当前人员，不得重新加载整个认证页面');
assert(/personIdentityOverviewModel\.resolvePersonByLegacyHrId/.test(hrProfileRoute)
    && !/unifiedIdentityModel\.resolvePersonByLegacyHrId/.test(hrProfileRoute),
  '历史人事 ID 必须由人员身份概览模型解析，不得调用未导出的统一身份方法');

console.log('hr profile layout tests passed');
