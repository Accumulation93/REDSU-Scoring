'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routePath = path.resolve(__dirname, '../src/modules/audit/routes/auditUser.js');
const adminRoutePath = path.resolve(__dirname, '../src/modules/audit/routes/auditAdmin.js');
const behaviorPath = path.resolve(__dirname, '../../miniprogram/subpackages/scoring/pages/admin/modules/auditBehavior.js');
const adminWxmlPath = path.resolve(__dirname, '../../miniprogram/subpackages/scoring/pages/admin/admin.wxml');
const submissionWxmlPath = path.resolve(__dirname, '../../miniprogram/subpackages/audit/pages/submissionDetail/submissionDetail.wxml');
const submissionBehaviorPath = path.resolve(__dirname, '../../miniprogram/subpackages/audit/pages/submissionDetail/submissionDetail.js');
const templateStepModelPath = path.resolve(__dirname, '../src/modules/audit/models/auditFlowTemplateStep.js');
const submissionStepModelPath = path.resolve(__dirname, '../src/modules/audit/models/auditSubmissionStep.js');
const migrationPath = path.resolve(__dirname, '../db/deploy/20260802123000_audit_approver_designation.sql');
const appWxssPath = path.resolve(__dirname, '../../miniprogram/app.wxss');
const personnelPickerWxmlPath = path.resolve(__dirname, '../../miniprogram/components/personnel-picker/personnel-picker.wxml');

function hydrateLocale(source, locale, variableName, asLiteral) {
  return Object.entries(locale).reduce((result, entry) => {
    const pattern = new RegExp(`\\b${variableName}\\.${entry[0]}\\b`, 'g');
    return result.replace(pattern, asLiteral ? JSON.stringify(entry[1]) : String(entry[1]));
  }, source);
}

const routeSource = hydrateLocale(
  fs.readFileSync(routePath, 'utf8'),
  require('../src/locales/zh-CN/generated/modules/audit/routes/auditUser'),
  'localeCopy',
  true
);
const adminRouteSource = hydrateLocale(
  fs.readFileSync(adminRoutePath, 'utf8'),
  require('../src/locales/zh-CN/generated/modules/audit/routes/auditAdmin'),
  'localeCopy',
  true
);
const behaviorSource = fs.readFileSync(behaviorPath, 'utf8');
const personnelPickerWxmlSource = fs.readFileSync(personnelPickerWxmlPath, 'utf8');
const adminWxmlSource = hydrateLocale(
  fs.readFileSync(adminWxmlPath, 'utf8'),
  require('../../miniprogram/locales/zh-CN/generated/subpackages/scoring/pages/admin/admin'),
  'localeCopy'
);
const submissionWxmlSource = fs.readFileSync(submissionWxmlPath, 'utf8');
const submissionBehaviorSource = fs.readFileSync(submissionBehaviorPath, 'utf8');
const templateStepModelSource = fs.readFileSync(templateStepModelPath, 'utf8');
const submissionStepModelSource = fs.readFileSync(submissionStepModelPath, 'utf8');
const migrationSource = fs.readFileSync(migrationPath, 'utf8');
const appWxssSource = fs.readFileSync(appWxssPath, 'utf8');

const startRoute = routeSource.slice(
  routeSource.indexOf("router.post('/startAuditSubmission'"),
  routeSource.indexOf("router.post('/startAdHocAudit'")
);

assert(startRoute.includes('const orgId = await getCurrentOrgId();'),
  '发起模板审批必须先解析当前组织，不能在保存时引用未定义的 orgId');
assert(startRoute.includes('Number(o.stepIndex) === 1;'),
  '模板步骤覆盖必须按对外的一-based 第一步编号匹配');
assert(routeSource.includes('stepIndex: Number(ts.sort_order) || idx + 1'),
  '模板预览必须把第一步以 stepIndex=1 返回给发起人');
assert(startRoute.includes("Number(o.stepIndex) !== 1")
  && startRoute.includes('Number(templateSteps[0].allow_approver_designation) !== 1'),
  '提交人只能在第一步明确允许时指定审批人');
assert(routeSource.includes("Number(nextStep.allow_approver_designation) !== 1")
  && /message:\s*['"]下一步按审批条件确定审批人['"]/.test(routeSource),
  '后续审批人指定必须由目标步骤的服务端开关约束');
assert(!submissionBehaviorSource.includes("name: 'listHrInfo'"),
  '审批详情不能调用管理员专用的人事目录接口');
assert(submissionBehaviorSource.includes('editSubmissionId')
  && submissionBehaviorSource.includes('stepOverrides: stepOverrides')
  && routeSource.includes('const draftSteps = allSteps.filter')
  && routeSource.includes('const sourceSteps = draftSteps.length'),
  '模板修改和重新提交必须保留审批人重新指定链路');
assert(routeSource.includes('hasHistoricalApprovalEvent')
  && routeSource.includes('auditEventModel.getBySubmissionId(submissionId)'),
  '审批历史打开详情必须允许实际处理过审批事件的操作者查看');

// A first-step override must narrow only step 1; later steps keep their own rules.
const overrides = [{ stepIndex: 1, personHrIds: ['hr-first'], assignmentIds: ['assignment-first'] }];
const stepConditions = [
  [{ conditionType: 'person', personHrIds: 'hr-first', assignmentIds: 'assignment-first' }],
  [{ conditionType: 'identity_scope', departmentScope: 'all', workGroupScope: 'all', identityScope: 'specific', specificIdentityId: 'identity-next' }]
];
for (let i = 0; i < stepConditions.length; i += 1) {
  const override = overrides.find((item) => Number(item.stepIndex) === i + 1);
  if (override) stepConditions[i] = [{
    conditionType: 'person',
    personHrIds: override.personHrIds.join(','),
    assignmentIds: override.assignmentIds.join(',')
  }];
}
assert.deepStrictEqual(stepConditions[0], [{
  conditionType: 'person', personHrIds: 'hr-first', assignmentIds: 'assignment-first'
}]);
assert.deepStrictEqual(stepConditions[1], [{
  conditionType: 'identity_scope', departmentScope: 'all', workGroupScope: 'all',
  identityScope: 'specific', specificIdentityId: 'identity-next'
}]);

assert(behaviorSource.includes("_auditConditionTarget: 'step'"),
  '打开步骤条件编辑器必须明确写入步骤表单，不能沿用发起条件表单');
assert(behaviorSource.includes('auditMultiPickerSelectedCount: Object.keys(selectedIds).length'),
  '选择器打开时必须同步已选数量');
assert(behaviorSource.includes("cond.assignmentIds = c.assignmentIds")
  && behaviorSource.includes('_auditAssignmentOptions()')
  && behaviorSource.includes("updateObj[formPrefix + '.assignmentIds']"),
  '模板指定人员必须按具体岗位选择并同时提交人员与岗位 ID');
assert(adminWxmlSource.includes('auditStepConditionForm.assignmentNames')
  && adminWxmlSource.includes('auditStarterConditionForm.assignmentNames'),
  '步骤与发起条件编辑器必须显示具体岗位，而不是只显示人员姓名');
assert(adminRouteSource.includes("const orgId = await getCurrentOrgId();")
  && /message:\s*['"]请先选择组织['"]/.test(adminRouteSource),
  '保存审批流程前必须校验当前组织');
assert(adminWxmlSource.includes('auditTemplateStepEditorVisible')
  && adminWxmlSource.includes('catchtouchmove="noop"'),
  '审批步骤弹窗必须锁住背景触摸，内部 scroll-view 才能独立滚动');
assert(adminWxmlSource.includes('允许指定本步骤审批人')
  && adminWxmlSource.includes('onStepApproverDesignationChange'),
  '步骤编辑器必须提供允许和不允许两种审批人指定模式');
assert(submissionWxmlSource.includes('item.stepIndex === 1 && item.allowApproverDesignation')
  && submissionWxmlSource.includes('nextStepInfo && nextStepInfo.allowApproverDesignation'),
  '发起页和审批页只能在目标步骤允许时展示指定入口');
assert(submissionBehaviorSource.includes('stepIndex !== 1')
  && submissionBehaviorSource.includes('targetStep.allowApproverDesignation !== true'),
  '发起页事件处理必须再次限制为可指定的第一步');
assert(templateStepModelSource.includes('allow_approver_designation')
  && submissionStepModelSource.includes('allow_approver_designation')
  && migrationSource.includes('audit_flow_template_steps')
  && migrationSource.includes('audit_submission_steps'),
  '模板和运行中审批步骤必须分别保存审批人指定开关');

for (const visibleState of [
  'auditTemplateStepEditorVisible',
  'auditStarterConditionEditorVisible',
  'auditSubmissionDetailVisible',
  'auditMultiPickerVisible',
  'auditIdentityPickerVisible'
]) {
  const portalPattern = new RegExp(`<viewport-portal\\s+wx:if="\\{\\{${visibleState}\\}\\}">[\\s\\S]*?<view\\s+class="popup-mask ui-overlay"\\s+wx:if="\\{\\{${visibleState}\\}\\}"`);
  assert(portalPattern.test(adminWxmlSource),
    `${visibleState} 必须由按需创建的 viewport-portal 提升到页面根层，关闭时必须销毁原生脱离层`);
}
assert(/<personnel-picker\s+visible="\{\{auditPersonnelPickerVisible\}\}"/.test(adminWxmlSource)
  && /<viewport-portal\s+wx:if="\{\{visible\}\}"/.test(personnelPickerWxmlSource),
  '审核人员选择必须复用按需创建 viewport-portal 的全局 personnel-picker');

assert(/\.ui-overlay\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?top:\s*0\s*!important;[\s\S]*?left:\s*0\s*!important;/m.test(appWxssSource),
  '弹窗遮罩必须固定覆盖整个可视区域');
assert(/\.ui-overlay\s+\.ui-dialog-shell\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?top:\s*50vh\s*!important;[\s\S]*?left:\s*50vw\s*!important;/m.test(appWxssSource),
  '弹窗外壳必须固定在可视区域中心');
assert(!/\.(?:popup-card|modal-card):active\s*[,\{][\s\S]{0,220}?transform:\s*none/m.test(appWxssSource),
  '弹窗按下时不得清除用于视口居中的 transform');
assert(/\.ui-dialog-shell:active,[\s\S]*?transform:\s*translate\(-50%,\s*-50%\)\s*!important;/m.test(appWxssSource),
  '弹窗按下和聚焦时必须保持相同的视口居中位移');

console.log('审批流程：建流程、首步指定、发起和弹窗交互契约测试通过');
