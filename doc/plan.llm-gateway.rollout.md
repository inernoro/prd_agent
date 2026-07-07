# LLM 网关剥离：上线计划 / 差异化进度 / 测试纲领 / 局限与范围 · 计划

> **版本**：v1.1 | **日期**：2026-06-30 | **状态**：开发中
> 进度：波1/2 已部署；波2.5 影子代码完成、已在预览真机跑通 serving resolve。
>
> 类型：plan（When / 实施计划）。本文件是「网关从 MAP 剥离」整个工程的**进度 + 测试纲领 + 范围边界**单一索引。
> 设计细节见 `design.llm-gateway-physical-isolation.md`（架构 + 图）；验收取证清单见
> `guide.llm-gateway.acceptance-breadcrumbs.md`；已知债务见 `debt.llm-gateway-isolation.md`。
> 时点：分支 `claude/llm-scheduling-model-pool-x58zh4`（领先 main 69 / 落后 15，merge-tree 零冲突）。

---

## 1. 终态目标（一句话）

把 MAP 的「大模型**调用 / 日志 / 分配(调度) / 模型池**」剥成**独立可部署、可被别人调用、可多地部署**的网关服务。
MAP 保留原 `ILlmGateway` 方法签名不变，但底层从「进程内方法调用」切到「HTTP 接口请求」=可追溯。
**数据库不分离**（共享同一 Mongo）、**生图统一入口**、**计费暂缓**。

---

## 2. 差异化进度（相对之前 baseline 改了什么）

| 波次 | 内容 | 之前 | 现在 | 证据 |
|---|---|---|---|---|
| 波1 观测 | 请求生命周期可见（没发送 vs 没收到）+ 黑洞落库 + 应用维度聚合 | 进程内方法调用，日志混一张表，StartAsync 失败不入库 | 生命周期 chip + `Status=blackhole` 落库 + app-summary 聚合 | 已部署 |
| 波1 剥离 | 独立项目 `prd-llmgw/`（serving）+ `prd-llmgw-web/`（独立观测前端，自带登录） | 无独立进程 | 独立可运行 ASP.NET 服务（8091）+ 独立前端 | 镜像绿 |
| 波1 生图 | 统一入口 `ImageGenRequestBuilder` + 适配器抽象 | 生图逻辑散落、加模型波及全系统 | 加模型=改配置(+必要 Adapter)，不波及全局 | 已部署 |
| 波2 跨进程 | serving `/gw/v1/*` 6 端点 + MAP `HttpLlmGatewayClient` + flag `LlmGateway:Mode=inproc\|http` | 只有进程内 | 方法签名不变、底层可切 HTTP，48 注入点零改动 | D 层 8/8 真机 |
| 波2 合并 | 合并 main（含 CDS 多容器）到网关分支 | 旧 CDS 单容器 | 单分支多容器部署 serving | 回归 1315 绿 |
| 波2.5 shadow | `ShadowLlmGateway` 影子比对（inproc 权威 + 后台 http 比对落 `llmshadow_comparisons`） | 无 | resolve-only 默认（免费，覆盖「选A给B」），full-send 采样可选 | 单测 9 例绿 + 首条真机 allMatch |
| 波2.5 灰度 | `LlmGateway:HttpAppCallerAllowlist` 按 appCallerCode 逐个翻 http（纯配置可回滚） | 无 | 命中走 http 权威、其余按 Mode | 单测绿 |
| 波2.5 观测 | serving `GET /gw/v1/shadow-comparisons`（X-Gateway-Key 门内）读比对汇总 + 最近 N 条 | 无（只能查集合） | 去黑盒读端点 | 真机 live |
| 波2.5 CDS | 单分支多容器**命名子域 URL** `<slug>-<sub>.miduo.org`（独立入口，非埋在主应用 /gw/v1 路径） | 只能 path-prefix 共用主应用域名 | BuildProfile.subdomain + forwarder 命名 host 路由 + proxy 兜底 | 3 测试绿 + tsc 干净（未点亮） |

**距离生产**：核心命题（MAP 调用走 HTTP=可追溯）距离 = **一次配置翻转 `LlmGateway:Mode=http`**。
硬骨头（架构 + 跨进程 + 真机跑通 + 影子基础设施 + 读端点）已过 ~75%。

---

## 3. 测试纲领（每层证明什么 + 跑没跑）

四层不重叠，按「在哪一层可判定」切分（非一张大交叉表）：

| 层 | 测试 | 规模 | 证明什么 | 状态 |
|---|---|---|---|---|
| A 解析/调度 | `GwResolutionMatrixTests` / `AppCallerRegistryGoldenSnapshotTests` / `LlmResolutionGoldenIntegrationTests` | 153 入口反射 + 快照 | 每入口解析到正确 model/档位/协议，注册表不漂移 | CI 绿（集成那条需 Mongo，标 Integration 跳过） |
| B 协议保真 | `GatewayProtocolFidelityTests` | 93 cell + canary | think 三形态 / tool 归一 / token+cache / finish 全枚举 / 字符集 / edge→null | CI 绿 |
| C 跨进程传输 | `CrossProcessServingErrorLoadTests` / `CrossProcessServingSelfTest` | 18 cell + 端到端 | 方法×上游×鉴权×并发 / ApiKey 不过线 / 401 / 并发不串号 / 真 Kestrel 往返 | CI 绿 |
| D 真机 | `scripts/gw-smoke.py` | 8/8 | 真预览 healthz/pools/send 真打 qwen+deepseek / canary 必败被抓 | 已取证 |
| shadow 单测 | `ShadowLlmGatewayTests` | 9 例 | caller 永远拿 inproc / 比对 critical+warning 分级 / http 抛异常隔离 / resolve-only 不 2x 打模型 / 白名单走 http 不比对 | CI 1326 passed |
| shadow 真机 | `/gw/v1/shadow-comparisons` 读端点 | 首条 | inproc=http 逐字段一致、0 critical、http 健康 | 首条 allMatch（样本=1，待积累） |

**canary 哲学**：每层都有一个「必败」用例（桩上游返 500 / 故意 mismatch），并断言「执行器把它标 FAIL」，
证明探测有效（不是空跑）。canary 用「期望失败」语义表达 → 它失败=测试通过。

---

## 4. 局限与范围边界（明确没做 / 刻意不做，给你看见遗漏）

| # | 局限 | 现状 | 影响 | 归属 |
|---|---|---|---|---|
| L1 | `GatewayTransport` 日志标记（每条日志标 inproc/http/shadow） | 未做（allowlist 部分已做） | flip 后日志页看不出某条走 inproc 还是 http | 波2.5 补 / 随观测 UI |
| L2 | 流式 chat 完整 content 比对 | 设计上**只比解析**（避免 2x 打 chat 模型） | 流式不逐字比 content（只比 model/protocol/档位） | 有意为之；`ShadowFullSamplePercent>0` 才对非流式采样 |
| L3 | 生图/视频链路 HTTP 化 + shadow | raw 透传 inproc，不影子 | 生图链路未纳入翻 http | 波3 |
| L4 | 6 处 `new ClaudeClient/OpenAIClient` 直连归并 | 仍绕过网关 | 这些调用不可追溯/不走网关 | 波3 |
| L5 | shadow 比对可视化 UI + 独立观测前端正式上线 | 只有读端点 | 比对结果要 curl 看（无页面） | 待 UI |
| L6 | 多地部署演练 | 未做 | 多地能力未实证 | 波3 |
| L7 | 计费 | 暂缓 | 无用量计费 | 用户定 |
| L8 | 数据库分离 | 不做 | 共享同一 Mongo（有意，避免表撕裂） | 终态保持 |
| L9 | 命名子域点亮 | 代码 push，404 未生效 | 需生产 CDS self-update（系统级）或合 main | 见 §6 |

**中转/聚合（apiyi 这类）专项说明**：中转异构（reasoning 字段名 / finish_reason / tool_calls 位置 / 图片格式）
**在协议适配器层（`OpenAIGatewayAdapter`/`ClaudeGatewayAdapter`）+ `ExchangeTransformerRegistry` 被吸收**，
下游永远只见单一 `GatewayStreamChunk`。跨进程 HTTP 边界**不放大**中转复杂度——compute-then-send 让 resolve + send
同在 serving 进程，relay handling 与 inproc 用同一份适配器代码。新中转 onboarding = 加 platform + 选 protocol +
（有 quirk 时）加 ExchangeTransformer，是有界配置任务 + B 层 93-cell 测试网兜底，不是网关隔离风险。shadow 是活证据：
任何中转上 http≠inproc 会在读端点显示 mismatch。

---

## 5. 上线序列（每步 flag 默认 OFF、可回滚）

```
shadow 积累一致性证据（默认 resolve-only，免费）
  → T11 灰度 canary：HttpAppCallerAllowlist=一个低风险入口 → 验 http 路径逐字段一致、无选A给B
  → T12 生产翻 http：LlmGateway:Mode=http（纯配置）→ 目标核心命题兑现，shadow 留 7-14 天兜底
  → 波3：生图/视频 http 化 + 6 处直连归并 + 多地演练 + 清理 inproc 代码
```

**回滚**：任一步删 env / 设 `Mode=inproc` 即回进程内，纯配置、无需改代码/重建镜像。

---

## 6. 合并就绪 + 命名子域点亮（待用户拍板）

**合并就绪状态**：
- merge-tree 与 origin/main **零冲突**（69 ahead / 15 behind）。
- CDS tsc 干净；新增 CDS 测试 3 绿；CDS 全套 2490 passed（10 个 `/api/http-logs/*` 401 为**既有**问题，clean tree 同样失败）。
- 后端 shadow 单测在 CI 真跑（T8：1326 passed / 0 fail）。
- changelog 碎片齐备。

**命名子域点亮的部署风险（必读）**：生产 CDS 现跑 `main`（落后 main HEAD 一条「修复自更新历史 + 极速版」）。
本分支**没有**该自更新修复。若 self-update 生产 CDS 到本分支：① 系统级影响所有项目预览；② 临时回退该自更新修复 + 极速版；
③ 万一翻过去后自更新行为出问题，可能难以干净翻回 main。**推荐路径 A**：把命名子域改动**走 PR 合进 main**，
CDS 跟 main 自更新，命名 URL 平台级生效，无 staleness、无系统级翻 feature 分支风险。

---

## 7. 关联文档

- `design.llm-gateway-physical-isolation.md` —— 架构 + 边界 + 图（设计 SSOT）
- `guide.llm-gateway.acceptance-breadcrumbs.md` —— 视觉/功能验收面包屑清单（自动化可消费）
- `debt.llm-gateway-isolation.md` —— 已知债务 / 边界 / 回滚 / 跨项目隔离影响
- `spec.llm-gateway-test-matrix.md` —— 测试矩阵 SSOT
- `report.gw-test-matrix.md` —— 数据驱动覆盖报告（153 行解析 + B/C cell）
