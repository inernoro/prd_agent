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

## 8. 真流式已修在 sidecar，生效依赖 sidecar 实例重启（P1 跟踪）

2026-06-10 预览环境二轮验收实测：deck 88s 生成成功但正文全部结尾爆发，等待期实况渲染/
思考流无内容可画。根因定位（证据链）：CDS message 接口 202 异步 + 流式 ingest 均正常；
真凶在 `claude-sdk-sidecar/app/official_agent_sdk.py`——`ClaudeAgentOptions` 未开
`include_partial_messages`，`receive_response()` 只产完整消息，token 级增量根本不产生。
已修：开启该参数（旧版 SDK TypeError 优雅降级）+ `sdk_events.py` 映射
`content_block_delta`（text_delta/thinking_delta）+ 完整消息块去重防正文双倍，
单测 5 例守护。**注意**：本分支 compose 不含 sidecar 服务，CDS managed runtime 用的
sidecar 实例另行部署——合并 main + sidecar 实例重启后真流式才在线上生效。

## 9. 历史列表含乱码时代的坏产物 run（P3，自然老化）

2026-06-10 去重修复（CdsSeq 水位线）之前生成/精修的 run，落库 html 本身是字符缺失的
坏产物；历史载入它们会黑屏 + 页码 "- / -"。功能本身正常（载入/提示/继续精修链路通过
三轮验收）。这些旧 run 随 20 条列表上限自然滚出；如需主动清理，删除 md_to_ppt_runs
中 2026-06-10 17:00 UTC 前 op=patch 的记录即可。

## 10. 上游偶发丢字符 → 标签碎片当正文（2026-06-11，已加守卫）

- 根因取证：deepseek 经 OpenRouter（anthropic 协议）偶发丢 `<` 字符——会话 9c6a2d14 仅一个
  6809 字符整块 delta，done finalText 源头即缺 26 个 `<`（非 MAP 摄入层丢失；早晨同管线零泄漏）。
- 已加守卫：`LooksCorruptedSection`（剥标签后残文含 >=3 处 `style="/class="` 即判损坏）→
  ExtractSection 返回空 → 既有「重试一次 → 兜底页」链路接管；单页 patch 同享。
- 残留边界：重试也损坏时 convert 出兜底页（设计感降级）；patch 报错请用户再点一次。
- 另观测：DenyAll 工具策略下子智能体仍可调 SDK 内置 Read（浪费一轮），待查 sidecar 工具暴露。

## 11. 单页重绘不支持自定义模板（2026-06-11）

- SlideIndex 命中但 templateId 非空时回落整篇路径（页级提示词的模板 token 物化未做，同 §debt 自定义模板并行生成）。

## 12. CDS 共享 sidecar 池偶发 502（2026-06-11 观测）

- 12:01-12:05 窗口 agent session 在 CDS 侧 404、CdsDiscovery 报 shared-sidecar-pool HTTP 502，期间整次生成失败（前端报 network error）。
- 几分钟后自愈；属环境层，非 MAP 代码缺陷。可补：MdToPpt 对 session_not_found 做一次性重建会话重试 + 前端错误文案区分「环境暂不可用」。

## 2026-06-12 批量缺陷修复后的已知边界（用户 10 条反馈复盘）

| 边界 | 现状与理由 | 后续可补 |
|------|-----------|---------|
| 首字延迟口径 | llm 面板 firstByteAt 记录的是 SSE 首事件而非首个内容字；交付话术不得再用"X 秒首字"，统一报「整页完成耗时」 | 在诊断事件里补 first_content_delta 时间戳 |
| 首屏 40-90s（生成期） | 预热已在大纲确认期完成（环境启动隐藏）；剩余等待 = 第一个子智能体整页生成时间，受模型速度约束（deepseek 思考型更慢） | 子智能体 text_delta 透传到前端，第一页边生成边渲染（工程量中等） |
| 图表 SVG 图例小幅重叠 | 模型在范本 SVG 上改数值时偶发图例文字溢出（如 "3项"/"85%" 压到图例块）；提示词已约束内容量，但 SVG 坐标级精度无法靠提示词保证 | 重绘本页可修；或后处理校验 SVG text 碰撞 |
| 兜底页样式降级 | 子智能体两次输出无效时降级页已继承模板装饰与页脚（不再裸奔），但版式仍是简化的标题+列表 | 失败页自动触发一次单页重绘 |

## 2026-06-23 CDS 连接门禁 + 降级如实告知（本次）

| 边界 | 现状与理由 | 后续可补 |
|------|-----------|---------|
| 门禁仅查「有无 active 连接」 | connection-status 复用 ResolveCdsConnectionAsync，只判连接存在，不判 sidecar pool 是否有 running branch service；连接在但池子没就绪时仍会进页面后失败 | 门禁顺带探一次池就绪（参考 CdsAgentPage 的 §307 判定），未就绪给不同文案 |
| 降级回报只覆盖 SSE onDone 主路径 | 断线后走 getMdToPptRun 轮询恢复的那条路径拿不到 degraded（run 记录未持久化兜底页数），仍报「PPT 已生成」 | MdToPptRun 落 degraded 字段，恢复路径一并读出告警 |
| 全文路径（自定义模板/无 outlinePages）不统计降级 | degraded 仅在并行逐页路径统计；走 RunAgentStreamAsync 的整篇路径无此口径 | 整篇路径如需要可在 LooksCorruptedSection 命中时计数 |
