'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
function load(relative, register, overrides) {
  const file = path.join(root, relative);
  const localRequire = createRequire(file);
  let definition;
  const context = { [register]: value => { definition = value; },
    require: request => overrides && overrides[request] || localRequire(request),
    wx: {}, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { definition, context };
}
let openedReport = null;
const { definition, context: componentContext } = load('miniprogram/components/audit-verification-result/audit-verification-result.js', 'Component', {
  '../../utils/dateTime': { formatDetailTime: () => '2026-09-06 08:00:00' },
  '../../utils/auditVerificationReport': { open: result => { openedReport = result; } },
  '../../utils/orgSession': { beginRequest: () => ({}), isRequestCurrent: () => true, invalidateRequests: () => {} }
});
const component = { data: {}, setData(value) { Object.assign(this.data, value); } };
const verifiedChecks = Object.fromEntries(['documentIntegrity', 'cmsSignature', 'receiptChain', 'identityBinding', 'platformCertificate']
  .map(key => [key, { status: 'passed' }]));
component.present = value => definition.methods.present.call(component, value);
for (const status of ['passed', 'failed', 'indeterminate', 'legacy_partial']) {
  definition.methods.present.call(component, { verificationVersion: 2, overallStatus: status, verificationSource: 'uploaded_file',
    files: [{ fileName: 'long-file.pdf', overallStatus: status, checks: verifiedChecks, studentId: 'PROTECTED-STUDENT', personId: 'PROTECTED-PERSON',
      steps: [{ reference: 'random-ref', name: '同名', assignment: '签署时岗位', studentId: 'PROTECTED-STUDENT',
        identityCiphertext: 'PRIVATE-CIPHERTEXT', keyVersion: 'v1', status, round: 1, step: 1 }] }] });
  assert.equal(component.data.view.state, status);
  assert(!JSON.stringify(component.data.view).includes('PROTECTED-'));
  assert(!JSON.stringify(component.data.view).includes('PRIVATE-CIPHERTEXT'));
  assert.equal(component.data.view.files[0].checks.length, 6);
  assert.equal(component.data.view.files[0].steps[0].state, status);
  assert.equal(component.data.view.files[0].summary.length, 4);
  if (status !== 'passed') assert.notEqual(component.data.view.files[0].steps[0].name, '同名');
}
for (const malformed of [null, {}, 'invalid', [null], [{ steps: {} }], [{ cms: [null] }]]) {
  definition.methods.present.call(component, { verificationVersion: 2, overallStatus: 'passed', files: malformed });
  assert.equal(component.data.view.state, 'indeterminate');
}
definition.methods.presentJson.call(component, '{');
assert.equal(component.data.view.state, 'indeterminate');
const { presentVerificationResponse } = require('../../miniprogram/utils/auditVerification');
const transported = presentVerificationResponse({ verificationVersion: 2, overallStatus: 'failed', files: [] });
definition.methods.presentJson.call(component, transported.componentResultJson);
assert.equal(component.data.view.state, 'failed');
definition.methods.present.call(component, { valid: true, files: [] });
assert.equal(component.data.view.state, 'legacy_partial', '旧 valid 不能转换成新版完整通过');
definition.methods.openReport.call(component);
assert.equal(openedReport.valid, true);
assert.equal(definition.properties.report.value, false, '默认界面不显示专业检查');

const standalone = { verificationVersion: 2, verificationSource: 'uploaded_file', verificationScope: 'file_only',
  overallStatus: 'indeterminate', files: [{ overallStatus: 'indeterminate', checks: {
    documentIntegrity: { status: 'passed' }, cmsSignature: { status: 'passed' }, identityBinding: { status: 'indeterminate' }
  } }] };
definition.methods.presentJson.call(component, presentVerificationResponse(standalone).componentResultJson);
assert.equal(component.data.view.title, '文件签名有效');
assert.equal(component.data.view.state, 'indeterminate', '未核实平台身份不得渲染成完整通过');
assert(component.data.view.notice.includes('没有匹配的申请记录'));
assert.equal(component.data.view.files[0].platformVerified, false);
standalone.files[0].certificates = [{ fingerprint: 'a'.repeat(64), derBase64: 'YWJj' }];
standalone.files[0].steps = [{ status: 'passed', name: '冒用平台名称', reference: 'claimed' }];
definition.methods.present.call(component, { ...standalone, overallStatus: 'passed' });
assert.equal(component.data.view.state, 'indeterminate', '缺少必需检查，顶层 passed 也不得误报通过');
assert.equal(component.data.view.files[0].steps.length, 0, '未核实的身份不得展示');
assert.equal(component.data.view.files[0].certificates.length, 0, '不得引导用户信任外来证书');
standalone.files[0].checks.cmsSignature = { status: 'indeterminate', reasonCode: 'pdf_unsigned' };
definition.methods.present.call(component, standalone);
assert.equal(component.data.view.title, '文件未签名');
definition.methods.present.call(component, null);
assert.equal(component.data.view, null);
const fileMarkup = fs.readFileSync(path.join(root, 'miniprogram/components/audit-verification-result/audit-verification-result.wxml'), 'utf8');
assert(!fileMarkup.includes('check.reasonCode'), '报告不得直接展示系统原因码');
assert(!fileMarkup.includes('expanded'), '技术报告不是默认页内展开区');
assert(fileMarkup.includes('bindtap="openReport"'));
for (const className of ['crypto-step-header', 'crypto-person-reference', 'crypto-organization', 'crypto-assignment', 'crypto-identity']) {
  assert(fileMarkup.includes(className), '逐步身份需要独立语义层级：' + className);
}
assert(!/avatar|initial/i.test(fileMarkup), '验签人不得恢复姓氏装饰头像');
assert(fileMarkup.indexOf('copy.adobeTrustNotice') > fileMarkup.indexOf('wx:if="{{report}}" class="crypto-details"'), 'Adobe 信任说明仅在报告内');
assert(fileMarkup.includes('wx:if="{{report && file.platformVerified}}" class="crypto-note">{{copy.hostedNotice}}'));
assert(fileMarkup.includes('wx:if="{{file.platformVerified}}" class="crypto-details"'));
for (const page of ['miniprogram/subpackages/audit/pages/verification/verification', 'miniprogram/subpackages/scoring/pages/admin/admin',
  'miniprogram/subpackages/audit/pages/verificationReport/verificationReport']) {
  const json = JSON.parse(fs.readFileSync(path.join(root, page + '.json'), 'utf8'));
  assert(json.usingComponents['audit-verification-result']);
  const markup = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
  assert(markup.includes('<audit-verification-result'));
  assert(markup.includes('result-json="{{'));
}
let written, shared, removed;
componentContext.wx = { env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({ writeFile: options => { written = options; options.success(); }, unlink: options => { removed = options.filePath; } }),
  shareFileMessage: options => { shared = options; options.success(); } };
const certificate = { fingerprint: 'a'.repeat(64), derBase64: 'YWJj' };
definition.methods.present.call(component, { verificationVersion: 2, overallStatus: 'passed', files: [{ overallStatus: 'passed', checks: verifiedChecks, certificates: [certificate] }] });
definition.methods.exportCertificate.call(component, { currentTarget: { dataset: { file: '0', certificate: '0' } } });
assert.equal(written.data, certificate.derBase64);
assert.equal(written.encoding, 'base64');
assert(shared.fileName.endsWith('.cer'));
assert.equal(removed, written.filePath);
assert.equal(component.data.exporting, false);
let exportErrorCount = 0;
componentContext.wx.showModal = () => { exportErrorCount += 1; };
componentContext.wx.shareFileMessage = options => {
  options.fail({ errMsg: 'shareFileMessage:fail unavailable' });
};
definition.methods.exportCertificate.call(component, { currentTarget: { dataset: { file: '0', certificate: '0' } } });
assert.equal(exportErrorCount, 1, '分享不可用必须反馈失败，不得静默结束');
assert.equal(component.data.exporting, false);
componentContext.wx.shareFileMessage = options => {
  options.fail({ errMsg: 'shareFileMessage:fail cancel' });
};
definition.methods.exportCertificate.call(component, { currentTarget: { dataset: { file: '0', certificate: '0' } } });
assert.equal(exportErrorCount, 1, '主动取消不提示失败');
const exportEvent = { currentTarget: { dataset: { file: '0', certificate: '0' } } };
let saved = 0;
componentContext.wx.saveFileToDisk = options => {
  assert.equal(removed, null, '备用保存完成前不能删除临时证书');
  saved += 1; options.success();
};
removed = null;
componentContext.wx.shareFileMessage = options => options.fail({ errMsg: 'shareFileMessage:fail unsupported' });
definition.methods.exportCertificate.call(component, exportEvent);
assert.equal(saved, 1);
assert.equal(removed, written.filePath);
assert.equal(exportErrorCount, 1, '备用保存成功不显示错误');
removed = null;
componentContext.wx.getDeviceInfo = () => ({ platform: 'windows' });
componentContext.wx.shareFileMessage = () => { throw new Error('电脑保存成功不应再次分享'); };
definition.methods.exportCertificate.call(component, exportEvent);
assert.equal(saved, 2, '电脑优先直接保存');
componentContext.wx.getDeviceInfo = () => ({ platform: 'android' });
componentContext.wx.shareFileMessage = options => options.fail({ errMsg: 'cancel' });
definition.methods.exportCertificate.call(component, exportEvent);
assert.equal(saved, 2, '用户取消后不得再次打开保存');
removed = null;
componentContext.wx.shareFileMessage = () => { throw new Error('unsupported'); };
definition.methods.exportCertificate.call(component, exportEvent);
assert.equal(saved, 3, '原生能力同步异常也应尝试备用导出');
let clipboard;
componentContext.wx.setClipboardData = options => { clipboard = options.data; options.success(); };
definition.methods.copyCertificate.call(component, exportEvent);
assert(clipboard.startsWith('-----BEGIN CERTIFICATE-----\n'));
assert(clipboard.endsWith('\n-----END CERTIFICATE-----\n'));
assert.equal(Buffer.from(clipboard.split('\n').slice(1, -2).join(''), 'base64').toString('base64'), certificate.derBase64);
assert(!clipboard.includes('PRIVATE KEY'));
console.log('统一验签组件测试通过：用户摘要、独立报告、原因码隐藏、隐私白名单、证书导出与两端注册');
