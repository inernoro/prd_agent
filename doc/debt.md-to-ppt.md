# debt.md-to-ppt — MD 转网页 PPT 工程债务台账

> 状态：active | 模块：prd-admin `md-to-ppt-agent` + prd-api `MdToPptController`
> 用途：记录 MD→PPT 已知边界、留尾、必须在「对话式 artifact 重构」里偿还的债务。

---

## 1. 预览 iframe same-origin 安全债（P1，必须在重构里偿还）

**现状**：`prd-admin/src/pages/md-to-ppt-agent/MdToPptAgentPage.tsx` 的预览 iframe 用
`sandbox="allow-scripts allow-same-origin"` + `withNavGuard()` 注入,把 LLM 生成的 reveal.js
HTML 直接 `srcDoc` 进来。

**风险**：same-origin + allow-scripts 让生成的 HTML 以**本管理后台同源**运行。生成内容来自
LLM(输入可含用户粘贴 / 上传 / 知识库,均可能被 prompt-injection),所以一段恶意 markdown 能让
模型吐出 `<script>` 读取同源 storage 里的 auth token、或冒用当前用户身份调任意 `/api`。
注入的 nav-guard 只拦 link/history 跳转,**不沙箱化、不消毒脚本执行**。等价于一个存储型 XSS。

**为什么没在 PR #750 里直接修**：正确修法是架构级的(预览必须从隔离源渲染),而该页已排期被
「对话 + artifact 实时预览」重构(见 `doc/plan.md-to-ppt-chat-redesign.md`)替换。在即将重写的
代码上做架构改造是浪费,且 naive 去掉 same-origin 会让 reveal 渲染空白(init 访问 storage 抛错)。
2026-06-09 与用户确认:**defer 到重构一并解决 + 记本债务台账**,不在当前 PR 改这页。

**偿还方案(重构时必须落地其一)**：
- 预览从**独立子域 / hosted-site 发布域**(已有 `Publish` 端点 + 托管域)渲染,天然跨源隔离;或
- iframe 用 `sandbox="allow-scripts"`(opaque origin,无 same-origin)+ 给 reveal 注入 storage shim
  兜住其 init 的 storage 访问,避免整页空白。
- 验收口径:生成一份含 `<script>fetch(...localStorage...)</script>` 的 deck,确认预览里脚本
  **拿不到**主应用 token / 不能以用户身份调 API,且 reveal 仍正常渲染、可翻页。

来源：Codex Review PR #750(P1 "Keep generated decks out of the app origin")。

---

## 2. 知识库注入到 CDS Agent 会话（未实现，UI 已占位禁用）

`prd-admin/src/pages/cds-agent/CdsAgentPage.tsx` 的 code 模式有「知识库/工作区」selector,
但后端 `createInfraAgentSession` / InfraAgentSession 没有任何把知识库灌进会话上下文的能力。
2026-06-09 按用户决定:**先禁用 selector 并标注「开发中」**(避免"选了却不生效"误导),
保留 `draft.workspaceKbId` 字段占位。偿还时需后端设计 KB 注入(灌进 workspace 文件 / system
prompt / 挂载),再前端接 `workspaceKbId` 下发。来源：Bugbot PR #750(Medium)。
