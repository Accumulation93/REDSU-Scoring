# 签署身份隐私与平台密码验签（协议 v2）

## 证明范围与隐私

平台托管 RSA 私钥，证明经认证账号在指定组织、岗位的审批操作，不是个人独占私钥签署。平台和密钥管理员属于信任边界；平台完全失陷、全部密钥泄露或数据库与文件被一致回滚，不在本协议独立防护范围内。

新凭证公开姓名及必要的签署时组织/岗位，不公开学号、自然人主键、内部上下文或身份明文。同名人员通过加密快照中的唯一自然人与真实审批事件精确核验。改名、学号纠错、调岗或离任不改写历史事实。

历史 PDF 是明确的隐私例外：保留原字节及原授权访问，不换旧证书、不补造凭证。旧文件可能含学号，新响应不得再提取它。上传者自行写入的正文/图片不属于平台生成的签名元数据，不得声称系统已经自动清除所有用户输入的敏感信息。

## 编码与密码协议

- 规范编码为 RFC 8785 JCS：固定字段/类型、UTF-16 键排序、有限 JSON 数字，拒绝孤立代理字符和深度超过 24 的值。
- 每份凭证产生 32 字节随机 `ref`，以十六进制公开，不由学号或自然人主键派生。
- 独立 32 字节 HMAC-SHA-256 密钥认证 JCS `{purpose:'WHUSU-PDF-SIGNER',version:2,identity,claims}`。identity 含签署时 `personId/name/studentId/organizationId/assignmentId/contextId`。
- `binding` 为同一 HMAC 密钥认证 JCS `{ref,eventId,fileId,submissionId}` 的结果，公开载荷不直接携带这些主键。
- 另一独立 32 字节 AES-256-GCM 密钥加密 identity，随机 12 字节 IV、16 字节标签；AAD 是 JCS `{purpose:'WHUSU-PDF-IDENTITY',version:2,organizationId,ref}`。
- HMAC/AES 不得互用或复用 JWT、身份认证、PDF 私钥信封密钥。摘要比较为固定长度恒定时间比较。
- 公开载荷精确字段：`version/ref/keyVersion/name/organization/assignment/action/time/round/step/previous/inputDigest/inputDigestType/outputDigest/outputDigestType/materialsDigest/binding/identityCommitment`。
- 规范载荷作为 CMS SignedData 封装内容，RSA PKCS#1 v1.5 + SHA-256 签署；新密钥 3072 位。受签名属性包含 contentType、messageDigest、SigningCertificateV2（证书 SHA-256 绑定）。Node 是唯一生产签署路径，OpenSSL 仅作独立互操作验证。

依据：[JCS RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)、[CMS RFC 5652](https://www.rfc-editor.org/rfc/rfc5652.html)、[SigningCertificateV2 RFC 5035](https://www.rfc-editor.org/rfc/rfc5035.html)。标准算法不等于公共信任或个人不可否认性。

## 步骤和最终 PDF

实际通过、签名、盖章、组合动作和驳回均为所有当前附件生成凭证；无附件失败关闭。普通步骤输入/输出是完整文件 SHA-256，无图层变化也有凭证。最后通过 PDF 的输出类型为 `pdf_byte_range_sha256`，其他为 `file_sha256`，输入始终是 `file_sha256`。

顺序固定为准备签名域/占位 → 确定 ByteRange → 最后一步凭证 → 完整清单 → 最终 CMS，避免自引用。清单为 JCS `{version:2,legacyPrefix:boolean,receipts:base64CMS[]}`，包含最后一步。最终 CMS **受签名属性**绑定 OCTET STRING 编码的 JCS `{manifest,sha256}`，禁止改为未签名备注。

项目清单 OID：`2.25.321151982904974529973936122011384373967`，来自 UUID `f19b9f3f-2ac4-4dce-a750-926c00b162cf`，不得复用为其他用途。

同一文件同轮次凭证按步骤连续，`previous` 为前一份完整 CMS 摘要，下一步输入等于前一步输出。验证数量、顺序、文件、轮次、受控证书、密钥版本、HMAC、身份快照及真实事件/处理岗位；未知版本、缺失密钥、损坏密文、关联不一致均失败关闭，不按姓名或当前岗位兜底。

重提交沿用文件 ID 时以 `revision_round` 隔离凭证。再次最终签署会生成新文件版本：固化已有签名域的可视表单外观、移除已因重排失效的旧签名域，再签新版；原字节和凭证仍保留，不能可靠处理时明确失败。新轮尚无操作不能用旧轮凭证宣称通过。在途首条新凭证不在第一步时标记 `legacyPrefix`，只可报告 `legacy_partial`。

## API 和结果

继续使用 `POST /api/verifySignatureChain`：

| 输入 | 行为和来源 |
| --- | --- |
| `submissionNumber` / `submissionId` | 验证服务器保存字节，`stored_file` |
| `fileBase64` | 验证上传实际字节，`uploaded_file`；选择匹配记录时仍需携带字节 |
| `fileBase64` + `fileHash` | 服务器重算 SHA-256，不一致拒绝 |
| 仅 `fileHash` | 仅查询，`record_lookup`、`valid:false`、未验证上传文件 |

平台资料须校验当前组织验签权限和资源范围。未匹配文件仍须直接检查上传字节，返回 `verificationScope:'file_only'`，不能以未找到申请记录阻断文件检查。该结果不含平台人员或证书导出材料，未验证编号不能用于人员查找。文件签名有效与平台经办人身份核实是两项独立结论；只确认前者时 `overallStatus:'indeterminate'`、`valid:false`，界面显示“文件签名有效”并明确当前组织未匹配申请，不能误报签名无效。

响应：`verificationVersion:2`、`verificationSource`、`overallStatus`、`files`；旧 `valid` 仅在新版平台必需检查全通过时为真。状态为 `passed/failed/indeterminate/legacy_partial`。每文件有 `documentIntegrity/cmsSignature/receiptChain/identityBinding/platformCertificate/externalTrust`，每项含 `status/reasonCode`；每步仅在身份核验成功后返回姓名、签署时岗位、动作、平台时间、随机编号和技术摘要。

CMS 拒绝异常 ByteRange、非唯一签名对象、缺失/重复属性、非法 DER、摘要/签名错误和证书标识不匹配；禁止回退第一张证书。新版最终签署范围覆盖全文件，只排除签名占位，尾部追加不能完整通过。历史增量签名分别报告范围内 `cmsValid` 和 `wholeDocument`，不隐藏后续修改。

平台登记证书认可与外部 CA 信任独立。当前未实现商业 CA 根策略、吊销资料和第三方时间戳核验，`externalTrust` 为未确认、不参与平台托管结论。携带证书链、证书有效期或自签名成功不得显示外部可信。时间只称“平台记录时间”。

### 用户结果、技术报告与证书导出

默认页面仅展示文件内容、文件签名、处理记录和身份核实结果，以及每一步的姓名、动作、签署时组织/岗位和处理时间。“验证通过”表示本次核对通过，不代表审批决定通过；驳回记录仍明确显示“驳回”。技术词汇、托管模式限制、六项详细检查和证书操作进入独立验证报告。原因码仍保留 API 稳定契约，但界面只能用 locale 中的中文解释，禁止直接显示系统代码。

每个已验证步骤增加 `personIndex`：服务端完成身份与事件核验后，按私有自然人记录分配本次响应内的序号。同一人跨岗位/附件共用序号，同名不同人不合并。序号不是公开人员 ID，不能用于跨报告关联或查询人事资料。

`files[].certificates` 仅在本文件最终 PDF 与平台身份均验真后提供 `{fingerprint,derBase64}`。它是实际 PDF 签名使用的 X.509 公开叶证书，须同时匹配组织受控登记及未撤销的受保护密钥版本，DER 上限 64 KiB。未匹配、失败或历史未登记文件不导出其任意内嵌证书；不读取或输出私钥。小程序报告以 `.cer` 文件交给微信原生分享，完成或取消后清理本地临时副本，不自动安装证书。

导出的证书支持收件人在阅读器中手动核对指纹、配置对该平台签名的信任；此信任只作用于收件人的设置，不是公共 CA 认证。不得从签名文件本身判断应当信任其证书，也不得指导开启 JavaScript、动态内容等无关权限。第三方软件通常只识别最终平台签名，不负责解释本项目逐步身份清单；逐步经办人仍在平台核实。

公共自动信任需要对应阅读器认可的文档签名证书与完整验证条件。例如 Acrobat 的 AATL/EUTL 信任体系依赖认可机构签发、证书链及相应验证策略，不是随附任意公共根证书；网站 TLS 证书也不能替代文档签名证书。本项目保留 `documentCertificatePath/documentPrivateKeyPath/documentCertificateChainPath` 的独立文档身份接入，CMS 原样携带配置证书链、不冒充个人证书。采购/机构身份审核、硬件或远程签署接入及公共信任实测尚未完成，禁止标记公共可信或自动代购。

官方依据：[Adobe AATL](https://helpx.adobe.com/acrobat/kb/approved-trust-list1.html)、[Acrobat 受信任身份管理](https://helpx.adobe.com/acrobat/using/trusted-identities.html)。

## 持久化、限制和自动配置

`20260906180000_audit_signing_evidence.sql` 新建凭证和受控证书表，并同步全新安装 schema。凭证只新增，无更新/删除接口，组织+步骤+文件唯一约束阻止重复事实。凭证、事件、步骤和文件版本同事务，由文件提交协调器负责落盘/恢复；清理任务保留凭证引用路径。磁盘版本名长度固定，不累加旧后缀。

文件上限 10 MiB，清单 1 MiB，每文件每轮 256 条，CMS 2 MiB。DER 深度 24/节点 20000；PDF 签名 32/表单节点 4096。PDF 检查使用受限 Worker，5 秒超时、每进程并发 2 个，超额返回忙碌不无限排队；凭证链检查有 5 秒时限。超限失败，禁止截断后通过。

用户授权 CI 自动生产配置。部署持锁后、迁移/切换前运行 `provisionSigningEvidence.js` 和 `preflightSigningEvidence.js`：

- 主清单：共享目录 `signing-evidence/keyring.json`，变量 `AUDIT_EVIDENCE_KEYRING_PATH`。
- 独立恢复副本：部署目录 `key-backups/signing-evidence/keyring.json`，变量 `AUDIT_EVIDENCE_BACKUP_KEYRING_PATH`。
- 仅服务器本地首次生成，目录 0700、文件 0600、fsync；重复发布不换密钥，残缺配置失败关闭，不覆盖重建。
- 清单 `activeVersion/versions` 保存每版 HMAC/AES 和证书/私钥路径。备份复制全部文件并改为独立路径，预检拒绝备份仍引用主文件或内容不一致。
- 首次已有合法 `PDF_SIGNING_*` 文档证书时保留真实主体，最终 PDF 使用该证书，步骤仍用独立平台密钥。不再用 `PDF_SIGNING_PARENT_*` 冒充个人，也不保留旧降级签署路径。
- 轮换新增版本、保留旧认证/解密材料并同步备份，再预检。旧私钥缺失不阻止只读验真，但不满足完整恢复备份门禁。吊销版不得通过。

恢复副本在**同机独立受保护目录**，不等于异地灾备；整机丢失仍需另行配置加密异地/离线备份。任何密钥不得进聊天、Git、数据库明文、日志或前端。配置、备份和必需验收不过则阻断发布。

## 验收入口

- `signingEvidenceProtocol.test.js`：JCS、隐私、身份/密文/链篡改、OpenSSL 双向互操作、真实 ByteRange 及追加攻击。
- `signingEvidenceIntegration.test.js`：独立 MySQL、幂等迁移、备份、实际文件提交/回滚、同名不同人、驳回、重试、跨轮次重提交、实际上传。需要 `DEPLOY_TEST_DB_HOST/PORT`，跳过不算通过。
- 相关安全、租户、时间、本地化、UI、迁移和文件协调器回归仍是必需门禁。微信冷编译及普通/管理端手机和 Pad 的正常/篡改文件现场结果单独记录，不得用 Node 或模板审计代替。

### 隔离现场验签服务

数据库集成测试可额外设置 `SIGNING_UI_PREVIEW_PORT` 和 `SIGNING_UI_FIXTURE_DIR`，在第一轮三步真实签署完成后暂停，提供仅绑定 `127.0.0.1` 的临时 `/verify` 服务及合成的 `normal.pdf/tampered.pdf`。该服务接收实际上传字节并重新调用生产验签服务，不能返回预先写死的通过状态；20 分钟后自动关闭，或调用 `/finish` 继续回归及清理测试数据库。

此入口仅位于服务端测试目录，不注册到生产路由、不接触生产人员和审批记录。开发者工具如需接入，只能临时连接该隔离服务，不发送生产令牌，不改变生产权限或安全设置；完成后恢复原调用。它可验证页面选文件、上传字节、密码结果和布局，但不能代替正式认证中间件的权限回归或生产部署后的健康检查。
