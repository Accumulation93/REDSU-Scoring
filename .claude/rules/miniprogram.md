---
paths: "miniprogram/**"
---

# CLAUDE.md — 微信小程序前端

> 本文件覆盖前端通用规范。项目级规范见根目录 `CLAUDE.md`。

---

## 1. 文件组织与注册

每个页面/组件必须是独立目录，含 4 个同名文件（`.js`/`.wxml`/`.wxss`/`.json`）。

### 新增页面

1. 创建 4 个文件
2. 在 `app.json` 注册：主包→顶层 `pages` 数组，分包→`subPackages[].pages` 数组
3. 目录约定：主包启动壳放在 `subpackages/main/pages/**`，业务分包 root 使用 `subpackages/<模块名>`；`subpackages/main` 不得写入 `subPackages`

**包归属以 `app.json` 注册位置为准，不以目录名为准。** `subpackages/main` 与其他分包目录并列只是物理组织方式；注册在顶层 `pages` 的登录页和门户页仍属于主包。

**分包路径引用规则：** 分包只能引用自身分包或主包资源，禁止直接引用其他业务分包的 JS、JSON、WXML、WXSS 或组件。跨模块共享样式统一放在 `miniprogram/subpackages/main/styles/**`，业务分包通过相对路径从主包导入；兼容性审计必须同时检查路径存在性和分包边界。

**关键约束：** 主包 ≤2MB，单分包 ≤2MB，全部分包 ≤20MB。用 `lazyCodeLoading: "requiredComponents"`。

### app.js 的特殊 require

```javascript
require('./utils/tableFile.js');  // ⚠️ 绝对不能删除！
```

---

## 2. 全局样式冲突

项目中有 **多处 CSS 重名选择器**：

| 文件 | 关键选择器 | 影响范围 |
|------|-----------|----------|
| `app.wxss` | popup 框架、全局 reset | 所有页面 |
| `subpackages/main/styles/home.wxss` | `.field-input` (`display: block`) | 业务分包通过主包共享样式导入；选择器可按交互需要使用 flex |
| `subpackages/audit/styles/blue-polish.wxss` | `.field-input`、`.card`、`.chip` | audit 所有页面 |
| `subpackages/venue/styles/blue-polish.wxss` | `.field-input`、`.card`、`.chip` | venue 所有页面 |

**规则：绝不修改 `app.wxss`、`subpackages/main/styles/home.wxss`、`blue-polish.wxss`。** 用更具体的选择器覆盖；如确需全局统一，必须先审计全部调用方并同步 UI 事实来源。

---

## 3. 已知坑点大全

> 实际踩过的坑，不是理论风险。每次写代码前必须阅读。

### 3.1 WXS 模块 — 模板中无法调用 JS 方法

WXML 不支持 `.split()`、`.replace()`、`.map()` 等原生 JS 方法。**必须用 WXS 模块。**

```xml
<!-- ❌ 错误 -->
<text>{{time.split(':')[0]}}</text>

<!-- ✅ 正确 -->
<wxs module="fmt">
function hour(t) { if (!t) return '--'; var p = (''+t).split(':'); return p[0] || '--'; }
module.exports = { hour: hour };
</wxs>
<text>{{fmt.hour(time)}}</text>
```

> ⚠️ WXS 不支持 `let`/`const`，必须保留 `var`。

### 3.2 WeChat 原生 `<input>` — 不支持 `display: flex`

设置 `display: flex` 后文字垂直居中失效、placeholder 位置异常、输入时跳动。

**解决：** `display: block; box-sizing: border-box;` + `line-height` + `padding` 垂直居中。

```css
.field-input {
  display: block; box-sizing: border-box;
  min-height: 64rpx; padding: 10rpx 16rpx;
  font-size: 24rpx; line-height: 44rpx;
}
```

### 3.3 `position: fixed` 在 scroll-view 中的行为

`position: fixed` 元素若放在 `scroll-view` 内部，iOS 上可能不跟随视口。普通弹窗必须使用 `root-portal` 提升到页面根层，不能留在页面或组件的滚动、transform、flex 布局链中。签名板实时笔迹禁止使用可视原生 Canvas，详见 §3.13。

```xml
<scroll-view>...</scroll-view>
<view class="kb-panel" wx:if="{{_kbVisible}}">...</view>  <!-- 在外部！ -->
```

### 3.4 `popup-mask` + flexbox 居中 → 子元素位置异常

弹窗使用 `.ui-overlay`、`.ui-overlay-blocker`、`.ui-dialog-shell` 三层契约：遮罩和阻断层固定覆盖 `100vw × 100vh`，窗口固定在 `50vw / 50vh` 并平移居中。阻断层和窗口必须是同级元素，阻断层在前、窗口在后。**`catchtouchmove="noop"` 只能放在独立阻断层，不能放在普通遮罩、窗口外壳、正文或滚动区祖先上。**

`ui-dialog-shell--complex` 只表示标题、正文、操作栏的结构，不代表满屏高度。普通表单外壳必须随内容和条件区的展开、收起自然增减，标题、正文和底部操作栏通过 flex 按实际内容动态分配高度；正文超过可用高度后才由直接子级 `scroll-view.ui-dialog-body` 滚动。只能设置基于视口安全区计算的动态上限，禁止固定内容高度、固定翻页尺度或用固定像素偏移定位；允许 `max-height: calc(100vh - 安全区)` 作为溢出保护。只有表格、时间表等真正需要稳定工作区的窗口才可显式使用 `ui-dialog-shell--viewport` 或 `--wide`。纵向滚动区统一启用 `enhanced`、`scroll-y` 与 `nested-scroll-enabled`；内层列表使用 `ui-dialog-scroll--pane`，手势落在内层时优先滚动内层。签名板、拖拽手柄等专用触摸区才允许使用 `ui-dialog-touch-lock`。

### 3.5 setData 批处理 — 必须一次调用

每次 `setData()` 触发一次渲染。连续多次 → 卡顿。

```javascript
// ❌ 两次 setData
this.setData({ _kbField: 'min' }); this.setData({ _kbGray: gray });

// ✅ 单次合并
this.setData({ _kbField: 'min', _kbGray: gray, _kbSelected: true });
```

### 3.6 `scroll-view` 的 `scroll-y` 不能动态关闭

`scroll-y="{{false}}"` 会使 scroll-view 忽略 `scroll-top` 程序化更新。弹窗背景锁定由正文之外的同级 `ui-overlay-blocker` 负责，不得在 `scroll-view` 自身或其祖先用 `catchtouchmove` 代替，否则会同时锁死窗口正文。

### 3.7 `clientY` vs `pageY`

- `pageY` 含 scroll-view 内部滚动偏移
- `clientY` 相对视口

`position: fixed` 元素（ghost card、拖拽手柄）**必须用 `clientY`**。

### 3.8 `showToast` 限制 7 个中文字符

`wx.showToast({ title })` 超 7 个中文字符会被截断。**用 `showShortToast()`（已内置自动截断+省略号）。**

### 3.9 `picker mode="date"` start 属性不可靠

某些设备不遵守 `start` 属性。**必须在 JS 层做兜底校验**，拒绝非法日期并恢复原值。

### 3.10 `wx.createSelectorQuery()` — 拖拽中必须节流

touchmove 中每秒 ~60 次 `createSelectorQuery().exec()` 会导致回调节点积压+卡顿。**拖拽场景节流到 ~30fps（33ms）：**

```javascript
if (self._lastUpdateTime && now - self._lastUpdateTime < 33) return;
self._lastUpdateTime = now;
```

### 3.11 WXML 中 `data-*` 属性值类型

`dataset` 中的值始终是**字符串**。比较时必须 `Number(e.currentTarget.dataset.index)`。

### 3.12 `hidden` vs `wx:if`

- `wx:if` — 不满足时不创建 DOM。用于不频繁切换的内容。
- `hidden` — 始终创建 DOM，切换 `display`。用于频繁显示/隐藏。

键盘面板、Ghost card 使用 `wx:if`。

### 3.13 签名板视口绝对坐标

可视白板与实时笔迹必须使用普通 `view`。白板 rect、触点 `clientX/clientY` 和线段端点统一
保存为视口 CSS px（逻辑像素）绝对坐标；禁止 scrollTop、DPR、rpx 和固定偏移。原生 Canvas 只能作为
不可见导出器，确认时再把绝对端点投影到白板局部坐标。白板每次完成布局、尺寸变化或弹窗重新显示后都要重新测量 rect；线段事实数据不得保存旧 rect 推导的局部坐标。具体要求详见 `.claude/rules/audit.md` §3。

### 3.14 编译器 runtime helper 缺失

原生小程序当前设置为 `nodeModules: false`，运行时不会自动提供 `@swc/runtime` 或 `@babel/runtime`。本项目曾同时配置 `"swc": false` 与 `"disableSWC": false`；开发者工具实际以 `disableSWC === false` 为准启用 SWC，含对象展开、计算属性、async 等语法的页面被转换为未打包的 runtime helper。关闭 SWC 后，Babel enhance 与热重载组合又曾生成 `@babel/runtime/helpers/*`，并遗漏 `unsupportedIterableToArray` 等 helper 的递归依赖。两类故障都会造成主包和分包页面无法注册。全局 `Page(uiPreview.attach({...}))` 曾扩大过影响范围，但不是唯一触发条件。

**强制规则：**

- 页面保持直接 `Page({ ... })` 注册，禁止全局装饰器、代理或夹具包装。
- 开发态视觉夹具放在 `scripts/` 或专用预览页面，由开发者工具自动化在页面加载后注入数据；不得进入生产页面的 `require` 依赖图。
- 不得直接引用 `@swc/runtime/*`、`@babel/runtime/*` 或假设编译器 helper 会自动存在。
- `project.config.json` 必须保持 `nodeModules: false`、`es6: false`、`enhance: false`、`swc: false`、`disableSWC: true`；`disableSWC: false` 会实际开启 SWC，不能被 `swc: false` 抵消。
- `project.private.config.json` 必须保持 `compileHotReLoad: false`。私有配置会覆盖公共配置，审计时必须按合并后的有效配置判断。
- 不随意修改 `useCompilerPlugins`、`useCompilerModule`；确需修改时必须逐页编译验证。
- `node --check` 只验证 JavaScript 语法，不能替代微信编译器验证；热重载成功也不能替代清缓存后的冷启动验证。
- 超大 WXML 会触发 Glass-Easel 生成代码变量名碰撞保留字（已出现 `if`）并在运行时白屏。独立控制卡、复杂弹窗和详情区必须拆成自定义组件；每次运行 `node scripts/wechat-template-runtime-audit.js`，有本机编译器时逐个生成并解析模板代码，无编译器时执行元素数量硬上限。复杂度门禁和真实冷编译必须同时通过。

**错误排查顺序：**先处理首个 `module ... is not defined`，再看 `wx://not-found`；后者通常是页面或组件脚本未注册的次生错误。最后单独检查接口 `timeout`，不要把网络超时误判为组件路径错误。

---

## 4. API 调用

```javascript
const { callFunction } = require('../../utils/api');

// Promise 风格（推荐）
const result = await callFunction({ name: 'getScoreFormData', data: { targetId } });

// 回调风格（向后兼容）
callFunction({ name: 'userLogin', data: { code }, success: res => { ... }, fail: err => { ... } });
```

- 自动添加 `Authorization: Bearer <token>` 请求头
- 15 秒超时，超时自动 abort
- 超时使用 `wx.request({ timeout: 15000 })` 原生能力，不使用 `setTimeout + requestTask.abort()` 模拟
- 所有业务 API 均为 POST，名称正则校验 `/^[A-Za-z][A-Za-z0-9_]*$/`

### 响应格式

```json
{ "status": "success", "data": { ... } }
{ "status": "login_success", "token": "...", "user": { ... } }
{ "status": "need_bind", "token": "..." }
{ "status": "error", "message": "错误描述" }
```

### 认证流程

微信入口通过 `wx.login()` 调用 `/api/auth/wechat/session`；口令入口直接调用 `/api/auth/password/session`，不得先调用或等待 `wx.login()`。两者均使用统一认证响应建立内存会话，再进入门户。旧 `userLogin/adminLogin/activateOrganization` 已退役；工作角色切换只调用 `/api/auth/contexts/activate`。

- 登录后绑定微信是独立、可跳过的用户选择；绑定失败保留口令会话。业务层不读取微信标识定位人员。
- 会话失效时返回登录页，由用户明确选择认证方式；禁止自动改用当前微信账号，禁止在其他账号或角色下重放旧请求。已由用户完成同一工作角色切换而仅令牌变化的并发请求最多重试一次。

---

## 5. EventBus — 跨页面通信

```javascript
const eventBus = require('../../utils/eventBus');
eventBus.on('venue:changed', this._handler);   // onShow 注册
eventBus.off('venue:changed', this._handler);  // onUnload 注销（必须！）
eventBus.emit('venue:changed', { reason });
```

---

## 6. Page 生命周期

```javascript
Page({
  onLoad(options)  { /* 一次性初始化 */ },
  onShow()         { /* 每次显示时刷新数据、重启轮询 */ },
  onHide()         { /* 停止轮询、清理定时器 */ },
  onUnload()       { /* 清理 EventBus 监听、清理定时器 */ }
});
```

- 页面、Behavior 和组件创建的每个 `setTimeout`、`setInterval`、轮询器、请求重试和 EventBus 监听都必须保存句柄或稳定回调引用；`onHide` 与 `onUnload` 必须清理。异步回调执行前还要核对页面仍可用、组织与 `activeContextId` 未变化，禁止旧上下文的迟到回调更新当前界面。
- 冻结、解绑、重置凭据、撤销恢复码、永久删除、删除规则或用途等不可逆/高影响操作必须先使用受控确认层。确认层冻结并明确展示目标、范围和数量；取消不得发请求，执行期间不得切换目标或重复提交。仅依赖红色按钮、Toast 或服务端报错不算确认。
- 所有文本长度按 Unicode 码点统一计算，前端提示的上限必须与服务端校验完全一致；禁止直接用 UTF-16 `string.length` 造成 emoji、扩展字符前后端口径不同。

---

## 7. 关键工具函数

| 函数 | 来源 | 用途 |
|------|------|------|
| `callFunction({ name, data })` | api.js | 通用 API，返回 Promise |
| `showShortToast(title, icon)` | api.js | Toast（自动截断 ≤7 中文字符） |
| `formatAuditTime(raw, reviewStatus)` | api.js | 旧审核时间兼容入口；必须委托共享系统时区工具并透传逐记录待核对状态，不得读取设备时区 |
| `getErrorText(error, fallback)` | api.js | 提取错误文本 |
| `eventBus.on/off/emit` | eventBus.js | 跨页面事件 |
| `parseCsvContent/buildCsv/buildExcelXml` | tableFile.js | CSV/Excel 解析导出 |

---

## 8. 前端禁止事项

- ❌ WXML 中直接调用 `.split()` / `.replace()` / `.map()` → 用 WXS
- ❌ `<input>` 上设置 `display: flex` → 用 `display: block` + `line-height`
- ❌ `popup-mask` 内放 `position: fixed; bottom: 0` 元素
- ❌ 多次 `setData()` 不合并
- ❌ `wx.showToast` title 超 7 中文字符
- ❌ 在没有全页影响面审计时修改共享样式文件
- ❌ 拖拽 touchmove 不节流 `createSelectorQuery`
- ❌ `onUnload` 中忘记 `eventBus.off`
- ❌ 忘记在 `onHide`/`onUnload` 中清理定时器
- ❌ 用公共模块包装所有 `Page({})` 或把开发夹具注入生产页面依赖图
- ❌ 依赖未打包的 `@swc/runtime` / `@babel/runtime` helper
- ❌ 仅用 `node --check` 代替 `node scripts/miniprogram-compat-audit.js` 和微信开发者工具编译
- ❌ 用正则批量改写 WXML 标签或属性；`wx:if="{{a > b}}"` 中的 `>` 不是标签结束符，工具必须识别引号、Mustache 和 WXS
- ❌ 页面级标题、二级页签或成组按钮直接暴露在 `.page` / `.section-stack` 等透明布局层；必须使用 `.section-control-card` 或等价真实玻璃表面包裹
- ❌ 卡片小型查看/编辑/删除/移除继续使用页面私有 `list-actions` 排列；统一迁移到 `.card-actions`，禁止绝对定位到标题、状态或展开入口旁
- ❌ 同一视觉行中的选择器、筛选、清除/重置使用不同高度或私有上下 margin；直接同行控件采用 `.ui-inline-control-row` + `.ui-inline-control`，带标签字段采用 `.ui-inline-field-row` 对齐底边，最终高度统一使用 `--ui-inline-control-height`
- ❌ 标题旁的宫格/列表二态切换复用整行主页签高度、Pad 横屏 50px 或整行均分；必须采用 `.ui-compact-segmented` + `.ui-compact-segmented-item`
- ❌ 固定 px 图标槽内继续使用 `ui-icon size` 的 rpx 图标，或让 Pad 横屏图标随视口机械放大；业务媒体行必须使用 `sizeRole` 的手机/Pad 竖屏/Pad 横屏语义尺寸
- ❌ 把消息类别、组织、当前标识和岗位塞进同一个 `flex-wrap` 容器；组织与当前标识必须独占完整语义行，完整名称只可按词自然换行、不得截断或拆成碎字
- ❌ 页面底部双主操作复用 `--ui-inline-gap`，或品牌页脚依赖上一控件 margin；分别使用 `--ui-page-action-gap` 与 `--ui-footer-gap`，并由共同语义容器持有
- ❌ 把“已选”拼进身份、部门、职能组、岗位或状态气泡，或把选择控件嵌进姓名；卡片式选择器必须一张卡一个选项，并以第一个可见子项 `.select-chip.selection-card-toggle` 在左上显示“选择/取消”
- ❌ 已选卡片使用整行 `.card-actions` / “移除”表达取消，或让 `width:100%` 操作条挤压人物信息；候选区与已选区必须共用左上选择控件，正文 `flex:1; min-width:0`
- ❌ 按岗位选择人员时仍以人员 ID 作为选中键，或跨多个岗位拼接部门/身份类别/职能组条件；必须一岗一卡并提交 `assignmentId`。仅账号治理、认证授权等明确自然人级操作允许以人员 ID 选择

---

## 9. 语言资源硬约束

- 用户可见文案只允许定义在 `miniprogram/locales/zh-CN/**`；业务 JS、WXML 和页面 JSON 不得新增中文文案常量。
- WXML 通过页面或组件 `data` 中的语言对象读取文案；Toast、Modal、空状态、无障碍标签和动态提示同样适用。
- 页面 JSON 的 `navigationBarTitleText` 保持空值，页面加载时从语言资源调用 `wx.setNavigationBarTitle`。
- 动态句子必须在语言资源中定义模板或格式化函数，业务代码只传变量；路由、状态码、权限键、数据库枚举和业务标识不得伪装成语言资源。
- 新增文案使用可读语义键；`generated/**` 的内容寻址键仅用于历史等值迁移，不得手写复制到无关页面。
- 完成小程序修改必须运行 `node scripts/user-visible-copy-audit.js --localization-prefix=miniprogram/ --strict-localization`。

## 10. 主包与分包统一

- 主包启动壳统一放在 `miniprogram/subpackages/main/pages/**`，但必须注册在 `app.json.pages` 顶层；`subpackages/main` 不得注册为 `app.json.subPackages`，否则会从主包变成分包。
- 消息中心、工作台组合页及所有业务页面必须位于 `subpackages/<模块名>/pages/**` 并在 `app.json.subPackages` 注册；不能因为目录位于 `subpackages` 就误判为分包。
- 页面迁移必须同步更新可信导航、上下文守卫、服务端通知/待办目标 URL、测试路径和 WXSS 导入；迁移后不得留下旧主包业务路由。
- 使用 `node:*`、`require.cache` 等 Node 专用能力的回归测试必须放在仓库 `scripts/` 或服务端测试目录，禁止放入 `miniprogram/**` 运行目录，避免被微信开发者工具打包或触发代码保护错误。
- 提示、指引、校验反馈、空状态、Toast、Modal、确认层、通知标题/描述和导出标题等中文常量必须放进 locale；完成前运行 `node scripts/user-visible-copy-audit.js --strict-guidance`。

## 11. 人事领域、工作角色与内部上下文硬规范

- 前端只以 `activeContextId` 保存当前内部上下文，只以 `contextId` 传递或比较；`assignmentId` 是岗位 ID，`identityCategoryId/Name` 是身份类别。用户界面把可切换项统称“工作角色”，具体显示“岗位”或“管理权限”，不得显示“工作上下文”、`contextId`、快照、修订、归档、兼容字段等实现词。`activeIdentityId`、`selection.identityId` 等旧字段只允许一轮兼容读取，禁止继续写入、发事件或参与判权。
- 岗位编辑固定按“岗位性质 → 部门 → 身份类别 → 职能组”排列。职能组可空，但非空时必须属于所选部门；禁止自由文本“岗位名称”。岗位展示名由“身份类别 · 部门 · 职能组”自动生成，缺少职能组时省略。
- 人事目录一名自然人只显示一张成员卡；多个岗位只在成员详情内分组展示。无岗位在职成员仍然可见，并使用中性状态气泡，禁止虚构默认岗位或把身份类别冒充岗位。
- 成员资料目录必须一次包含在职与已离开成员，默认状态筛选为全部；禁止独立“已离开成员”模式或重复目录。已离开成员使用灰蓝气泡，详情只读并展示离任时间和离任前岗位，仅允许重新加入为在职无岗位。
- 查询字段、关键词、排序、高级筛选和批量工具共同放入 `.section-control-card`；高级筛选在卡内展开，已选条件使用可单项清除的紧凑气泡。岗位性质、部门、身份类别、职能组必须在同一岗位元组内同时匹配；同类多选 OR、不同类别 AND，禁止跨岗位拼接命中。
- 按自然人授权的人员选择器可以人员 ID 为选中键，但不得退回顶层岗位快照：候选卡必须列出全部岗位，并提供部门、身份类别、职能组三项同岗位元组筛选。
- 无岗位成员可以进入组织公共区域并维护个人资料，但审核、场地审批、评分等岗位规则驱动入口必须禁用或隐藏，并由服务端再次拒绝；前端不得从人员资料快照推导权限。
- 资料卡必须同时展示“审核状态”和“完整度”；存在待审提交时状态始终为待审核。生效资料维护与待审值审核使用不同操作区；对照界面使用生效值/待审值比较卡，驳回通过受控弹窗采集必填原因。
- 人事目录、成员详情、岗位字典和补充资料加载失败时，不得清空为“暂无数据”“未配置”或“未提交”。保留最近一次成功内容并显示原地重试；重新取得权威数据前，冻结保存、审核和高危操作。
- “离开当前组织”不得写成“删除成员”。离开后自然人、全局账号和历史仍保留；只有具备 `auth.accounts.global_manage` 的用户可看到冻结、解绑、重置全局账号等高危操作。
- 登录口令表单的主要保存操作使用标准主按钮，不得复用 `.compact-action`。普通用户使用全宽“保存口令”，管理详情使用与底部详情操作同规格的“保存口令 / 取消”双按钮行；手机与 Pad 均不得缩小字号或压缩垂直留白。
- 登录页与门户同属主包时，登录成功只允许发起一次 `wx.reLaunch`；禁止先 `redirectTo`、超时后再 `reLaunch`，也禁止把路由放进 `setData` 或 `nextTick` 回调。超时只解除按钮忙碌状态并提示，不得启动第二条导航链。
- 登录成功响应先形成 AppService 内存状态，再以不等待回调的 `setStorage` 异步投递包含会话与必要岗位目录的紧凑快照；登录临界路径禁止调用 `setStorageSync`，也禁止等待 `batchSetStorage/setStorage` 完成回调。兼容旧页面的分散键只能在导航发起后后台写入，且必须有登录代次保护，退出或再次登录后旧任务不得回写旧令牌。
- 切换组织、岗位或管理权限时，必须把令牌、当前角色、组织、`contextId`、人员资料、权限和完整岗位目录作为同一份认证状态原子替换，并立即使登录或上一次切换的延迟持久化任务失效。禁止只更新请求头快照或零散 storage 键而保留旧运行时角色；页面权限判断必须优先读取切换后的统一内存状态。
- 用户明确切换工作角色成功后必须 `reLaunch` 门户，销毁切换前的业务页面、请求和页签状态；即使原页面在新角色下仍可使用，也禁止 `navigateBack` 复用旧页面。重新进入子应用必须执行与冷启动进入相同的初始化链路。
- 跨组织或跨岗位消息需要跳转业务详情时，必须先把应用服务页重建为根页，再以普通导航进入目标详情；禁止直接把业务详情 `reLaunch` 成根页，否则系统返回按钮会落到登录页并丢失刚切换的岗位。
- 门户 Hero 的主题、工作角色文字和应用权限必须全部读取同一份当前统一会话：管理权限使用深蓝管理主题，岗位使用标准蓝主题。不得由 `roleProfiles`、`activeRole` 等兼容散列缓存兜底主题或判权。
- API 成功回调必须先兑现请求结果并立即返回，再在下一轮任务处理时区缓存、版本提醒和岗位提示等非关键副作用；每项副作用必须单独隔离同步异常。禁止在同一个 `wx.request` 成功回调中仅把 `resolve` 写在副作用之前，因为 Promise 续接仍需等待当前回调结束；任何非关键能力异常或阻塞都不得使已经收到 HTTP 响应的登录流程停留在加载态。
- 鸿蒙微信登录入口必须采用最小纯回调状态机：`wx.login`、认证 `wx.request`、建立 AppService 内存会话、进入门户。登录入口不得依赖 Promise 微任务、通用响应副作用、同步 storage 写入、异步 storage 完成回调或设备信息；认证请求沿用微信原生默认 JSON 响应解析，禁止强制 `dataType: 'text'` 或 `responseType: 'text'`；登录会话请求需有独立总超时，并在所有成功、失败、超时分支统一释放按钮加载态。
- 微信认证入口不得携带本地旧令牌、旧组织或旧岗位作为请求前置条件；只发送微信 code、客户端版本和请求号。成功回调必须兼容原生对象与字符串两种结果，但不得为获得字符串结果而改变原生响应模式；解析失败必须进入明确失败分支并释放加载态。
- 登录临界路径不得执行任何同步 storage 写入；门户、API 请求头和业务分包入口必须优先读取 AppService 内存会话，其次读取异步紧凑快照，不得依赖兼容分散键是否已经落盘。启动时区配置以运行时内存为准，不得在登录前发起 storage 写入与登录快照竞争原生锁。
- 微信登录、口令登录、认领、恢复和会话自动续期不得读取、生成或提交设备安装标识作为放行条件。设备型号等信息只能在登录完成后作为可选展示信息异步采集；采集失败、设备变化或多设备并发使用均不得阻断登录、续期或进入子应用。
- 门户及消息入口进入业务分包统一使用可信路由工具，每次用户操作只允许一次 `navigateTo`。鸿蒙加载分包时不得以短超时追加 `redirectTo/reLaunch`；超时仅在确认目标页尚未生效后解除忙碌状态并提示重试。明确失败同样不得自动重建整个页面栈。
- 兼容鸿蒙旧运行时必须保持 `es6/enhance/swc/nodeModules/compileHotReLoad/useCompilerModule/useMultiFrameRuntime/useApiHostProcess/useIsolateContext` 关闭，不强制声明 `componentFramework: glass-easel`；主入口先加载 `runtimeCompat`，再加载业务依赖。页面直接使用可选微信 API 前必须做能力判断或使用兼容层，自定义组件必须在页面或全局配置中完整声明。
- 全宽按钮位于纵向 Flex 表单时必须显式 `flex: none`，并使用 `box-sizing: border-box; width: 100%; min-width: 100%; max-width: 100%`。禁止继承双列操作行的 `flex-basis: 50%`，因为它会沿纵轴解释成异常高度；修改按钮布局后必须核对最终级联盒模型，而非只检查局部宽度声明。
- 永久删除只放在成员详情危险操作区，并且必须先展示全引用预检；业务记录阻断，允许清理的未执行引用按事务清理，零候选规则停用。组织删除不得影响其他组织；彻底删除自然人仅限超级管理员并要求学号确认。
- 人事页面标题、筛选、批量操作和岗位组至少置于一层语义玻璃容器。长表单弹窗使用固定标题、直接子级可滚动正文和固定底部操作区；正文高度随内容增长并受视口安全上限约束，手机、Pad 竖屏、Pad 横屏都必须能滚动到底并操作保存/取消。

## 12. 绝对时间与系统时区硬规范

- 绝对时间只通过共享时间工具按 `systemTimezoneOffset` 转换，禁止使用设备本地时区、`toLocaleString` 或 `toLocaleDateString`。系统配置版本变化后必须刷新缓存并重新预计算页面时间文本。
- 列表预计算 `YYYY-MM-DD HH:mm`，详情、验签和安全记录预计算 `YYYY-MM-DD HH:mm:ss`；WXML 只允许绑定 `createdAtText/processedAtText/...`，禁止直接绑定原始 `createdAt/updatedAt/processedAt/signedAt/expiresAt` 或显示 ISO `T...Z`。
- `YYYY-MM-DD` 纯日期、`HH:mm` 每日时刻、时长、提前量和周期规则不做时区转换。历史来源不明的绝对时间仍正常格式化，但必须使用同一业务对象的 `createdAtReviewStatus/processedAtReviewStatus/...` 逐字段传入格式器并显示“历史时区待核对”；禁止把全局待核对状态套到所有时间，也禁止漏传后静默显示。
- 修改时间展示后必须运行时间审计，并以 UTC−12、UTC、UTC+8、UTC+12 验证跨日、跨月、跨年；纯日期和每日时刻不得漂移。
