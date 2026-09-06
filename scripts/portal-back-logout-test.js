const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  getPortalExitTargetRoute,
  shouldClearAuthenticationOnPortalExit
} = require('../miniprogram/utils/portalExit');

const loginPage = { route: 'subpackages/main/pages/login/login' };
const portalPage = { route: 'subpackages/main/pages/portal/portal' };
const businessPage = { route: 'subpackages/workspace/pages/home/home' };

assert.strictEqual(
  shouldClearAuthenticationOnPortalExit([loginPage, portalPage], portalPage),
  true,
  '门户从页面栈返回登录页时必须退出登录'
);
assert.strictEqual(
  shouldClearAuthenticationOnPortalExit([loginPage], portalPage),
  true,
  '门户卸载后页面栈只剩登录页时必须退出登录'
);
assert.strictEqual(
  shouldClearAuthenticationOnPortalExit([portalPage], portalPage),
  false,
  '关闭唯一门户页面时不能误判为返回登录页'
);
assert.strictEqual(
  shouldClearAuthenticationOnPortalExit([portalPage, businessPage], portalPage),
  false,
  '进入业务页面时不能清除登录状态'
);
assert.strictEqual(
  shouldClearAuthenticationOnPortalExit([loginPage, portalPage, businessPage], portalPage),
  false,
  '门户隐藏在业务页面下方时不能把历史登录页误判为返回目标'
);
assert.strictEqual(getPortalExitTargetRoute([], portalPage), '', '空页面栈不应产生退出目标');

const portalSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'miniprogram', 'subpackages', 'main', 'pages', 'portal', 'portal.js'),
  'utf8'
);
const loginSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'miniprogram', 'subpackages', 'main', 'pages', 'login', 'login.js'),
  'utf8'
);
assert.match(
  portalSource,
  /shouldClearAuthenticationOnPortalExit\(getCurrentPages\(\), this\)/,
  '门户卸载时必须判断是否返回登录页'
);
assert.match(
  portalSource,
  /if \(returningToLogin\) authContext\.clearUnifiedAuthentication\(\)/,
  '门户返回登录页时必须复用完整退出登录清理'
);
assert.match(
  loginSource,
  /wx\.reLaunch\(\{[\s\S]*?url: PORTAL_ROUTE/,
  '登录成功必须重建页面栈，避免真机依赖旧页面渲染回调'
);
assert.doesNotMatch(portalSource, /contextNotice|authSelectionNotice/, '门户不得读取或展示遗留岗位提示');
assert.doesNotMatch(
  fs.readFileSync(path.resolve(__dirname, '..', 'miniprogram/subpackages/main/pages/portal/portal.wxml'), 'utf8'),
  /contextNotice|portal-context-notice/,
  '门户不得保留岗位更新通知容器'
);
assert.doesNotMatch(loginSource, /leavingPortal/, '登录跳转不得先隐藏根节点再等待渲染回调');
assert.match(
  fs.readFileSync(path.resolve(__dirname, '..', 'miniprogram', 'subpackages', 'main', 'pages', 'login', 'login.wxss'), 'utf8'),
  /\.page::before,\s*\.page::after\s*\{[^}]*position:\s*absolute/,
  '登录页装饰层必须随页面销毁，不能固定在视口上遮住门户'
);
assert.match(
  fs.readFileSync(
    path.resolve(__dirname, '..', 'miniprogram', 'subpackages', 'main', 'pages', 'login', 'login.wxml'),
    'utf8'
  ),
  /ui-sheet-overlay"\s+wx:if="\{\{stage !== 'login'\}\}"/,
  '登录页认证弹层必须仅在认证流程中创建'
);
assert.doesNotMatch(
  fs.readFileSync(
    path.resolve(__dirname, '..', 'miniprogram', 'subpackages', 'main', 'pages', 'login', 'login.wxml'),
    'utf8'
  ),
  /root-portal|viewport-portal/,
  '登录页不得注册原生脱离层，否则会覆盖登录后打开的应用服务页面'
);
assert.match(
  portalSource,
  /previousPage\.route === 'subpackages\/main\/pages\/login\/login'[\s\S]*wx\.navigateBack\(\)/,
  '门户显式退出时应返回现有登录页，避免叠加重复登录页'
);
assert.match(
  portalSource,
  /wx\.reLaunch\(\{ url: '\/subpackages\/main\/pages\/login\/login' \}\)/,
  '门户没有历史登录页时应重建干净的登录页'
);

console.log('门户返回登录页退出测试通过。');
