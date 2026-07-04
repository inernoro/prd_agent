# LLM 网关全面切换执行计划 · 计划

> **版本**：v1 | **日期**：2026-07-01 | **状态**：规划中
>
> 用户 2026-07-01 四点诉求：① 全面撤销 MAP 的 AI 直接调用，全部走网关；② 删除 MAP 里所有网关相关旧代码（避免回归），配置全延伸到网关；③ 全面 MECE 测试所有接口，保存进项目供第三方复测；④ 检查最终遗漏。外加 point 0：CDS 多出口面板（分支详情显示多个命名入口 + 预览按钮默认主入口）。
> 本文是这次全面切换的 SSOT：根因、分阶段执行、MECE 测试矩阵、遗漏清单、风险。由 6-agent 调研工作流取证合成（2026-07-01）。

---

## 0. Point 0 — CDS 多出口面板（根因 + 修复）

**根因是"数据链路断裂"，不是没做**：
1. `forwarder-route-publisher.ts:285-315` 已按 `cds.subdomain` 标签生成 `<previewSlug>-<sub>.<root>` 命名路由，写进 `forwarder-routes.json`（网关 URL 已发布）。
2. 但 `GET /api/branches/:id/subdomain-aliases`（`branches.ts:12689-12711`）只回 `aliases`（手动）/`previewUrls`/`defaultUrl`，**读不到容器 `cds.subdomain` 标签** → 网关命名 URL 从未回流到 API。
3. 前端 `BranchDetailPage.tsx:1543/1547` 只渲染 `defaultUrl` + 手动别名 → 网关命名 URL 在面板隐身。
4. 叠加**生产 CDS v0.7.1（buildTime 2026-06-26）落后命名子域特性 ~5 天** → 缺 DNS 守卫/去重/删除逻辑，需 self-update。

**修复（S1 + S0）**：扩展端点回 `gatewayUrls` 字段（读 `cds.subdomain`，走 `computePreviewSlug` SSOT）+ 前端加「网关入口」分组 + 「预览」默认主入口、下拉「打开网关」+ 生产 CDS self-update。

---

## 1. 分阶段执行计划（低风险先行；翻 http/删 inproc 必须被 MECE 测试 gate）

### 1.1 目标数据域（2026-07-04 新裁决）

Point 4 的“全面走网关”不等于“MAP 日志归 GW 管”。目标边界如下：

- **MAP 继续负责自己的日志**：MAP 业务流程、页面、Agent run、管理后台调试所需日志继续落 `prdagent`，由 MAP 自己消费。
- **LLM Gateway 负责自己的日志**：GW 控制台账号、登录审计、操作审计、GW serving 请求日志、shadow 对账证据落独立数据库 `llm_gateway`。
- **控制台账号不再由 env 长期托管**：`LLMGW_ADMIN_PASSWORD` 只能用于 bootstrap/破玻璃，长期口令权威必须是 `llm_gateway.llmgw_console_users`。
- **切网关后的双视角是设计目标**：MAP 侧可以看到“业务调用发生了什么”，GW 侧看到“模型网关如何解析、转发、失败、降级、计费/耗时”。两者用 requestId/sessionId/appCallerCode 关联，不互相吞并。

这条边界优先于下文早期“共享 Mongo 混入其它分支日志”的旧风险描述；旧风险仍成立，但解决方式是**独立 GW 数据库 + 关联 ID**，不是把所有日志混成一个集合。

| 阶段 | 目标 | 风险 | 关键改动 | 验证 |
|---|---|---|---|---|
| **S0.5** GW 数据域隔离 | GW 账号/审计/网关日志落 `llm_gateway` | 中 | `prd-llmgw` 账号库切 `llm_gateway`；serving 日志 writer 支持 GW DB；env 口令仅 bootstrap/破玻璃 | `admin/admin` 首登改密后重启不被 env 覆盖；MAP 日志仍留 MAP |
| **S0** 前置解阻 | 清 self-update + serving 常驻 blocker | 中 | 批准 cds-compose 拓扑导入 + 生产 CDS self-update（先 dry-run）+ serving 项目级常驻 | 命名子域可见 + serving 稳定 |
| **S1** CDS 面板出口可见性 | 网关命名 URL 回流并在面板渲染（point 0） | 低 | `branches.ts` 端点加 `gatewayUrls` + `BranchDetailPage.tsx` 加「网关入口」分组 + `openPreview` 加「打开网关」+ `resolveApiLabel` 补 label | 面板同显主应用+网关两组 URL；双主题；navCoverage/api-label 无 warning |
| **S2** L1 观测 | 日志页辨 inproc/http（翻 http 硬前置） | 低 | `GatewayTransport` 每条 llmrequestlog 标 inproc/http/shadow | 日志页可筛 transport |
| **S3** 六处直连收口 | ModelLab/Arena/ModelDomainService/Program.cs 全改走 ILlmGateway（point 1 核心） | 中 | 见 §3 清单，逐处改 `ILlmGateway`/`HttpLlmClient` | grep 守卫 0 直连 + 集成测试 |
| **S4** multipart raw HTTP 化 | 生图/ASR 内联文件 http 兜底 | 中 | `HttpLlmGatewayClient` MultipartFileRefs 对象存储 rehydrate | http 模式生图不 `MULTIPART_HTTP_UNSUPPORTED` |
| **S5** 灰度 canary 翻 http | 单入口 http 权威验证（flag 秒回滚） | 高 | `HttpAppCallerAllowlist=<低风险入口>` | 该入口 http 结果与 inproc 逐字段一致 |
| **S6** 全面翻 http + 删 inproc | `Mode=http` 全量 + 删进程内网关本体 + legacy 标记（point 1/2 终态） | 高 | 删 `LlmGateway.cs`/`ShadowLlmGateway.cs`/`FindLegacyModelAsync` | **必须被 S7 MECE 全绿 gate**；保留 revert commit 秒回 inproc |

> S5/S6 是用户最怕回归的部分：**前置 = shadow 证据积累 7-14 天 + serving HA + S7 测试全绿**。不满足不翻。

---

## 2. MECE 接口测试矩阵（point 3 · 交第三方复测）

| 接口/能力 | 类型 | 走网关 | 测试手段 | 断言 |
|---|---|---|---|---|
| GET /gw/v1/healthz | 网关-健康 | yes | curl（免 key） | 200 status ok + commit |
| POST /gw/v1/resolve | 网关-预解析 | yes | xUnit + 种子 | 解析到正确 model/档位/协议 |
| POST /gw/v1/send | 网关-非流式 | yes | xUnit + curl（需 key） | model 命中/内容非空/token |
| POST /gw/v1/stream | 网关-流式 SSE | yes | xUnit + curl SSE | 首字节 + 逐块 + [DONE] |
| POST /gw/v1/raw | 网关-原始代理 | yes | xUnit | 透传 body.model 不被覆盖 |
| POST /gw/v1/client-stream | 网关-跨进程 ILLMClient | yes | xUnit + shadow | 往返一致 |
| GET /gw/v1/pools | 网关-模型池 | yes | curl + xUnit | 返回真实池（DB 连通+解密） |
| GET /gw/v1/shadow-comparisons | 网关-影子对账 | yes | 集合查询 | inproc=http 0 critical |
| ILLMClient DI 工厂 (Program.cs 969-1068) | MAP-直连收口 | should-migrate | grep 守卫 + 集成 | 0 直连 new Client |
| ModelDomainService.GetClientAsync (77/88) | MAP-直连收口 | should-migrate | 集成 + grep | 走网关 |
| ModelLabController.RunExperiment (436/537) | MAP-直连收口 | should-migrate | xUnit | 走网关 + 落 llmrequestlogs |
| ArenaRunWorker.ProcessSlot (444/445) | MAP-直连收口 | should-migrate | xUnit | 走网关 + 落日志 |
| POST /api/pa-agent/chat | MAP-Agent 聊天 | yes | xUnit + curl SSE | 流式正常 |
| CCAS 5 流式端点 (/api/ccas-agent/*) | MAP-Agent 聊天 | yes | xUnit x5 | 各端点流式 |
| POST /api/pr-review/stream | MAP-Agent 聊天 | yes | xUnit | 流式 + 心跳 |
| POST /api/visual-agent/image-gen/generate | MAP-生图 | yes | xUnit + 图校验 | 出图 + 无选A给B |
| POST /api/literary-agent/image-gen/run | MAP-生图(异步) | yes | xUnit | run 完成 |
| POST /api/visual-agent/video-gen/runs | MAP-视频(异步) | yes | xUnit | run 完成 |
| POST /v1/open-platform/chat/completions | MAP-OpenAI 兼容 | yes | Python OpenAI SDK + Postman | 兼容返回 |
| GET /api/app-callers | MAP-身份注册表 | n/a | curl + xUnit | 153 入口 |
| GET /api/platforms | MAP-平台配置 | n/a | curl + xUnit | 平台列表 |
| 多平台适配器 (Claude/OpenAI/Qwen/OpenRouter) | 网关-协议保真 | yes | xUnit + 真机 B 层 91 cell | think/tool/token/finish 保真 |
| LlmGateway:Mode 三态开关 | 网关-配置门 | n/a | 配置审查 + 集成 | inproc/http/shadow 正确路由 |
| GatewayTransport 日志标记 (L1) | 网关-观测 | n/a | 日志集合查询 | 每条标 transport |
| 访问控制 (X-Gateway-Key + 限流) | 网关-安全 | yes | xUnit + 日志 | 无 key 401 |
| GET /api/branches/:id/subdomain-aliases | CDS-出口可见性 | n/a | curl + vitest | 回 gatewayUrls |
| gw-smoke.py 真机冒烟 (D 层) | 网关-端到端真机 | yes | cdscli 部署后 | 8/8 + canary 必败 |

---

## 3. Point 1 — MAP 直连收口清单（6 处，全改走 ILlmGateway）

| 位置 | 说明 |
|---|---|
| `Program.cs:1020,1026,1045,1051,1062,1067` | ILLMClient DI 工厂 6 处 new ClaudeClient/OpenAIClient（引导层，挡住 Mode=http 收口） |
| `ModelDomainService.cs:77,88` | GetClientAsync 按平台直 new，绕网关路由+日志+池调度 |
| `ModelLabController.cs:436-437,536-538` | RunExperiment 平台级/模型级两分支直 new |
| `ArenaRunWorker.cs:444-445` | 竞技场 slot 直 new，仅设 AppCallerCode 日志上下文不够 |

**已正确走网关（无需动）**：`OpenAIImageClient`（生图）、`OpenRouterVideoClient`（视频）。

## 4. Point 2 — 旧代码删除清单（前置：http 稳定 + 覆盖率达标）

| 位置 | 删除前置 |
|---|---|
| `LlmGateway.cs`（进程内本体） | httpAllowlist 100% 覆盖后删 |
| `ShadowLlmGateway.cs` | 灰度收敛后删 |
| `ModelResolver.FindLegacyModelAsync:630-641` + 兜底 103-141/321-352 | 所有 ModelType 建默认池 + 迁移率≥60% 后删 |

---

## 5. Point 4 — 遗漏 / 未覆盖清单

- GW 独立数据域未落地：控制台账号仍可能受 `LLMGW_ADMIN_PASSWORD`/共享库影响；目标是 `llm_gateway.llmgw_console_users` 权威。
- GW 网关侧请求日志尚未独立到 `llm_gateway`；MAP 日志不迁移，但 GW serving 需要自己的请求日志与审计日志。
- 六处直连未收口（§3）——未收口前 Mode=http 是形式摆设，翻转路由分裂。
- L1 GatewayTransport 日志标记未做——翻 http 唯一硬 blocker。
- multipart raw HTTP 化未接通（ASR/图生图）——http 模式内联文件跨进程 fail-fast。
- serving 容器 HA 未验证——翻 http 前须探活 + 不可达可观测降级。
- shadow 一致性证据不足——仅首条真机 allMatch（样本=1），建议影子 7-14 天。
- Claude 流式 tool_use 未聚合——流式函数调用拿不到 delta.tool_calls。
- legacy 标记查询未清除（删前置见 §4）。
- CDS 出口可见性缺口（point 0，S1 修）+ 生产 CDS 落后 5 天（S0 self-update）。
- 60-80 MECE 用例骨架已备未编写——S6 gate 前必须补齐。
- 跨项目隔离：共享 Mongo 混入其他分支 llmrequestlogs；Jwt__Secret 双身份轮换前须重加密存量密文。

## 6. 最高风险（翻 http 前必须闭合）

1. **路由分裂**：六处直连未收口就翻 http → 部分走容器部分走进程内，观测/计费断裂。**先 S3 全收口再翻**。
2. **断头翻转无 gate**：S6 必须由 S7 MECE 全绿（尤其 D 层 gw-smoke + shadow 多样本）gate，保留 revert commit 秒回 inproc。
3. **L1 观测 blocker**：无 transport 标记翻 http → 故障无法定位路径。
4. **multipart http 失败**：生图/ASR 内联文件 http 跨进程失败 → canary 期强制留 inproc/shadow。
5. **serving 单点**：HA 未验证，serving 挂且无降级 → 全站 LLM 不可用。
6. **删 legacy 兜底**：默认池覆盖 <60% 时删兜底 → 池全不可用无降级。
7. **GW 数据域混乱**：账号由 env/共享库覆盖、日志与 MAP 混在一起，会让控制台无法解释“谁负责哪条记录”。先落 `llm_gateway` 数据域，再推进大规模切换。
8. **密钥双身份轮换**：Jwt__Secret 兼 JWT 签名 + ApiKeyEncrypted 加密，轮换前须先重加密存量密文（历史 CDS_JWT_SECRET 穿透事故）。

---

## 关联

- `doc/plan.llm-gateway.rollout.md`（波1/2/2.5 进度 + 测试纲领）
- `doc/debt.llm-gateway-isolation.md`（回滚/安全/跨项目隔离/L1-L9）
- `.claude/rules/llm-gateway.md`（所有 LLM 调用必须走 ILlmGateway）
- `.claude/rules/cross-project-isolation.md`（Jwt__Secret 双身份 + 共享 Mongo）
