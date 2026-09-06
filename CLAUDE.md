# CLAUDE.md — WHUSU Smart Workspace

> AI 编程全局指南。子模块专属规范见 `.claude/rules/` 目录。
> 最后更新：2026-08-23

---

## 1. 项目概述

**WHUSU智慧工作台** — 武汉大学组织工作台微信小程序。当前包含评分、人事、审核审批、场地借用、消息中心和组织/岗位上下文管理。

- **前端**：微信小程序原生框架（WXML / WXSS / JS），无第三方框架
- **后端**：Node.js Express（本机回环 HTTP，由 Nginx 终止 HTTPS），MySQL 8.0 (InnoDB, utf8mb4, `mysql2/promise`)
- **认证**：全局账号 + 服务端会话 + JWT Bearer Token；口令与微信均进入同一自然人/工作角色授权链，微信 code2session 只用于显式微信认证或绑定。
- **部署**：Ubuntu 22.04 + PM2 ×2 + Nginx 反向代理
- **App ID**：`wxa0946295a962ee2e`，生产域名：`accumulation93.com`

模块：考核评分 / 人事管理 / 审核审批 / 场地借用。领域架构见 `docs/architecture.md`，功能口径见 `docs/features.md`，目录结构见各 `.claude/rules/` 文件。

---

## 2. 代码规范

### 2.1 变量声明 — 强制 `let` / `const`，禁止 `var`

**这是硬性规定。** 编辑任何文件时，必须将该文件中所有 `var` 迁移为 `let`/`const`。不被重新赋值→`const`，会被重新赋值→`let`。

> ⚠️ **例外**：WXS 文件（`.wxs`）不支持 `let`/`const`，必须保留 `var`。

### 2.2 注释语言：中文

所有注释、文档、commit message 使用中文。

### 2.3 命名规范

| 类别 | 规范 | 示例 |
|------|------|------|
| 文件/目录/函数/变量 | camelCase | `venueBooking.js`, `callFunction()` |
| 私有/内部 | `_` 前缀 | `_dragState`, `_computeGrayKeys()` |
| 常量 | UPPER_SNAKE_CASE | `API_BASE`, `TOTAL_MIN` |
| CSS class | kebab-case | `.drag-ghost-card` |
| 数据库表/列 | snake_case | `hr_info`, `score_records` |

### 2.4 文件组织

每个页面/组件必须是独立目录，包含同名 `.js`、`.wxml`、`.wxss`、`.json` 四个文件。

### 2.5 代码风格

- Page 顶层方法用传统 `function`，回调用箭头函数
- 字符串优先单引号，模板用反引号
- 新代码用 `async/await`，模块导出用 `module.exports`

---

## 3. Git 工作流

### 3.1 分支策略

- `main` — 唯一生产发布基线；经用户授权的 Codex 标准交付流程可以在完成门禁后提交并推送当前已验证提交。
- `codex/<功能名>` 或 `feature/<功能名>` — 需要隔离评审时使用的功能分支；合并前后都必须以 `main` 的 CI 结果和远端 SHA 为准。

### 3.2 Commit 格式 (Conventional Commits)

```
<type>(<scope>): <中文描述>
```

| Type | 用途 | Type | 用途 |
|------|------|------|------|
| `feat` | 新功能 | `fix` | Bug 修复 |
| `refactor` | 重构 | `style` | 样式/UI |
| `perf` | 性能优化 | `chore` | 杂项 |

Scope 用具体模块名：`venue`, `audit`, `scoring`, `portal`, `auth`, `notification`, `ui` 等。

### 3.3 自动提交 — 每次变更必须 commit + push

**每次代码修改完成后，自动 `git add -A && git commit -m "..." && git push`，不需要用户提醒或确认。** 这是强制性工作流，不得跳过。

---

## 4. 设计系统 — 蓝奢玻璃风格

> UI Kit 事实来源：`docs/ui-kit.md`、`docs/ui-components.md`、`docs/ui-page-templates.md`。
> `.agents/skills/blue-glass-ui/SKILL.md` 负责 Blue Glass 实施约束；设备差异和最终尺寸以 UI Kit 文档及 `miniprogram/app.wxss` 为准。

### 4.1 色板

| 角色 | 色值 |
|------|------|
| 主蓝 | `#1d4ed8` / `#2563eb` / `#3b82f6` / `#60a5fa` |
| 标题文字 | `#0f172a`，正文 | `#1e293b` |
| 次要文字 | `#64748b`，弱化 | `#94a3b8` |

### 4.2 Chips — 仅 4 色

| 变体 | 背景 | 文字 |
|------|------|------|
| 蓝 | `rgba(219,234,254,0.76)` | `#1d4ed8` |
| 绿 | `rgba(209,250,229,0.78)` | `#15803d` |
| 橙 | `rgba(255,237,213,0.78)` | `#c2410c` |
| 天蓝 | `rgba(224,242,254,0.76)` | `#0369a1` |

### 4.3 按钮 — 仅 3 种

- **Primary** — 蓝渐变 + 白字
- **Secondary** — 白玻璃 + 深色字
- **Danger** — 红渐变 + 白字（仅删除/解绑等破坏性操作）

### 4.4 容器黄金法则

每个卡片/容器必须同时满足：
1. `linear-gradient` 背景（`rgba(255,255,255,0.80-0.96)`），**绝不纯色**
2. `border: 1rpx solid rgba(255,255,255,0.62-0.96)`
3. `box-shadow` + `inset 0 1rpx 0 rgba(255,255,255,0.78)`（顶部高光）
4. `backdrop-filter: blur(24rpx)`

### 4.5 页面背景（必须用此渐变）

```css
page {
  background:
    radial-gradient(circle at 12% 10%, rgba(96,165,250,0.16) 0%, transparent 26%),
    radial-gradient(circle at 86% 18%, rgba(191,219,254,0.22) 0%, transparent 24%),
    linear-gradient(135deg, #f8fbff 0%, #f1f6fc 48%, #edf3fa 100%);
}
```

### 4.6 其他硬性约束

- 唯一动画：`glassFadeUp`（`opacity: 0→1, translateY: 18rpx→0`），不创建自定义动画
- 圆角和密度由 `miniprogram/app.wxss` 的设备令牌控制：手机、Pad 竖屏、Pad 横屏分别维护，不得在页面级重新写死一套尺寸；状态标签使用克制的圆角矩形，不使用胖胶囊。
- **禁止新增**按钮颜色、chip 颜色、自定义动画

### 4.7 响应式布局（平板适配）

`rpx` 随屏幕等比缩放，平板上不能继续沿用手机尺寸。统一断点和尺寸策略：
- 手机 `<520px`：字体使用受控逻辑 `px` 字阶，间距和布局可继续使用手机端 `rpx`；标准宽度手机只做轻微字号递增，禁止宽屏手机通过 `rpx` 把弹窗和正文机械放大。
- Pad 竖屏 `520-899px`：控件高度、字号、行高、间距改用受控 `px` 令牌；窄页面使用 `.page-narrow` 约束内容宽度。
- Pad 横屏 `>=900px`：管理页可使用侧栏与主工作区，内容卡片按信息关系分栏，禁止单纯把手机页面等比放大。
- Pad 大按钮统一 `48px` 最小高度和舒适的上下内边距，小按钮统一 `36px`；文字默认不强制换行，长文本容器必须允许自身收缩和安全断行。
- 弹窗同时受视口宽高约束；签名、键盘、时间表等专用控件使用独立 Pad 尺寸，不得保留超大固定 `rpx` 高度。

### 4.8 人事领域、账号治理与设备识别

- 人事模型固定为“自然人 → 组织成员关系 → 岗位”；账号是自然人的全局账号，不属于某个组织。岗位由岗位性质、部门、身份类别和可选职能组组成，禁止自由文本岗位名称；展示名统一由“身份类别 · 部门 · 职能组”生成，缺少职能组时省略该段。
- `contextId` 表示内部工作上下文，`assignmentId` 表示岗位，`identityCategoryId/Name` 表示身份类别；小程序唯一活动键为 `activeContextId`。面向用户的通用称谓固定为“工作角色”，具体类型为“岗位”或“管理权限”，禁止显示“工作上下文”及内部字段名。禁止继续用 `identityId` 同时表示上下文和身份类别。
- 在职成员可以暂时没有岗位；此时仍显示在人事目录并可维护资料，但不得获得审核、场地、评分等岗位规则驱动权限。成员列表一人一卡，岗位只在详情中分组展示，无岗位使用中性状态气泡。
- 审核、场地和评分的动作授权只认当前岗位；操作与历史必须保存不可变的组织、内部上下文、岗位及部门/身份类别/职能组快照，后续调岗不得改写历史。技术快照只用于服务端判权和历史解释，不得直接写入用户提示。
- 补充资料的审核状态与完整度分开；生效资料维护和待审资料审核是两条权限链，驳回原因必填。“离开当前组织”只停用成员关系和岗位，不删除自然人、全局账号或历史。
- 冻结、解绑、初始化或修改登录口令、重置全局账号只允许 `auth.accounts.global_manage`；在职成员尚无账号或微信绑定时允许初始化口令。口令认证不依赖微信，成功后仅在用户明确选择时补充空缺绑定，禁止替换或抢占既有绑定。修改口令保留现有会话，全局关闭口令登录时禁止设置和使用口令。部门、身份类别、职能组一旦被任何岗位、规则、快照或历史引用就禁止删除。职能组与岗位部门必须始终一致。
- 管理端认证、账号与恢复统一在人事信息中完成：成员外卡只显示一个合并状态，单人操作进入成员详情，批量工具与筛选区并列常驻；只有认证设置作为人事信息下级页签。严禁再建立“人员认证”或“账号与恢复”的重复人员目录；内部审计记录不在用户界面展示。
- 成员资料目录必须合并在职与已离开成员并默认显示全部，不得建立独立离任页签。查询字段、关键词、排序、高级筛选和批量工具共同置于控制卡；岗位性质、部门、身份类别和职能组必须在同一岗位元组内匹配，禁止跨岗位拼接。
- 已离开成员详情只读并允许重新加入为在职无岗位。永久删除必须先做全引用预检：业务事实阻断、允许的未执行引用事务清理、零候选规则停用；组织范围删除不得影响其他组织，彻底删除自然人仅限超级管理员并保留去标识审计。
- 设备信息仅用于登录后的可选审计展示，不参与登录、续期或会话互斥。同一账号允许多设备同时登录；设备信息缺失或变化不得阻断认证，也不得用 OpenID、姓名、学号、IP 或硬件指纹猜测设备。
- 跨组织补充资料按 `person_id + trim(label) + field_type` 唯一合并，只处理已生效记录；待审核值和不同名称/类型值不得覆盖或合并。

### 4.9 全局时间体系

- 绝对时间统一以 UTC `DATETIME(3)` 存储并由服务端返回 ISO UTC；`system_config.timezone` 只控制显示。小程序按系统下发的 `systemTimezoneOffset` 和配置版本换算，禁止依赖设备本地时区。
- `YYYY-MM-DD`、`HH:mm`、时长、提前量和周期规则属于日期型/规则型值，不做时区换算。列表显示 `YYYY-MM-DD HH:mm`，详情、验签和安全记录显示 `YYYY-MM-DD HH:mm:ss`。
- WXML 只渲染预计算 `*Text` 字段，不得直接显示原始时间或 ISO `T...Z`；历史迁移按写入来源分类，来源不明进入逐记录审计。服务端必须按“记录标识 + 原始绝对时间”下发对应 `*ReviewStatus`，页面逐字段显示“历史时区待核对”，禁止用全局提示替代、猜测平移或静默当作 UTC。

---

## 5. 已知坑点 TOP 7

> 全部坑点见 `.claude/rules/miniprogram.md` §3。"坑点大全"。

1. **WXS 必须用于模板中字符串操作** — WXML 不支持 `.split()`/`.map()`，必须写 WXS 模块
2. **`<input>` 禁用 `display: flex`** — 用 `display: block` + `line-height` + `padding` 居中
3. **共享样式修改必须审计影响面** — `app.wxss`、`home.wxss`、`blue-polish.wxss` 影响所有页面；仅在明确的全局统一任务中修改，并运行全页 UI 审计
4. **`setData` 必须合并为一次调用** — 多次 setData → 重复渲染 → 卡顿
5. **Toast ≤7 中文字符** — 超长会被微信截断。用 `showShortToast()`（已内置截断）
6. **编译器必须完整关闭隐式 runtime 路径** — 保持 `nodeModules: false`、`es6: false`、`enhance: false`、`swc: false`、`disableSWC: true`，并在 `project.private.config.json` 保持 `compileHotReLoad: false`。否则 SWC/Babel 可能生成未打包 helper，热重载还可能遗漏递归依赖，导致页面无法注册并连带出现 `wx://not-found`
7. **禁止正则批量改写 WXML** — `wx:if="{{a > b}}"` 等属性包含 `>`；必须使用识别引号和 Mustache 的扫描器或逐文件结构化修改
8. **超大 WXML 必须拆组件并验证生成代码** — Glass-Easel 曾因单页模板过大生成名为 `if` 的变量并导致运行时白屏。独立控制卡、复杂弹窗和详情区必须按语义拆成自定义组件；运行 `node scripts/wechat-template-runtime-audit.js`，并在微信开发者工具中冷编译确认。

---

## 6. 质量要求

**每次修改后必须校验：**
1. 直接关联代码是否正确
2. 所有调用方代码是否正常
3. 文件内其他函数是否受影响
4. WXML/WXSS 修改后渲染无误
5. 完整用户操作链无断点
6. 小程序改动运行 `node scripts/miniprogram-compat-audit.js`，并用微信开发者工具真实编译主包及全部分包
7. 用户可见文案只允许来自 `miniprogram/locales/zh-CN/**` 或 `server/src/locales/zh-CN/**`；运行改动范围对应的 `--strict-localization` 审计

**目标：代码可直接推送到生产环境。**

### 修改前检查
- 读取文件最新内容（不要假设）
- 搜索所有引用此文件/函数的位置
- 检查全局样式是否影响新样式

### 跨模块影响速查

| 修改文件 | 必须同时检查 |
|----------|-------------|
| `api.js` | 所有页面和 Behavior |
| `eventBus.js` | `portal.js`、venue 各页面 |
| `adminUtils.js` | 所有 12 个 Behavior |
| `flowTimeline.js` (venue) | 3 个 venue 页面的 WXML |
| `submissionDetail.js` | `pendingApprovals.js`、`myApprovalHistory.js` |
| `app.wxss` / `home.wxss` / `blue-polish.wxss` | 检查全部页面、组件、断点和选择器覆盖顺序 |

### 高频陷阱

| 场景 | 易遗漏 |
|------|--------|
| 新增页面 | 忘记在 `app.json` 注册 |
| 新增 API | 只改前端，忘注册后端路由 |
| 修改 setData 字段名 | 忘记同步 WXML 绑定 |
| 拖拽相关 | 忘记 `dragActive: false` 重置 |

---

## 7. 禁止事项清单

- ❌ 使用 `var`（WXS 除外）
- ❌ 英文注释
- ❌ 纯色背景（必须 linear-gradient）
- ❌ 新增按钮颜色 / chip 颜色 / 自定义动画
- ❌ 在非全局任务中无审计地修改共享 CSS，或用追加补丁覆盖未知页面
- ❌ 多次 `setData` 调用不合并
- ❌ `popup-mask` 内放 `position: fixed; bottom: 0` 元素
- ❌ WXML 中直接调用 `.split()` / `.replace()` / `.map()`
- ❌ 未完成门禁、未核对远端 SHA 就直接向 `main` 提交
- ❌ Toast 超过 7 个中文字符
- ❌ 修改后不 commit + push
- ❌ 平板端不设 max-width 约束 → 按钮/卡片过度放大
- ❌ 用 `Page(wrapper({...}))`、全局装饰器或公共开发夹具包装生产页面
- ❌ 在 `nodeModules: false` 的原生小程序中直接依赖 `@swc/runtime` / `@babel/runtime`
- ❌ 配置 `swc: false` 却同时配置 `disableSWC: false`；后者会实际启用 SWC
- ❌ 开启 `enhance`、`es6` 或 `compileHotReLoad` 后只验证登录页；私有配置会覆盖公共配置，必须冷启动并逐页验证全部注册页面
- ❌ 用正则表达式批量插入、删除或重排 WXML 标签属性
- ❌ 只运行 `node --check` 就认定小程序编译兼容；必须再运行兼容性审计和微信开发者工具编译
- ❌ 忽视关联代码的完整性校验
