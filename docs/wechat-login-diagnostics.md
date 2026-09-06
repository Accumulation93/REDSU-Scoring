# 微信登录分段排查

## 已确认的边界

2026-09-06 真机调试中，同一请求号在服务端记录为 HTTP 200、约 196 ms，而手机调试 Network 仍显示 pending、0 B。该事实只能排除这笔请求在应用服务端长期执行，不能证明手机收到了完整响应，也不能仅凭 HTTP 200 判断业务登录成功。调试连接随后显示未连接；目前尚未完成修复后的鸿蒙真机登录闭环，不能宣称已定位到某个微信内部故障。

## 客户端阶段

微信登录不等待历史工作角色偏好的 Promise 或 storage 回调。每次点击分配一个请求号，纯回调链记录 `wechat_started`、`wechat_returned`、`request_started`、`headers_received`、`response_received` 或 `request_failed`。总计时器到期记录 `total_timeout`；迟到结果记录 `late_response/late_failure`，不再建立客户端会话。

记录保存在当前页面私有 `_wechatLoginTrace`，最多 24 项，并输出带 `[auth:wechat:timing]` 前缀的开发日志。仅包含阶段、耗时、请求号、HTTP 状态或原生错误编号；禁止记录微信 code、令牌、请求体、响应体及人员信息。可选日志或响应头监听失败不得影响认证。

排查时按同一请求号比对服务端与客户端：

- 没有 `wechat_returned`：尚未取得微信登录回调。
- 已发请求但无响应头：继续检查网络或调试传输，不能归因为身份校验失败。
- 已收到响应头但没有完整响应：继续检查响应传输和原生回调；响应头不等于响应体已收到。
- 已收到完整响应：再区分业务状态、客户端会话建立和导航，不回头猜测服务端耗时。

原生请求保留 15 秒超时，整条微信入口保留 18 秒总超时；释放忙碌态不等待原生 abort 桥调用。页面隐藏或卸载取消页面计时器并忽略迟到结果。不要通过自动重登、读取口令或改变合法域名校验来绕过排查。

回归：`scripts/wechat-login-timing-test.js`、`scripts/login-auth-continuation-test.js` 与 `scripts/miniprogram-page-registration-test.js`。VM 测试和微信编译通过均不替代鸿蒙真机连接验证。
