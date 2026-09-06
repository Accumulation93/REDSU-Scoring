'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const file = path.resolve(__dirname, '../../miniprogram/utils/auditVerificationReport.js');
const app = { globalData: {} };
let current = true, tick = 1, target;
const context = { module: { exports: {} }, getApp: () => app, wx: { showToast() {} }, Date: { now: () => tick },
  require: name => name === './orgSession' ? { getSnapshot: () => ({ orgId: 'a' }), isCurrent: () => current }
    : name === './trustedNavigation' ? { navigateToTrustedRoute: (url, callbacks) => { target = { url, callbacks }; } }
      : createRequire(file)(name) };
vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
const transfer = context.module.exports;
transfer.open({ overallStatus: 'failed' });
assert.equal(target.url, '/subpackages/audit/pages/verificationReport/verificationReport');
assert.equal(JSON.parse(transfer.take().json).overallStatus, 'failed');
assert.equal(transfer.take(), null, '交接只能消费一次');
transfer.open({}); current = false;
assert.equal(transfer.take(), null, '换组织或角色后失效');
current = true; transfer.open({}); tick += 60001;
assert.equal(transfer.take(), null, '交接超时失效');
transfer.open({}); target.callbacks.fail();
assert.equal(transfer.take(), null, '导航失败不遗留报告');
const pageFile = path.resolve(__dirname, '../../miniprogram/subpackages/audit/pages/verificationReport/verificationReport.js');
let pageDefinition, changed = true, invalidations = 0;
const report = { snapshot: { orgId: 'a' }, json: '{"overallStatus":"passed"}' };
vm.runInNewContext(fs.readFileSync(pageFile, 'utf8'), {
  Page: value => { pageDefinition = value; }, wx: { setNavigationBarTitle() {} },
  require: name => name.endsWith('/orgSession') ? {
    consume: () => ({ changed }), invalidateRequests: () => { invalidations++; }, isCurrent: () => current
  } : name.endsWith('/auditVerificationReport') ? { take: () => report } : createRequire(pageFile)(name)
}, { filename: pageFile });
const page = Object.assign({ setData(value) { Object.assign(this.data, value); } }, pageDefinition);
page.data = Object.assign({}, pageDefinition.data);
current = true;
page.onLoad(); page.onShow();
assert.equal(page.data.resultJson, report.json, '首次消费组织版本不能丢失已核实报告');
assert.equal(invalidations, 1);
changed = false; page.onShow();
assert.equal(invalidations, 1, '同一组织重新显示保持报告');
current = false; changed = true; page.onShow();
assert.equal(page.data.resultJson, '', '切换身份后清除报告');
assert.equal(page._reportSnapshot, null);
page.onUnload();
assert.equal(invalidations, 3, '切换与离页都使旧请求失效');
console.log('独立验证报告测试通过：可信路由、一次消费、超时及组织/账号隔离');
