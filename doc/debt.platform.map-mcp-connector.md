# MAP MCP 连接器 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-16 | **状态**：维护中

## 总览

当前 open: 3 / paid: 1 / 总计: 4

核心连接器（远程 `/api/mcp` + 海鲜市场 5 内置工具 + 知识库读 API + 动态工具框架）已部署并自测通过（路由 + 鉴权链路）。以下为 PR #836 评审尾部识别、判定为低 MVP 影响而显式延后的硬化项。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-18-ai-provision-endpoint | medium | 2026-06-18 | AI 无人值守自助签发 sk-ak 需一个【只接受 AiAccessKey 方案】的专用端点(单身份无歧义)。曾在 AgentApiKeysController 叠 Bearer+AiAccessKey 自测,但同请求双凭据时 FindFirst(sub) 选错用户(Bugbot Medium),已撤回(AiAccessKey 鉴权器本身是既有设计,未动) | 需 AI/自动化无人值守为指定用户签发 sk-ak 时 | open | 新建 POST /api/agent-api-keys/ai-provision，[Authorize(AuthenticationSchemes="AiAccessKey")] |
| 2026-06-18-kb-entries-pagination | low | 2026-06-18 | knowledge_base_list_entries 只有 keyword+limit(上限500),无 cursor/page；超 500 条非文件夹条目的大库无法经 MCP 全量遍历 | 出现 >500 条目的知识库且需 MCP 全量读取时 | open | 加 cursor/page 参数 + tool schema 同步;多数库 <500 条,MVP 影响低 |
| 2026-06-16-stdio-and-oauth | low | 2026-06-16 | v1 只做远程 Streamable HTTP + Bearer 鉴权；本地 stdio 代理包、OAuth 2.0 授权流、`resources`/`prompts` 能力均未做 | 需兼容仅支持本地 stdio 的旧客户端，或需要标准 OAuth 授权而非长效 Bearer 时 | open | 见 design.platform.map-mcp-connector.md 第三节「非目标」与第九节 v2 |

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
| 2026-06-16-loopback-forwarded-headers | #836 | 2026-06-16 | 回环转发 X-Client-Base-Url / X-Forwarded-Host / X-Forwarded-Proto;Codex 确认影响海鲜市场 official skills 下载链接 |

## 关联

- `doc/design.map-mcp-connector.md` —— 设计与实施阶段
- PR #836 —— 落地 PR；评审中的 P1（知识库身份）、安全（Host 伪造 / 重定向跟随）、协议正确性、可见性等实质项均已在该 PR 内修复，仅本表两项显式延后
