| feat | prd-api | 新增 `SharePasswordService`：PBKDF2-SHA256 加密 + `CryptographicOperations.FixedTimeEquals` 恒时校验 + per-shareLink 滑动窗口速率限制（1 分钟内 10 次尝试） |
| feat | prd-api | `WebPageShareLink` / `ReportShareLink` 新增 `PasswordHash` / `PasswordSalt` / `RecentAttempts` 字段；旧分享 `PasswordHash` 为空时自动回退明文恒时比对 |
| fix | prd-api | 网页托管 + 周报分享密码校验改用 SharePasswordService：失败响应 HTTP 429 + `Retry-After` header 告知前端倒计时；密码正确清空窗口避免合法用户被自己历史失败拖累 |
| fix | prd-api | 速率限制不绑定客户端 IP —— 反向代理 / 容器 / NAT 局域网 IP 不可靠，且 IP 锁会让公司内一人输错全员遭殃；改按每分享链接独立计窗口 |
| docs | doc | 新增 `doc/debt.share-link-security.md` 记录知识库密码缺失、工作流 ShareLink.Password dead code、数字短链历史链接清理等 5 项后续债务 |
