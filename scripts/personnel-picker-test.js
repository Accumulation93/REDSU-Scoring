'use strict';

const assert = require('assert');
const model = require('../miniprogram/components/personnel-picker/personnelPickerModel');

const people = [{
  id: 'person-1',
  personId: 'person-1',
  name: '测试人员',
  studentId: '20260001',
  eligibleAssignments: [
    { assignmentId: 'a-1', assignmentLabel: '负责人 · 部门甲', departmentName: '部门甲', identityCategoryName: '负责人', workGroupName: '甲组' },
    { assignmentId: 'a-2', assignmentLabel: '成员 · 部门乙', departmentName: '部门乙', identityCategoryName: '成员', workGroupName: '乙组' }
  ]
}];

const assignments = model.normalizeOptions(people, 'assignment');
assert.deepStrictEqual(assignments.map(function(item) { return item.selectionKey; }), ['a-1', 'a-2']);
assert.strictEqual(model.filterOptions(assignments, { department: '部门甲', identity: '成员', workGroup: '', keyword: '' }).length, 0,
  '部门和身份必须命中同一岗位元组');
assert.strictEqual(model.filterOptions(assignments, { department: '部门甲', identity: '负责人', workGroup: '甲组', keyword: '测试' }).length, 1);
assert.deepStrictEqual(model.selectedKeys([{ assignmentId: 'a-1' }, 'a-1', { assignmentId: 'a-2' }], 'assignment'), ['a-1', 'a-2']);
assert.deepStrictEqual(model.toggleSelection([], 'a-1', false), ['a-1'], '单选应写入唯一草稿项');
assert.deepStrictEqual(model.toggleSelection(['a-1'], 'a-2', false), ['a-2'], '单选新项应替换旧草稿项');
assert.deepStrictEqual(model.toggleSelection(['a-1'], 'a-2', true), ['a-1', 'a-2'], '多选应追加草稿项');
assert.deepStrictEqual(model.toggleSelection(['a-1', 'a-2'], 'a-1', true), ['a-2'], '再次点击应取消单项');
assert.deepStrictEqual(model.toggleSelection(['a-1'], 'a-1', true), [], '取消最后一项后应允许确认空数组');
assert.strictEqual(
  model.selectionSummary(assignments, '已选 2 项'),
  '已选 2 项 · 测试人员 · 负责人 · 部门甲；测试人员 · 成员 · 部门乙',
  '岗位摘要必须同时展示人数、姓名和岗位'
);

const persons = model.normalizeOptions(people, 'person');
assert.strictEqual(persons.length, 1);
assert.strictEqual(persons[0].assignments.length, 2);
assert.strictEqual(model.filterOptions(persons, { department: '部门乙', identity: '成员', workGroup: '乙组', keyword: '' }).length, 1);

const componentSource = require('fs').readFileSync(require('path').join(__dirname, '../miniprogram/components/personnel-picker/personnel-picker.js'), 'utf8');
assert.match(componentSource, /draftKeys/, '组件必须在内部维护临时选择');
assert.match(componentSource, /triggerEvent\('confirm',[\s\S]*keys:/, '确认事件必须回传 keys 与 items');
assert.match(componentSource, /cancelSelection:[\s\S]*triggerEvent\('cancel'\)/, '取消弹窗不得写回页面值');

// 展开已选区只改变展示状态，不能隐式改写草稿或通知业务页面。
let definition;
require('vm').runInNewContext(componentSource, {
  require: function(id) { return id.includes('personnelPickerModel') ? model : require('../miniprogram/locales/zh-CN/personnelPicker'); },
  Component: function(value) { definition = value; }
});
const events = [];
const instance = Object.assign({
  data: Object.assign({}, definition.data),
  properties: { value: ['a-1'], options: people, selectionLevel: 'assignment', multiple: true },
  setData: function(patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this); },
  triggerEvent: function(name, payload) { events.push({ name, payload }); }
}, definition.methods);
instance._resetDraft();
assert.strictEqual(instance.data.selectedExpanded, false);
instance.toggleSelectedExpanded();
assert.strictEqual(instance.data.selectedExpanded, true);
assert.deepStrictEqual(Array.from(instance.data.draftKeys), ['a-1']);
instance.toggleOption({ currentTarget: { dataset: { key: 'a-1' } } });
assert.strictEqual(instance.data.selectedItems.length, 0, '展开列表中取消最后一项应更新摘要');
assert.strictEqual(events.length, 0, '展开与取消单项均不得通知业务保存');
instance._resetDraft();
assert.strictEqual(instance.data.selectedExpanded, false, '重开时恢复紧凑摘要');
assert.deepStrictEqual(Array.from(instance.data.draftKeys), ['a-1'], '未确认的取消不能覆盖外部值');

console.log('共享人员选择器逻辑测试通过');

const markup = require('fs').readFileSync(require('path').join(__dirname, '../miniprogram/components/personnel-picker/personnel-picker.wxml'), 'utf8');
assert(!/selection-card-toggle|personnel-picker-avatar|studentId|_initial/.test(markup), '人员卡不得恢复独立勾选、姓氏头像或学号');
assert.strictEqual((markup.match(/catchtap="toggleOption"/g) || []).length, 2, '候选区与已选区均由整卡切换选择');
assert(assignments.every(item => !Object.hasOwnProperty.call(item, 'studentId')));
assert.strictEqual(model.filterOptions(assignments, { keyword: '20260001' }).length, 0, '不得通过学号搜索旁路识别人');
instance.toggleOption({ currentTarget: { dataset: { key: 'a-2' } } });
instance.cancelSelection();
assert.strictEqual(events[0].name, 'cancel');
assert.deepStrictEqual(instance.properties.value, ['a-1'], '取消弹窗不得改写外部值');
instance._resetDraft();
instance.toggleOption({ currentTarget: { dataset: { key: 'a-1' } } });
instance.confirmSelection();
assert.strictEqual(events[1].payload.keys.length, 0, '整卡取消全部后允许确认空数组');

for (const file of ['miniprogram/subpackages/scoring/pages/admin/admin.wxml', 'miniprogram/subpackages/venue/pages/venueManage/venueManage.wxml']) {
  const content = require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8');
  assert(!content.includes('selection-card-toggle'), file + ' 不得恢复独立选择控件');
  assert(content.includes('selection-option-card-selected'), file + ' 必须使用整卡选中状态');
}
