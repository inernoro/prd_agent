| feat | prd-api | MAP 登录改超长会话：access token 与会话滑动窗口同为默认 7 天（Jwt:AccessTokenMinutes / Auth:SessionSlidingDays 可调），每次已鉴权请求自动续满，客户端绑定与 tokenVersion 共用同一窗口 |
| fix | prd-api | 滑动续期同时续 tokenVersion 键，避免被踢过的用户（tv>=2）在 tv 键先过期后，手里仍有效的 token 被误判成已撤销而平白掉登录 |
| feat | llmgw | 网关控制台会话默认 7 天并支持用后自动续期：服务端在租户校验通过后经 X-Gw-Token 响应头换发新 token，前端自动接住；MAP 一键登录不再固定 15 分钟（LlmGwJwt:MapSsoLifetimeMinutes 可收紧） |
| feat | llmgw | 控制台会话从 sessionStorage 改存 localStorage（关浏览器再打开仍在登录），并平滑迁移旧会话；撤销仍由服务端每请求校验 SecurityVersion / 成员版本兜底 |
| feat | cds | 登录会话默认 30 天且滑动续期：剩余时长低于一半时下一次请求续满并重发 cookie（CDS_SESSION_TTL_DAYS 可调，下限 7 天） |
| test | prd-api | 新增 MAP 会话滑动窗口与网关会话续期回归测试（默认时长、配置收敛、短会话不被拉长、续期保留身份 claim） |
| test | cds | 新增会话滑动续期与 cookie 重发回归测试 |
| rule | docs | no-localstorage 规则补充「认证态可进 localStorage」的显式例外与前提条件 |
