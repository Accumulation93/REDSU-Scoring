'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const copy = require('../miniprogram/locales/zh-CN/stampAuthorization');
let behavior;
let revision = 0;
const requests = [];
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/subpackages/scoring/pages/admin/modules/stampGrantBehavior.js'), 'utf8');
vm.runInNewContext(source, { module: {}, Behavior(value) { behavior = value; return value; }, require(name) {
  if (name.endsWith('stampAuthorization')) return copy;
  if (name.endsWith('orgSession')) return { beginRequest() { return ++revision; }, isRequestCurrent(page, request) { return request === revision; } };
  return { showShortToast() {}, getErrorText(error) { return error.message; } };
} });
(async () => {
  const page = Object.assign({}, behavior.methods, {
    data: Object.assign({}, behavior.data, { stamps: [{ id: 's1', name: '章一', assignedPeople: [{ assignmentId: 'a1', available: true }] }, { id: 's2', name: '章二', assignedPeople: [] }] }),
    setData(values) { Object.assign(this.data, values); },
    async callCloud(name, data) { requests.push({ name, data }); return { status: 'success', candidates: [{ assignmentId: 'a1', personId: 'p1', name: '测试' }] }; },
    async loadStamps() {}
  });
  page.openStampGrants({ currentTarget: { dataset: { id: 's1' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(Array.from(page.data.stampGrantValue), ['a1']);
  page.closeStampGrants();
  assert(!requests.some(row => row.name === 'saveStampGrants'), '取消不得保存');
  page.openStampGrants({ currentTarget: { dataset: { id: 's2' } } });
  await new Promise(resolve => setImmediate(resolve));
  await page.confirmStampGrants({ detail: { keys: ['a1'] } });
  assert.strictEqual(requests.find(row => row.name === 'saveStampGrants').data.stampId, 's2');
  page.openStampGrants({ currentTarget: { dataset: { id: 's1' } } });
  await new Promise(resolve => setImmediate(resolve));
  await page.confirmStampGrants({ detail: { keys: [] } });
  assert.strictEqual(requests[requests.length - 1].data.assignmentIds.length, 0, '确认空选择用于清空');
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/subpackages/scoring/pages/admin/admin.wxml'), 'utf8');
  assert(wxml.includes('bindtap="openStampGrants"') && wxml.includes('visible="{{stampGrantVisible}}"'));
  assert(wxml.includes('list-item list-item-stacked audit-stamp-card'), '印章外卡必须纵向分隔摘要和操作栏');
  assert(!wxml.includes('wx:for="{{item.assignedPeople}}"'), '外卡不得展示可用人明细');
  assert(!source.includes('studentId') && !source.includes('identityId:'), '印章不读取学号、不按身份类别放行');
  console.log('印章管理入口、共享岗位选择、取消、清空和目标隔离测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
