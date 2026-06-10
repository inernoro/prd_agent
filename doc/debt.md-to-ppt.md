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

---

## 3. 生成实况预览是"近似渲染"，与最终 Reveal 排版有细微差异（P3，体验债）

2026-06-10 等待体验改为 Gamma 式实况渲染：流式 HTML 每闭合一个 `<section>` 即用
"head 样式 + 静态铺版 CSS"在实况 iframe 真实渲染。因 reveal.js 运行时脚本在文件末尾
（生成中尚未流到），实况页不走 Reveal 布局引擎，居中策略/字号缩放与最终渲染有细微差异。
**边界**：实况预览定位是"看到产物在生长"，不承诺像素级一致；生成完成后切换真正的
reveal.js 渲染。偿还方向（可选）：流式收到 `Reveal.initialize` 后切换为完整文档渐进渲染。

## 4. 大纲规划仍走 ILlmGateway（设计决定，非债务，记录备查）

2026-06-10 用户拍板 PPT 生成完全走 CDS Agent（MAP 直出已删除）。大纲规划（outline）
是快速 JSON 往返、非 PPT 产物本体，保留在 ILlmGateway 上以保证"大纲秒回 + 顺手预热
Agent 会话"的节奏。若未来要求大纲也走 Agent，需同时解决大纲期 5-15s 启动等待的体验。

## 5. 预热会话缓存是单实例内存态（P3，多实例部署前需偿还）

`MdToPptController.PrewarmSessions` 用 static ConcurrentDictionary 存 userId → 预热会话。
单实例部署（当前形态）正确；多实例/水平扩容后预热命中率下降为 1/N（功能不坏，仅优化失效，
未命中自动走全新创建路径）。偿还方向：挪到 Redis 或 Mongo 带 TTL 集合。

## 6. 历史 run 记录 engine 字段存在 "map" 旧值（兼容已处理，记录备查）

MAP 直出删除后，新 run 一律 engine="agent"；`md_to_ppt_runs` 历史记录仍有 engine="map"。
前端 `MdToPptEngine` 类型保留 'map' 字面量用于历史展示，不可删。

## 7. 页面新手教程（*-page-guide）未落地（P2，摘 wip 后应补）

按 `.claude/rules/onboarding-tips.md`，大型智能体页面需有本页完整 Tour（8-15 步、
`md-to-ppt-page-guide` seed + `data-tour-id` 锚点 + 进页自动开讲）。2026-06-10 摘除
百宝箱 wip 时该教程尚未做。偿还路径：页面加锚点（常驻元素：quick-starts/composer/
风格选择/页卡），`BuildDefaultTips` 加 seed，更新 onboarding-tips 规则表。
