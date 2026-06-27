# debt.web-hosting.client-ip

> 类型：debt（工程债务台账） | 模块：网页托管 / 分享访问统计 | 状态：active | 更新：2026-06-01

## 背景

PR #699 修复「分享统计取到 Docker 内网 IP（172.20.* / ::ffff:）」时新增
`HttpRequestExtensions.GetRealClientIp`。经多轮 review，方案在「防伪造」与「穿透多层代理拿真实
访客 IP」之间存在本质冲突——二者不可兼得，除非提供部署侧「可信代理地址」配置。

维护者 2026-06-01 最终决策：**只信不可伪造的代理覆盖值，不解析 X-Forwarded-For**。
即 `X-Real-IP`（反代 `$remote_addr` 覆盖写）→ `RemoteIpAddress`（socket 对端）。

## 已知边界（刻意留尾，维护者已知并接受）

| 项 | 现状 | 影响 | 后续可补 |
|----|------|------|---------|
| 多层 public 拓扑下记到代理 IP | `public-nginx→gateway→branch-nginx→api`，内层 nginx 用 `$remote_addr` 覆盖 `X-Real-IP` = gateway 内网地址 | 生产环境分享/站点访问统计的 IP、独立 IP 计数会**坍缩到 gateway 代理 IP**，而非真实访客——即原始诉求「正式环境拿真实访客 IP」在此方案下未达成 | 见下「彻底方案」 |
| 单层/直连拓扑正确 | CDS 预览（Cloudflare→branch-nginx 直连）下 `X-Real-IP` = Cloudflare 边缘公网 IP | 预览域名统计能看到边缘 IP（非内网），可用 | — |

为何取此方案：彻底 spoof-safe 的 XFF 解析必须知道「可信代理地址」（hop 数 / CIDR），而该输入
是部署侧拓扑配置，代码推断不出来；且该统计字段语义为「仅用于访问统计 / 审计展示，不作安全判定」。
权衡后维护者选择「绝不接受可伪造值」优先于「穿透多层代理的精确性」。

## 彻底方案（需要部署侧输入时再做，可同时满足防伪 + 真实访客 IP）

1. `app.UseForwardedHeaders(new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor, KnownNetworks = <内层反代 CIDR>, ForwardLimit = <可信跳数> })`；
2. 由运维提供 public-nginx / gateway / branch-nginx 的确切内网 IP 段作为 `KnownNetworks`（注意不能放整段私网，否则 LAN 客户端会被当可信代理）；
3. 改用框架填好的 `HttpContext.Connection.RemoteIpAddress`，删除本 helper 的 X-Real-IP 优先逻辑；
4. 这是**全局中间件**，影响所有 `RemoteIpAddress` 消费方（限流、其它日志），需回归。

## 关联

- 实现：`prd-api/src/PrdAgent.Api/Extensions/HttpRequestExtensions.cs`（`GetRealClientIp`）
- 消费：`WebPagesController.cs`（分享 view / 评论）、`WebPageAnalyticsController.cs`（record-view）、`HostedSiteService.cs`（`MaskIp` 脱敏展示）
- 部署拓扑：`deploy/nginx/nginx.conf`、`deploy/nginx/public-nginx.example.conf`
- 来源：PR #699 Codex/Bugbot 多轮 review + 维护者决策
