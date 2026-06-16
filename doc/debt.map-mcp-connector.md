# MAP MCP 连接器 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-16 | **状态**：维护中

## 总览

当前 open: 2 / paid: 0 / 总计: 2

核心连接器（远程 `/api/mcp` + 海鲜市场 5 内置工具 + 知识库读 API + 动态工具框架）已部署并自测通过（路由 + 鉴权链路）。以下为 PR #836 评审尾部识别、判定为低 MVP 影响而显式延后的硬化项。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-16-loopback-forwarded-headers | medium | 2026-06-16 | 回环 `LoopbackAsync` 未转发 `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Client-Base-Url`，下游若用 `ResolveServerUrl` 按请求 host 构造绝对 URL，会回落 127.0.0.1，结果里出现无法访问的 localhost 链接 | 出现「按请求 host 构造 URL」的动态 endpoint 工具，或内置工具改为返回请求 host 派生的 URL 时 | open | 当前内置 marketplace/KB 工具的下载链接来自对象存储存量绝对 URL（`ZipUrl`/`att.Url`/`CoverImageUrl`），不经 `ResolveServerUrl`，故 MVP 影响低。修法：回环转发上述 forwarded 头 |
| 2026-06-16-stdio-and-oauth | low | 2026-06-16 | v1 只做远程 Streamable HTTP + Bearer 鉴权；本地 stdio 代理包、OAuth 2.0 授权流、`resources`/`prompts` 能力均未做 | 需兼容仅支持本地 stdio 的旧客户端，或需要标准 OAuth 授权而非长效 Bearer 时 | open | 见 design.map-mcp-connector.md 第三节「非目标」与第九节 v2 |

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|

## 关联

- `doc/design.map-mcp-connector.md` —— 设计与实施阶段
- PR #836 —— 落地 PR；评审中的 P1（知识库身份）、安全（Host 伪造 / 重定向跟随）、协议正确性、可见性等实质项均已在该 PR 内修复，仅本表两项显式延后
