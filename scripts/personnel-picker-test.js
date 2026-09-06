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

console.log('共享人员选择器逻辑测试通过');
