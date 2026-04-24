# REDSU Scoring 项目记忆

## 项目基本信息

- 项目名称：REDSU考核评分小程序
- 项目类型：微信小程序 + 云开发云函数
- 项目根目录：`D:\WeChat\WHUSUScoring\ScoringServerCloud`
- 当前主要目录：
  - `miniprogram/`：小程序前端
  - `cloudfunctions/`：云函数
  - `project.config.json`：微信开发者工具项目配置
  - `memory.md`：当前项目上下文记忆

## 当前前端页面

- `pages/login/login`：登录页
- `pages/home/home`：首页
- `pages/score/score`：评分页
- `pages/admin/admin`：管理端主页
- `pages/scorerTasks/scorerTasks`：评分人未完成任务页
- 仍存在但已基本不作为主流程使用的页面：
  - `pages/index/index`
  - `pages/logs/logs`
  - `pages/example/example`
  - `pages/settings/settings`

## 当前核心业务模型

### 1. 登录与身份

- 支持两类入口：
  - 普通用户
  - 管理员
- 普通用户登录相关云函数：
  - `userLogin`
  - `bindUserInfo`
- 管理员登录相关云函数：
  - `adminLogin`
  - `bindAdminInfo`
- 支持解绑当前身份：
  - `unbindRole`

### 2. 管理员模型

- 管理员集合：`admin_info`
- 当前管理员核心字段：
  - `姓名`
  - `学号`
  - `name`
  - `studentId`
  - `adminLevel`
  - `inviteCode`
  - `openid`
  - `bindStatus`
- 管理员类别：
  - `admin`
  - `super_admin`

说明：
- 管理员结构已被简化，不再依赖部门、身份、职能组等普通成员业务字段。
- 管理员可从 `hr_info` 快速选人，也可手动录入，不要求和普通用户绑定。

### 3. 普通成员与绑定

- 人事信息集合：`hr_info`
- 普通用户绑定集合：`user_info`
- `hr_info` 常用字段：
  - `姓名`
  - `学号`
  - `所属部门`
  - `身份`
  - `工作分工（职能组）`

### 4. 评分活动

- 集合：`score_activities`
- 当前活动通过 `isCurrent: true` 标记
- 所有评分规则、评分记录均已按 `activityId` 进行隔离
- 删除活动时，需要级联删除该活动下的：
  - `rate_target_rules`
  - `score_records`

### 5. 评分问题

- 集合：`score_question_templates`
- 模板在前端面向用户统一称为“评分问题”
- 每道题当前支持字段：
  - `question`
  - `scoreLabel`
  - `minValue`
  - `startValue`
  - `maxValue`
  - `stepValue`

说明：
- `startValue` 缺失时按 `0` 理解
- `stepValue` 缺失时按 `0.5` 理解
- 分值说明、活动说明、模板说明支持换行

### 6. 评分人类别与被评分人规则

- 集合：`rate_target_rules`
- 每条记录代表某个评分活动下的一类评分人类别
- 评分人类别唯一键逻辑：
  - `activityId + scorerDepartment + scorerIdentity`
- 前端面向用户统一称：
  - “评分人类别”
  - “被评分人规则”
  - “评分问题”

每条评分人类别记录下可有多个被评分人规则，规则中可配置：
- 被评分范围
- 被评分身份
- 多个评分问题配置
- 每个评分问题的权重
- 每个评分问题的呈现顺序
- `requireAllComplete`

`requireAllComplete` 说明：
- 对某一类评分人/被评分人关系，如果该字段为 `true`
- 某个评分人没有评完该规则下所有应评对象，则其在该规则下所有评分记录都不计入最终核算
- 缺失或默认情况下按 `false` 处理

### 7. 评分记录

- 集合：`score_records`
- 当前一条评分记录通常包含：
  - `activityId`
  - `activityName`
  - `ruleId`
  - `templateConfigSignature`
  - `templateConfigs`
  - `scorerId`
  - `scorerOpenId`
  - `scorerName`
  - `scorerStudentId`
  - `scorerIdentity`
  - `targetId`
  - `targetName`
  - `targetStudentId`
  - `targetIdentity`
  - `answers`
  - `templateScores`
  - `rawTotalScore`
  - `weightedTotalScore`
  - `submittedAt`

记录唯一性要求：
- 同一 `activityId`
- 同一评分人
- 同一被评分人
- 只允许存在一条有效记录
- 后提交覆盖先提交

历史记录兼容逻辑：
- 解绑后重新绑定时，已改为优先通过 `openid`、`学号` 等稳定标识回查历史评分
- 如果旧记录与当前模板签名不匹配，会删除旧记录并按未评分处理

## 当前普通用户主链路

### 首页

- 进入首页后自动拉取：
  - 当前评分活动
  - 当前用户基本信息
  - 当前活动下该用户可评的被评分人列表
- 被评分人列表会显示：
  - 姓名
  - 部门
  - 身份
  - 职能组
  - 评分状态：`待评分` / `已评分`
- 列表按 `待评分` 优先排序

### 评分页

- 点击被评分人后进入评分页
- 评分页会拉取当前活动、当前评分人、当前被评分人对应的评分问题
- 若规则存在但未配置评分问题，会提示：
  - `当前被评分人规则尚未配置评分问题，请联系管理员完善设置`
- 若目标确实不在规则内，才提示不在评分范围内

评分校验当前支持：
- 填完单题立即校验
- 提交前全量校验
- 输入错误会在题目边显示警告
- 错误文案统一为：
  - `低于起评分`
  - `不符合步进值`
  - `超出评分范围`
- 提交时若有错误，会自动滚动到第一道有问题的题

## 当前管理端能力

### 已实现模块

- 评分活动管理
- 评分问题管理
- 评分人类别与被评分人规则管理
- 人事成员管理
- 管理员管理
- 评分结果查看
- 未完成评分人任务查看
- 导出 CSV / Excel

### 结果查看页

- 支持查看：
  - 总分速览
  - 总分计算表
  - 评分明细
  - 评分记录管理
- 支持按以下视图筛选：
  - 所属部门
  - 身份
  - 工作分工（职能组）
- 支持按当前筛选条件导出
- 分数统一按四舍五入保留 3 位小数

### 完成率看板

- 当前已改成评分人视角，而不是被评分人视角
- 统计口径：
  - 只按“评分人是否完成全部评分任务”计算
  - 不是按待完成条数统计
- 当前展示：
  - 按部门聚合的完成率
  - 完成率百分比
  - `已完成人数/应评人数`
- 卡片支持点击查看该部门在当前筛选条件下的具体评分人明细
- 明细中按未完成在前、已完成在后排序

### 未完成评分人任务页

- 独立页面：`pages/scorerTasks/scorerTasks`
- 可按以下条件筛选评分人任务：
  - 所属部门
  - 身份
  - 工作分工（职能组）
  - 姓名/学号关键词
- 支持查看：
  - 当前视图下未完成评分人
  - 每个评分人的完成率
  - 具体未完成对谁的评分
- 支持导出：
  - 概览 CSV / Excel
  - 明细 CSV / Excel

## 当前重要云函数清单

### 登录与身份

- `userLogin`
- `adminLogin`
- `bindUserInfo`
- `bindAdminInfo`
- `unbindRole`

### 活动

- `listScoreActivities`
- `saveScoreActivity`
- `setCurrentScoreActivity`
- `deleteScoreActivity`
- `getCurrentScoreActivity`

### 评分问题

- `listScoreTemplates`
- `saveScoreTemplate`
- `deleteScoreTemplate`
- `duplicateScoreTemplate`
- `saveScoreTemplateOrder`

### 评分人类别与规则

- `listRateRules`
- `saveRateRule`
- `deleteRateRule`
- `generateRateTargetRules`

### 评分流程

- `getRateTargets`
- `getScoreFormData`
- `submitScoreRecord`
- `getScoreResults`
- `exportScoreResults`
- `getScorerTaskStatus`
- `exportScorerTaskStatus`
- `revokeScoreRecord`

### 人事与管理员

- `listHrInfo`
- `saveHrInfo`
- `deleteHrInfo`
- `importHrCsv`
- `listAdmins`
- `saveAdmin`
- `deleteAdmin`
- `exportAdmins`
- `adminUnbindUser`

## 当前数据库集合清单

- `hr_info`
- `user_info`
- `admin_info`
- `score_activities`
- `score_question_templates`
- `rate_target_rules`
- `score_records`

## 当前已知高风险点

### 1. 云函数性能热点

以下函数最容易在数据量大时变慢或超时：
- `getScoreResults`
- `exportScoreResults`
- `getScorerTaskStatus`
- `exportScorerTaskStatus`
- `getRateTargets`
- `getScoreFormData`
- `submitScoreRecord`

主要原因：
- 大量 `limit(1000)` / `limit(2000)` 整表读取
- 多层循环在内存中做规则匹配
- 导出时全量重算
- 部分写入逻辑缺少更强的并发幂等保护

### 2. 编码与历史补丁问题

- 项目历史上存在部分文件编码混乱问题
- `memory.md` 曾出现乱码，已在 2026-04-25 重写为 UTF-8 中文版
- `admin.js`、`admin.wxml` 过去多次叠加修改，虽然目前可用，但仍需警惕旧逻辑残留

## 当前推荐索引

建议优先在云数据库中为这些字段建索引：

### `score_records`

- `activityId`
- `activityId + targetId`
- `activityId + scorerStudentId`
- `activityId + scorerOpenId`
- `activityId + scorerId`
- `activityId + targetId + scorerStudentId`

### `rate_target_rules`

- `activityId`
- `activityId + scorerDepartment + scorerIdentity`

### `hr_info`

- `学号`
- `所属部门 + 身份`
- `所属部门 + 工作分工（职能组） + 身份`

### `user_info`

- `openid`
- `学号`

### `admin_info`

- `openid`
- `学号`

## 最近重要修复记录

- 完成率看板改为评分人视角
- 看板支持按当前筛选条件联动
- 新增评分人未完成任务页及导出
- 核算规则支持 `requireAllComplete`
- 评分结果支持筛选导出
- 分数展示统一保留 3 位小数
- 评分页支持即时校验与提交前自动定位错误题目
- 评分页顶部评分人/被评分人信息样式已重做
- 页面标题统一为“页功能 - REDSU考核评分”

## 后续继续开发时的建议

- 修改评分规则时，要同步关注：
  - 首页被评分人拉取
  - 评分页模板装配
  - 评分记录唯一性
  - 结果核算逻辑
  - 完成率统计逻辑
- 修改管理端结果页时，优先检查：
  - `admin.js`
  - `admin.wxml`
  - `getScoreResults`
  - `getScorerTaskStatus`
- 修改评分页时，优先检查：
  - `score.js`
  - `score.wxml`
  - `score.wxss`
  - `getScoreFormData`
  - `submitScoreRecord`

## 项目迁移到另一台电脑的建议步骤

### 需要带走的内容

至少拷贝或提交到 Git 的内容：
- 整个项目目录 `ScoringServerCloud`
- `miniprogram/`
- `cloudfunctions/`
- `project.config.json`
- `project.private.config.json`（如果你希望保留本机配置可一起带，但也可不带）
- `memory.md`

### 新电脑上需要准备的环境

1. 安装微信开发者工具
2. 用同一个微信开发者账号登录
3. 确保有对应云开发环境权限
4. 安装 Node.js
5. 如果云函数有依赖，进入对应云函数目录执行依赖安装，或在微信开发者工具里直接“上传并部署：云端安装依赖”

### 迁移步骤

1. 把整个项目目录复制到新电脑
2. 用微信开发者工具打开 `D:\WeChat\WHUSUScoring\ScoringServerCloud` 对应的新路径
3. 检查 `project.config.json` 中的 `appid` 是否正确
4. 检查云开发环境 ID 是否还是原来的环境
5. 重新编译小程序
6. 将所有必要云函数重新上传部署
7. 检查数据库集合是否已存在：
   - `hr_info`
   - `user_info`
   - `admin_info`
   - `score_activities`
   - `score_question_templates`
   - `rate_target_rules`
   - `score_records`
8. 检查索引是否也已在目标环境建好

### 最稳的迁移方式

最推荐：
- 用 Git 管理代码
- 在新电脑上 `clone` 项目
- 云数据库仍然使用同一个云开发环境

如果不是同一个云开发环境，而是迁移到全新环境，还需要额外做：
- 新建数据库集合
- 手动重建索引
- 导出原环境数据并导入新环境
- 重新初始化管理员数据

## 当前文档状态

- 本文件已于 2026-04-25 重建为 UTF-8 中文版
- 用途：帮助后续继续开发、换电脑接力、网络中断后快速恢复上下文
