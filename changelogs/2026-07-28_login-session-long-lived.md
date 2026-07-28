| feat | prd-api | MAP 登录改超长会话：access token 与会话滑动窗口同为默认 7 天（Jwt:AccessTokenMinutes / Auth:SessionSlidingDays 可调），每次已鉴权请求自动续满，客户端绑定与 tokenVersion 共用同一窗口 |
| fix | prd-api | 滑动续期同时续 tokenVersion 键，避免被踢过的用户（tv>=2）在 tv 键先过期后，手里仍有效的 token 被误判成已撤销而平白掉登录 |
| feat | llmgw | 网关控制台会话默认 7 天并支持用后自动续期：服务端在租户校验通过后经 X-Gw-Token 响应头换发新 token，前端自动接住；MAP 一键登录不再固定 15 分钟（LlmGwJwt:MapSsoLifetimeMinutes 可收紧） |
| feat | llmgw | 控制台会话从 sessionStorage 改存 localStorage（关浏览器再打开仍在登录），并平滑迁移旧会话；撤销仍由服务端每请求校验 SecurityVersion / 成员版本兜底 |
| feat | cds | 登录会话默认 7 天（与 MAP / 网关控制台统一口径）且滑动续期：剩余时长低于一半时下一次请求续满并重发 cookie（CDS_SESSION_TTL_DAYS 可调，1~90 天） |
| test | prd-api | 新增 MAP 会话滑动窗口与网关会话续期回归测试（默认时长、配置收敛、短会话不被拉长、续期保留身份 claim） |
| test | cds | 新增会话滑动续期与 cookie 重发回归测试 |
| rule | docs | no-localstorage 规则补充「认证态可进 localStorage」的显式例外与前提条件 |
| fix | llmgw | 会话迁移搬完即删除 sessionStorage 原件，登出/401 后同标签页刷新不再把旧 token 迁回来（Codex P1） |
| fix | cds | /api/me 触发的滑动续期同步重发 cookie（该路由挂在鉴权中间件之前），登出路径显式不续期（Codex P1） |
| fix | cds | 会话写库改字段级 $set，避免 lastSeenAt 的异步写回把刚续期的 expiresAt 覆盖回旧值（Codex P1） |
| fix | prd-api | tokenVersion TTL 改为 max(会话窗口, access token 时长 + 时钟余量)，防止会话窗口配得比 token 短时已撤销的旧 token 复活（Codex P1） |
| fix | llmgw | 续期换发只替换「发起本次请求的那把 token」，避免请求在途期间用户换账号后被旧凭据覆盖（Codex P1） |
| fix | prd-api | access token 时长归一化收敛到 AuthTokenLifetimes 单一口径，杜绝配 0/负值时签出立刻过期的 token 却回报 7 天（Codex P2） |
| fix | cds | ticket SSO 会话纳入统一 7 天策略并支持滑动续期 + 重发 cookie（原硬编码 12 小时且不续期）（Codex P1） |
| fix | llmgw | 401 只清「发起本次请求的那把 token」，避免请求在途期间换账号后把新会话一起踢下线（Codex P1） |
| fix | llmgw | 监听 storage 事件同步鉴权上下文，修复跨标签页登出/换账号后界面身份与实际凭据不一致（Codex P1） |
| fix | cds | basic 模式 cds_token 纳入统一 7 天策略并在已鉴权请求上重发实现滑动续期（原写死 30 天且不续期）（Codex P1） |
| fix | llmgw | 401 清会话改严格相等判断，无凭据请求的 401 不再清掉别的标签页刚登录的会话（Codex P2） |
| fix | cds | 过期会话的删除也带上「读到的过期时间」作条件，避免并发续期成功的会话被另一条请求删掉（Codex P2） |
| fix | llmgw | 续期换发新 token 时同步更新本地到期时间并重排主动过期定时器，避免续期后仍按旧时间掉登录 |
| fix | llmgw | BugReportDialog 硬编码字号改用字体阶梯 token，修复 main 上「新增弹窗 + 字体守卫」双分支合流后 web 镜像构建失败 |
| fix | prd-api | access token 时长受会话滑动窗口约束，避免窗口配得比 token 短时「N 天不用就掉登录」失去执行点（Codex P2） |
| fix | prd-api | refresh 成功时同步续 tokenVersion 台账，避免被踢过的用户刷新后新 token 反被判成已撤销（Codex P2） |
| fix | llmgw | 跨标签页接管会话时重置失效闩，避免新会话失效后本标签页卡在「已登录但没有 token」（Codex P2） |
