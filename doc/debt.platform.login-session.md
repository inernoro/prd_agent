# 登录会话（超长登录期）· 债务台账

> **版本**：v1.0 | **日期**：2026-07-28 | **状态**：开发中

记录 2026-07-28「三端登录改超长会话 + 用后自动续期」留下的已知边界与后续可补项。
用户诉求原话：「登录一下就过期了，需要超长的登录期，并且使用过后自动延长」。

## 本次落地的会话模型

| 端 | 凭据存放 | 硬过期 | 续期方式 | 撤销手段 |
|---|---|---|---|---|
| MAP（prd-admin） | localStorage（zustand persist） | access token 24h；会话滑动窗口 7 天 | 每次已鉴权请求 `AuthSlidingExpirationMiddleware` Touch 续满窗口；access token 过期后 401 → refresh → 重试 | 每请求校验 tokenVersion（`/api/auth-ops/force-expire*` 立即生效） |
| 网关控制台（llmgw/web） | localStorage | token 7 天 | 用满 12h 的 token 在租户校验通过后由服务端换发，走 `X-Gw-Token` 响应头，前端在响应里接住 | 每请求 `TenantAccess.ResolveAsync` 重校验 SecurityVersion / 成员版本 / 租户状态 |
| CDS | `cds_gh_session` cookie | 30 天（`CDS_SESSION_TTL_DAYS`，下限 7 天） | 剩余不足一半时下一次请求续满并重发 cookie | 会话表删除（logout / 禁用用户） |

## 已知边界 / 待补项

### 1. MAP 没有服务端 logout，退出登录只清本地

`AuthController` 没有 logout 端点，前端 `authStore.logout()` 只清本地存储。access token 从 60 分钟拉长到
24 小时后，**已泄露 token 的可利用窗口从 1 小时变成最多 24 小时**（refresh token 因为本地被清、
且泄露方通常拿不到 sessionKey，不受影响）。

- 缓解：管理端 `/api/auth-ops/force-expire` 可立即吊销（bump tokenVersion），每请求校验。
- 待补：加 `POST /api/auth/logout`，按 `(userId, clientType, sessionKey)` 删除该端 refresh 会话并
  bump tokenVersion，让「点退出」等价于「立即失效」。

### 2. 网关续期不覆盖非 apiRequest 的调用方

滑动续期靠响应头下发，只有走 `llmgw/web/src/lib/api.ts` 的 `apiRequest` 才会接住。若将来加
EventSource / 直接 fetch 的会话调用，需要同样调用 `applyRenewedToken`，否则那条链路不会延长会话
（不会掉登录，只是不续期）。

### 3. 网关旧 token 不会被续期

`TryRenew` 只续「按当前完整会话时长签发」的 token。发版前签发的 12 小时 token（以及被显式缩短的
MAP SSO 会话）原样到期，用户需重登一次才进入 7 天滑动窗口。属一次性过渡成本，不修。

### 4. MAP SSO 联邦会话时长语义变更

`/gw/auth/map-sso` 原先固定 15 分钟，现在默认与普通会话一致（7 天）。若安全策略要求联邦会话必须短，
配置 `LlmGwJwt:MapSsoLifetimeMinutes` 收紧即可——但那类 token 不进滑动续期，会回到「一会儿就过期」。

### 5. CDS 续期是「读-改-写」而非原子递增

`extendSession` 先 `findOne` 再按原 `expiresAt` 条件 `replaceOne`。并发续期时后到的那次是 no-op
（条件不匹配），结果仍然是一个被续满的会话，不会写坏数据；但如果并发的是 logout，续期会安静失败，
下一次请求按未登录处理。当前阈值下每个会话半个 TTL 才触发一次续期，冲突概率极低，暂不改成原子更新。

### 6. 三端窗口长度各行其是

MAP 7 天 / 网关 7 天 / CDS 30 天，来源是各自原有实现的量级（3 天 / 12 小时 / 30 天）。没有统一
SSOT，调整时要三处各改各的配置。若后续要求「一处配置管三端」，需要引入平台级会话策略配置。

## 历史背景

| 时间 | 事件 |
|---|---|
| 2026-07-28 | 用户反馈登录一下就过期，要求超长登录期 + 用后自动延长；三端会话模型按上表统一改造，`no-localstorage` 规则同步补「认证态可进 localStorage」的显式例外 |
