# debt.web-hosting-client-ip

> 类型：debt（工程债务台账） | 模块：网页托管 / 分享访问统计 | 状态：active | 更新：2026-06-01

## 背景

PR #699 修复「分享统计取到 Docker 内网 IP（172.20.* / ::ffff:）」时，新增
`HttpRequestExtensions.GetRealClientIp`，从 `X-Forwarded-For` 解析真实客户端 IP。
经多轮 review 收敛后，当前实现为：**XFF 从右向左扫，返回第一个公网段；全为内网时回退到
代理覆盖写的 `X-Real-IP` / socket 地址**（绝不回退 XFF 最左段，杜绝纯内网链下的私网 IP 伪造）。

## 已知边界（刻意留尾，用户 2026-06-01 拍板「保持启发式 + 记 debt」）

| 项 | 现状 | 风险 / 触发条件 | 后续可补 |
|----|------|----------------|---------|
| 私网链下公网 XFF 伪造 | 启发式取「右起首个公网段」。在 **无可信公网反代** 的部署（LAN/VPN、branch-nginx 直连）下，客户端发 `X-Forwarded-For: 8.8.8.8`，nginx 仅追加私网 remote_addr，扫描会先命中伪造的 8.8.8.8 | 仅在内网直连部署且攻击者已在内网时成立；只能污染 **其自己请求** 记录的访问 IP / 独立 IP 计数，无法越权、无法读他人数据 | 见下「彻底方案」 |
| 多层 public 链 vs 私网链不可兼得 | 生产 `public-nginx→gateway→branch-nginx→api` 拓扑下启发式正确（最外层 public-nginx 收真实公网客户端）；纯内网拓扑下则可被伪造 | 同一份启发式无法同时满足两种拓扑——这是 XFF 解析的本质限制 | 同上 |

## 为什么不在本 PR 彻底修

彻底 spoof-safe 的 XFF 解析**必须知道「可信代理地址」**（ASP.NET `ForwardedHeadersMiddleware`
的 `KnownProxies` / `KnownNetworks`，或等价的可信跳数）。该输入是**部署侧拓扑配置**，代码无法
推断：

- public-gateway 路径有约 3 跳，branch-nginx 直连只有 1 跳；
- 「私网段即可信代理」也不成立——LAN 客户端与反代同处私网段，无法据此区分。

且本统计字段的语义已明确标注「仅用于访问统计 / 审计展示，不作安全判定依据」，伪造的影响面
极低（攻击者污染自己视图的计数），故按用户决策保持启发式，不引入需要运维侧维护可信代理清单的
全局中间件。

## 彻底方案（需要部署侧输入时再做）

1. 启用 `app.UseForwardedHeaders(new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor, KnownNetworks = <内网反代 CIDR>, ForwardLimit = <可信跳数> })`；
2. 由运维提供 public-nginx / gateway / branch-nginx 的确切内网 IP 段作为 `KnownNetworks`；
3. 改用框架填好的 `HttpContext.Connection.RemoteIpAddress`，删除本启发式；
4. 注意这是**全局中间件**，会影响所有 `RemoteIpAddress` 消费方（限流、其它日志），需回归。

## 关联

- 实现：`prd-api/src/PrdAgent.Api/Extensions/HttpRequestExtensions.cs`（`GetRealClientIp` / `IsPublicIp`）
- 消费：`WebPagesController.cs`（分享 view / 评论）、`WebPageAnalyticsController.cs`（record-view）、`HostedSiteService.cs`（`MaskIp` 脱敏展示）
- 部署拓扑：`deploy/nginx/nginx.conf`、`deploy/nginx/public-nginx.example.conf`
- 来源：PR #699 Codex/Bugbot 多轮 review
