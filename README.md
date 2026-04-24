# REDSU 考核评分小程序

基于微信小程序云开发的考核评分系统，支持普通用户评分、管理员配置规则与评分问题、查看结果、导出报表，以及按评分人视角查看未完成任务。

## 项目概览

本项目用于组织内部考核评分，核心目标包括：

- 支持普通用户登录并完成对指定成员的评分
- 支持管理员配置评分活动、评分问题、评分人类别与被评分人规则
- 支持按活动隔离评分规则与评分记录
- 支持实时查看评分结果、完成率和未完成任务
- 支持导出评分结果、未完成任务、人事信息、管理员信息

## 技术组成

- 前端：微信小程序
- 后端：微信云开发云函数
- 数据存储：微信云开发数据库
- 项目结构：
  - `miniprogram/`：小程序前端页面与样式
  - `cloudfunctions/`：云函数
  - `project.config.json`：微信开发者工具项目配置
  - `memory.md`：项目上下文与开发记忆

## 项目结构图

```text
ScoringServerCloud/
├─ miniprogram/                     # 小程序前端
│  ├─ app.json
│  ├─ app.wxss
│  └─ pages/
│     ├─ login/                    # 登录页
│     ├─ home/                     # 首页
│     ├─ score/                    # 评分页
│     ├─ admin/                    # 管理端主页
│     ├─ scorerTasks/              # 评分人未完成任务页
│     ├─ index/                    # 历史示例页
│     ├─ logs/                     # 历史示例页
│     ├─ example/                  # 历史示例页
│     └─ settings/                 # 历史残留页
├─ cloudfunctions/                 # 云函数目录
│  ├─ userLogin/                   # 普通用户登录
│  ├─ adminLogin/                  # 管理员登录
│  ├─ bindUserInfo/                # 普通用户绑定
│  ├─ bindAdminInfo/               # 管理员绑定
│  ├─ unbindRole/                  # 解绑当前身份
│  ├─ listScoreActivities/         # 活动列表
│  ├─ saveScoreActivity/           # 保存活动
│  ├─ setCurrentScoreActivity/     # 设置当前活动
│  ├─ deleteScoreActivity/         # 删除活动
│  ├─ getCurrentScoreActivity/     # 获取当前活动
│  ├─ listScoreTemplates/          # 评分问题列表
│  ├─ saveScoreTemplate/           # 保存评分问题
│  ├─ deleteScoreTemplate/         # 删除评分问题
│  ├─ duplicateScoreTemplate/      # 复制评分问题
│  ├─ saveScoreTemplateOrder/      # 保存评分问题排序
│  ├─ listRateRules/               # 评分人类别与被评分人规则列表
│  ├─ saveRateRule/                # 保存评分人类别与规则
│  ├─ deleteRateRule/              # 删除评分人类别
│  ├─ generateRateTargetRules/     # 生成默认评分人类别
│  ├─ getRateTargets/              # 拉取被评分人列表
│  ├─ getScoreFormData/            # 拉取评分页数据
│  ├─ submitScoreRecord/           # 提交评分记录
│  ├─ getScoreResults/             # 获取评分结果
│  ├─ exportScoreResults/          # 导出评分结果
│  ├─ getScorerTaskStatus/         # 获取评分人任务状态
│  ├─ exportScorerTaskStatus/      # 导出评分人任务状态
│  ├─ revokeScoreRecord/           # 撤销评分记录
│  ├─ listHrInfo/                  # 人事成员列表
│  ├─ saveHrInfo/                  # 保存人事成员
│  ├─ deleteHrInfo/                # 删除人事成员
│  ├─ importHrCsv/                 # 导入人事 CSV
│  ├─ listAdmins/                  # 管理员列表
│  ├─ saveAdmin/                   # 保存管理员
│  ├─ deleteAdmin/                 # 删除管理员
│  └─ exportAdmins/                # 导出管理员
├─ project.config.json             # 微信开发者工具配置
├─ project.private.config.json     # 本机私有配置
├─ memory.md                       # 项目上下文记忆
├─ README.md                       # 项目说明文档
└─ .gitignore
```

## 当前主要页面

- `pages/login/login`
  - 登录页
  - 支持普通用户 / 管理员入口
- `pages/home/home`
  - 首页
  - 展示当前用户基本信息、当前评分活动、被评分人列表
- `pages/score/score`
  - 评分页
  - 按规则拉取评分问题并提交评分
- `pages/admin/admin`
  - 管理端主页面
  - 集中管理活动、评分问题、评分人类别、结果、人事、管理员
- `pages/scorerTasks/scorerTasks`
  - 评分人未完成任务页
  - 从评分人视角查看未完成情况并导出

## 核心业务说明

### 1. 登录与身份

系统支持两类角色入口：

- 普通用户
- 管理员

相关云函数：

- `userLogin`
- `bindUserInfo`
- `adminLogin`
- `bindAdminInfo`
- `unbindRole`

### 2. 评分活动

评分活动存储在 `score_activities` 集合中。

特点：

- 每条评分规则只属于一个评分活动
- 每条评分记录只属于一个评分活动
- 当前活动通过 `isCurrent: true` 标记
- 删除活动时应级联删除该活动下的规则和评分记录

相关云函数：

- `listScoreActivities`
- `saveScoreActivity`
- `setCurrentScoreActivity`
- `deleteScoreActivity`
- `getCurrentScoreActivity`

### 3. 评分问题

评分问题存储在 `score_question_templates` 集合中。

每个评分问题模板可包含多道题，每道题支持：

- 问题内容
- 分值说明
- 最低值
- 起评分
- 最高值
- 步进值

支持：

- 模板复制
- 多行说明
- 题目顺序维护

相关云函数：

- `listScoreTemplates`
- `saveScoreTemplate`
- `deleteScoreTemplate`
- `duplicateScoreTemplate`
- `saveScoreTemplateOrder`

### 4. 评分人类别与被评分人规则

评分人类别及其规则存储在 `rate_target_rules` 集合中。

当前模型：

- 一条记录代表某个评分活动下的一类评分人类别
- 评分人类别由 `activityId + scorerDepartment + scorerIdentity` 唯一确定
- 每个评分人类别下可以配置多个“被评分人规则”
- 每条被评分人规则可以挂多个评分问题，并设置：
  - 权重
  - 展示顺序
  - 是否要求全评后才计入核算

`requireAllComplete` 规则：

- 若某条被评分人规则要求全评
- 某评分人在该规则下未完成全部评分任务
- 则该评分人在该规则下的所有评分记录都不参与最终核算

相关云函数：

- `listRateRules`
- `saveRateRule`
- `deleteRateRule`
- `generateRateTargetRules`

### 5. 评分记录

评分记录存储在 `score_records` 集合中。

特点：

- 同一活动、同一评分人、同一被评分人只保留一条有效记录
- 后提交覆盖先提交
- 记录中保存当前活动、规则、模板签名、题目答案、模板小计、总分等信息
- 若旧记录与当前模板不匹配，会在进入评分页时清理

相关云函数：

- `getRateTargets`
- `getScoreFormData`
- `submitScoreRecord`

## 普通用户流程

### 首页

首页会自动拉取：

- 当前评分活动
- 当前用户信息
- 当前活动下该用户可评的被评分人列表

被评分人列表支持：

- 显示评分状态：`待评分` / `已评分`
- 待评分优先排序
- 点击被评分人进入评分页

### 评分页

评分页支持：

- 自动拉取当前活动下对应的评分问题
- 显示评分人 / 被评分人信息
- 输入后即时校验
- 提交前全量校验
- 自动提示：
  - `低于起评分`
  - `不符合步进值`
  - `超出评分范围`
- 若有错误，自动滚动到第一道问题
- 若存在历史有效评分，自动回填

## 管理端能力

### 已实现功能

- 评分活动管理
- 评分问题管理
- 评分人类别与被评分人规则管理
- 人事成员管理
- 管理员管理
- 评分结果查看
- 评分记录管理
- 未完成评分人任务查看
- CSV / Excel 导出

### 结果查看

结果页支持：

- 总分速览
- 总分计算表
- 评分明细
- 评分记录管理

支持按以下条件筛选：

- 所属部门
- 身份
- 工作分工（职能组）

支持按当前筛选条件导出：

- CSV
- Excel

### 完成率看板

完成率看板当前为评分人视角。

含义：

- 统计某部门下有评分任务的评分人中，有多少人已完成全部评分任务
- 不是按“待完成条数”统计

支持：

- 按当前筛选条件联动
- 点击部门卡片查看具体评分人完成情况
- 明细按未完成在前、已完成在后排序

### 未完成评分人任务页

独立页面 `pages/scorerTasks/scorerTasks` 支持：

- 查看未完成评分任务的评分人
- 查看每个评分人的完成率
- 查看其具体未完成对谁的评分
- 按当前视图导出概览 / 明细

## 主要数据库集合

- `hr_info`
- `user_info`
- `admin_info`
- `score_activities`
- `score_question_templates`
- `rate_target_rules`
- `score_records`

## 主要云函数

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

## 本地开发

### 环境要求

- 微信开发者工具
- Node.js
- 微信云开发环境权限

### 打开项目

1. 使用微信开发者工具打开项目根目录
2. 确认：
   - `miniprogramRoot` 为 `miniprogram/`
   - `cloudfunctionRoot` 为 `cloudfunctions/`
3. 确认云开发环境绑定正确
4. 编译小程序

### 云函数部署

推荐在微信开发者工具中：

- 右键云函数
- 选择“上传并部署：云端安装依赖”

若新增了云函数、修改了后端逻辑或迁移到新设备，建议重新上传相关云函数。

## 推荐索引

建议优先为以下字段建立索引：

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

## 当前已知需要持续关注的问题

- 部分结果类云函数仍存在全量读取和多层循环，数据量大时容易变慢
- `admin.js` 历史修改较多，后续继续扩展时建议留意旧逻辑残留
- 项目历史上存在部分编码不统一问题，后续新增和重构文件建议统一使用 UTF-8

## 项目迁移

迁移到新电脑时，建议至少保留：

- `miniprogram/`
- `cloudfunctions/`
- `project.config.json`
- `memory.md`
- `README.md`

迁移步骤建议参考 [memory.md](./memory.md) 中的详细说明。
