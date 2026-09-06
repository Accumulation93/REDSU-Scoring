---
paths: "miniprogram/subpackages/scoring/**"
---

# CLAUDE.md — WHUSU智慧工作台模块 (scoring)

> 模块专属规范。通用规范见根目录 `CLAUDE.md` 和 `.claude/rules/miniprogram.md`。

---

## 1. 模块结构

```
scoring/pages/
├── admin/                    # 综合管理面板与 Behavior 组合
│   ├── admin.js              # Page({}) 主文件
│   ├── modules/
│   │   ├── sharedApi.js      # 基础 Behavior：callCloud()（必须第一个注册）
│   │   ├── adminUtils.js     # 纯工具函数、常量与空表单工厂
│   │   ├── activityBehavior.js / templateBehavior.js / ruleBehavior.js
│   │   ├── resultBehavior.js / hrInfoBehavior.js
│   │   ├── departmentBehavior.js / identityBehavior.js / workGroupBehavior.js
│   │   ├── adminManagementBehavior.js / settingsBehavior.js
│   │   ├── publicationBehavior.js / auditBehavior.js
│   ├── gradeBand.wxs         # WXS：等第颜色映射
│   └── admin.wxss            # 综合管理页样式
├── score/                    # 用户评分表单
└── scorerTasks/              # 评分人任务完成度列表
```

---

## 2. Behavior 组合模式

```javascript
Page({
  behaviors: [
    sharedApi,         // ← 必须第一个！提供 this.callCloud()
    adminUtils,
    activityBehavior,
    // ... 其余
  ],
});
```

**规则：**
- `sharedApi` 永远第一个注册
- 新功能 **必须** 作为独立 Behavior
- Behavior 之间通过 `this.data` / `this.setData()` 共享状态

---

## 3. 标准 Behavior 方法模式

```javascript
async loadActivityList() {
  this.setLoading('activities', true);
  try {
    const result = await this.callCloud('listScoreActivities');
    this.setData({ activityList: result.list || [] });
  } catch (error) {
    wx.showToast({ title: '加载失败', icon: 'none' });
  } finally {
    this.setLoading('activities', false);
  }
}
```

---

## 4. adminUtils.js 关键函数速查

**表单工厂：** `emptyActivityForm()`, `emptyTemplateForm()`, `emptyRuleForm()`, `emptyHrForm()`, `emptyDepartmentForm()`, `emptyWorkGroupForm()`, `emptyIdentityForm()`, `createEmptyQuestion()`, `createEmptyProfileField()`

**数据转换：** `toNumber(val, fallback)`, `clampNumber(val, min, max)`, `formatScoreFixed3(val)`, `getProgressColor(ratePercent)`, `buildProgressFillStyle(ratePercent)`, `moveItem(list, fromIndex, toIndex)`

**CSV 导入：** `autoMapCsvColumn(headers, fields)` — Jaccard 相似度自动列匹配; `jaccardCharSimilarity(a, b)`; `detectFieldTypeFromValues(values)`; `validateCsvValueAgainstField(value, field)`

**规则引擎：** `createTemplateConfig()`, `normalizeClauseForEdit()`, `buildRuleListItem()`, `buildRuleClauseText()`, `buildRuleClausesForSave()`

---

## 5. 拖拽排序

**触发：** `bindlongpress` → 30fps 节流 touchmove → touchend
**插入调整：** `toIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex`
**详细指南：** `.agents/skills/wechat-miniprogram-drag-sort/SKILL.md`

---

## 6. scorerTasks 页面

**数据流：** `getScorerTaskStatus`（支持分页）→ 按部门/身份类别/职能组过滤 → 导出 CSV/Excel
**WXSS：** `@import "../admin/admin.wxss"` 继承管理端样式

---

## 7. score.js 评分页面

- **双键盘：** 自定义屏幕键盘 + 物理键盘（隐藏 input 捕获）
- **提交重试：** 网络失败后 re-fetch 检查记录是否实际已保存
- **分数验证：** minValue ≤ score ≤ maxValue，对齐 stepValue

---

## 8. 岗位粒度与当前上下文

- 评分规则、评分人资格和评分动作只使用当前工作上下文中的有效 `assignmentId`；禁止从 `hr_info` 单岗位快照或身份类别 ID 推导当前岗位。无岗位成员不得执行岗位规则驱动评分。
- 评分模板和题目必须归属于单一组织；模板目录、重名检查、规则引用、复制、编辑、删除和结果解释都必须绑定当前 `org_id`，禁止把模板当作跨组织全局字典。历史迁移遇到同一模板被多个组织引用时必须失败关闭，先显式拆分，禁止猜测归属。
- 编辑评分模板只改变后续评分使用的问题结构；已提交评分必须继续按记录内不可变计算快照展示和计算，禁止删除评分记录或答案。模板及题目替换、复制和删除必须在事务内完成。
- 后台评分记录按岗位建立并保存不可变岗位/工作上下文快照；前端默认按自然人展示。同一任务中同一自然人出现多个岗位记录时，才显示岗位标签，并包含足以区分的部门、身份类别和职能组。
- 自评限制按自然人判断，切换岗位不得绕过；历史结果展示记录产生时的岗位快照，不能用当前岗位覆盖。
- 历史评分记录缺失岗位快照时只能显示“历史岗位信息缺失”，禁止查询 `hr_info` 或当前岗位补写、覆盖或扩张权限。
- 岗位候选必须来自有效组织成员岗位，旧记录无法唯一映射到岗位时不得猜测或静默归并。
- 打开评分表、结果页或公示页只能读取数据，禁止因当前模板签名与历史记录不同而删除旧答案、旧评分记录或改写历史签名。
- 评分记录必须固化提交时模板、题目、规则解释和岗位快照；结果计算与导出只使用这些历史快照，不得用当前岗位、当前规则或当前模板重新解释历史分数。
- 历史快照不足时显示“历史评分依据缺失”并阻止需要精确依据的计算；任何修复必须通过带审计的幂等迁移执行，禁止在普通请求中静默补写。
- 已提交评分允许评分人重新打开修改。读取时必须使用当前评分记录自己的 `calculation_context_snapshot` 恢复提交时题目、范围与答案；完整依据返回与首次评分完全一致的可编辑界面，不显示旧版本、修订或额外状态提示。保存时事务化覆盖当前答案并递增只用于乐观并发的 `revision_number`，不得建立或保留旧评分副本，也不得套用当前模板重算。只有旧记录缺少可验证题目范围时才返回只读异常详情，并使用自然语言提示联系管理员。
- 评分页必须以载入后的题目分数建立草稿基线；只有分数确实变化时启用原生离页提醒，恢复原值或提交成功后立即解除。返回按钮、返回手势和系统导航均不得无提示丢弃未提交修改；校验错误、题目焦点、键盘开合等展示状态不得误触发提醒。
- 禁止把历史答案按当前模板题序硬映射，也禁止因 `template_config_signature` 与当前模板不同而返回失败或跳回首页。历史快照缺失或验签失败时，只能降级为“历史题号 + 原始分数”只读展示并明确标记题目文字未留存，不能猜测题目内容；连答案行也缺失时仍须展示提交记录元信息和明确空态，不得打不开或重定向。
- 只读评分详情沿用正常评分页的信息层级和题目卡片；必须隐藏输入捕获层、自定义键盘、编辑反馈和提交按钮，不得另做一套割裂的历史详情界面。
- `calculation_context_snapshot` 存入 MySQL JSON 后对象键顺序可能变化；任何持久化策略签名必须先按固定字段顺序投影再哈希，禁止直接对任意解析对象执行 `JSON.stringify` 后验签。新增或回填快照必须共用 `calculationSnapshotSignature`，并覆盖 MySQL JSON 键重排回归测试。
- 评分计算快照当前唯一写入格式为固定字段、固定类型的 `version=2`：所有新提交必须先经过 `canonicalizeCalculationSnapshot`，不得在路由内自行拼装变体或附加临时字段；`calculationPolicySignature` 必须使用 `v2:` 前缀。`version=1` 只允许作为迁移前读取兼容，禁止继续新增。
- 旧评分快照升级必须先用其原版本签名全量验真，再通过带时间戳的幂等迁移逐条规范化；规范化只允许统一字段、类型和签名版本，不得改变题目、答案、参与人、岗位或分数。部署必须依次执行全量预检、维护期写入和全量 v2 复验，任一步失败即回滚。
- 评分表加载失败不得定时跳回首页；页面必须保留语义容器，显示 locale 中的错误信息和原地重试操作。发布窗口内遇到旧服务返回的历史结构冲突状态，应提示数据正在恢复，不能让用户看到“一直加载后退出”。
- 评分管理端五个顶层页签必须始终在同一行等宽呈现，允许页签单元收缩但不得拆字、换出孤立第二行或被裁切；组织/工作角色切换与权限刷新后必须一次性重算 `visibleTabs`，且现场点击“评分活动”和“结果公示”首末两项都能立即切换对应内容。
- 从评分表返回被评分人目录时，已有目录必须继续可见并在后台刷新状态；禁止仅因刷新请求进行中就用整页加载态遮住已有卡片。只有首次进入或当前工作角色确实变化时才清空目录并展示首屏加载。
- 结果公示与评优名单的活动选择以 `publicationForm.activityId` 为唯一可见选择事实。历史活动请求只能与发起请求时的所选活动比较以判定是否过期，禁止拿全局“当前评分活动”丢弃历史活动响应；切换活动后必须同时恢复该活动已保存的规则、指定名单和汇总。
- 评分管理接口只使用统一认证与权限中间件注入的当前管理角色判权；路由不得再按 OpenID 从旧 `admin_info` 二次认证。独立测试必须显式模拟统一认证与权限中间件，禁止为测试保留微信查人回退；已经验证的 `req.admin`（包括明确无权限）不得被覆盖。
- 已保存的评优名单属于当前公示活动的业务事实。规则编辑可以修改仍存在条款的配额和排序，但移除已有名单引用的条款或整条规则必须被阻止并说明原因；禁止级联或显式删除 `merit_list_designations`。历史活动按其 publication 读取名单，不受“当前评分活动”切换影响。
- 打开结果公示页签或切换公示活动属于只读浏览，不得静默创建 `result_publications` 或改写发布状态；只有管理员明确点击保存时才允许建立或更新公示配置。
- 评分目标、评分表和提交接口必须以统一认证层解析出的当前工作角色与有效岗位为唯一判权事实；严禁信任客户端 `X-Role`、页面缓存或旧管理员表来决定用户是管理员还是岗位成员。
- 评分活动的开始日、结束日必须按系统配置时区解释和比较，禁止使用 Node 进程所在机器的本地日期；保存时必须验证为真实存在的 `YYYY-MM-DD` 日历日期。
- 评分管理页首次直达、从详情返回和普通重新显示都必须加载当前可见页签；结果公示重新显示时保留用户已经选择且仍属于当前组织的活动，只有组织或工作角色切换后才回到该组织当前活动。
- 公示管理中的评优候选必须由评分模块按当前组织有效岗位提供，不能依赖 `listHrInfo` 等人事管理权限接口；拥有结果公示权限但没有人事管理权限的管理员仍须能正常加载候选并保存名单。
- 公开结果必须合并评分记录中的历史被评分岗位快照。成员离任、调岗或岗位停用后，已公示的历史结果仍按记录产生时的部门、身份类别、职能组和岗位标签展示，禁止只遍历当前有效岗位导致记录消失。
- 查看结果规则如果仍被同一授权类别的评优指定规则依赖，不得删除；必须先调整依赖规则并向管理员说明。任何批量删除也必须整批失败，不能留下无法使用的孤立规则。
- 同一活动中的同一岗位只能属于一组评优指定。编辑某组名单时若所选岗位已被其他条款指定，必须拒绝并提示先调整原名单；禁止静默删除或“抢走”其他指定人的名单结果。

## 9. 模块特定禁止事项

- ❌ admin.js 主文件添加大段业务逻辑 → 放 Behavior
- ❌ 修改 adminUtils.js 函数签名 → 检查所有 Behavior 调用处
- ❌ 拖拽排序后忘记重置 `dragActive: false` → 页面滚动永久禁用
- ❌ Score 页面修改后不测试双键盘输入路径
