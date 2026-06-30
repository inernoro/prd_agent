# LLM 网关测试矩阵 · 规格

> **版本**：v1.0 | **日期**：2026-06-29 | **状态**：开发中
> 类型: spec（What — 测什么）
> 关联: `doc/design.llm-gateway-physical-isolation.md`、`doc/debt.llm-gateway-isolation.md`、
> `doc/report.gw-test-matrix.md`（全量可见报告）、`prd-api/tests/PrdAgent.Api.Tests/Gateway/`、`scripts/gw-smoke.py`

AI 大模型网关「真实调用面」MECE 冒烟测试矩阵。目标：按维度不漏不叠地覆盖每个真实调用入口与协议边界，
先用桩 + 必败 canary 证明用例能抓异常，再用 OpenRouter 便宜模型/桩真打。

## 全量可见报告（不压缩）+ 数据驱动 SSOT

矩阵不是几行摘要，而是**全枚举的大表**，落在 `doc/report.gw-test-matrix.md`（约 282 行）：A 层 153 个入口逐条真实解析
结果 + B 层 91 个协议保真 cell + C 层 18 个跨进程 cell + 20 个扩展维度。报告里 B/C 的**每一行 = CI 真执行的一个 cell**
（非只列不跑）。三处同源、一处生成：`scripts/gen-gw-matrix-report.py` 产出报告 + `protocol-cells.json` + `transport-cells.json`，
后两者被 `GatewayProtocolFidelityTests` / `CrossProcessServingErrorLoadTests` 的 `[Theory]/[MemberData]` 读取逐 cell 真跑。
改维度只改这一个脚本，报告与测试不漂移。

## 分层（按"在哪一层可判定"切 4 个不重叠层）

| 层 | 跑在哪 | 依赖 | 现状 |
|----|--------|------|------|
| A 解析/调度 | CI 单元(golden) | 反射，无 Mongo；集成那条需 Mongo | 复用 `AppCallerRegistryGoldenSnapshotTests` + `LlmResolutionGoldenIntegrationTests`；新增 `GwResolutionMatrixTests`（153 反射 `[Theory]`，校验命名 + ModelType 合法） |
| B 协议保真 | CI 单元 | 无（纯函数喂 canned payload） | `GatewayProtocolFidelityTests`（数据驱动 `[Theory]` 读 `protocol-cells.json`，91 cell） |
| C 跨进程传输 | CI 单元 | 无（真 Kestrel loopback + stub gateway） | `CrossProcessServingSelfTest`（端到端 1 例）+ `CrossProcessServingErrorLoadTests`（数据驱动 `[Theory]` 读 `transport-cells.json`，18 cell） |
| D 真机 | CDS 起来后脚本 | 真网关 + 真/桩上游 | `scripts/gw-smoke.py`（全 153 resolve + 抽样真打），待 CDS 跑 |

## 维度矩阵（MECE）

| 维 | 取值 | 覆盖层 | 期望 | canary（必败→须被抓） |
|----|------|--------|------|------|
| D1 入口 appCallerCode | 全 153（13 类 ModelType），`AppCallerRegistrationService.GetAllDefinitions()` 枚举 | A 全量 + D 每类抽 1 | 解析到正确 model/档位/协议 | 写错某 code 期望 model → golden 比对报 mismatch |
| D2 流式 stream | true / false | B(双路解析) + C(SSE) + D | 两路内容一致、SSE 逐块 Seq 递增 | 声明 stream 却发非流式体 → 标记异常 |
| D3 调度档位 | 专属池 / 默认池 / 直连 / NotFound | A | resolutionType 与 golden 一致 | 期望专属池实际落默认池 → 报 drift |
| D4 协议 | openai/claude/exchange × 来源(pool-item>model>platform) | A + B | 选对 adapter，ResolutionReason 记层级 | 池条目 protocol 覆盖未生效 → 报 |
| D5 think 位置 | reasoning_content / reasoning / `<think>`标签 / 无；× IncludeThinking{on,off} × Intent强制off | B 核心 | 思考归一为 Thinking chunk；off 只记不吐；Intent 永不吐；跨 chunk 半截标签缝合 | reasoning 误当 content 吐 → 断言失败 |
| D6 工具调用 | openai tool_calls / claude tool_use→归一 / 无 | B | 统一 OpenAI 形状，ToolCallCount 对 | claude tool_use 未归一 → 报 |
| D7 token/cache | reported / 缺失→missing / claude cache_creation+read | B + D | 字段落库、Source 正确 | usage 在却没采集 → 报 |
| D8 图片 | vision 输入参考图 / generation 输出图 / 历史3格式(base64 inline / [BASE64_IMAGE:sha] / COS URL) | B(格式还原) + D(真生图) | 三格式都能还原成可显示 URL；不内联 base64 | 坏 sha → 还原失败兜底而非崩 |
| D9 上下文 | 系统提示词 / 多轮 messages / 文档注入 / ImageReferences | A(流到日志) + D(多轮真打) | 字段不丢、UserId 非空 | Context 缺 UserId → 日志 UserId 空被发现 |
| D10 环境 | 正常 / 实验室 `prd-agent-web.lab::*` / 模型实验室 `model-lab.run` / 竞技场 `arena.battle` | A + D | 各入口能解析、不串 | lab 单模型却落默认池 → 报 |
| D11 上游中断 | 500 / 超时 / 连接重置 / 畸形SSE / 空响应 | B(解析健壮) + C(→Fail) | 不崩，归一为失败且可观测(blackhole/failed) | **主 canary**：桩必返错 → 断言 Success=false 且被记 |
| D12 负载/极速 | 并发 N / inproc vs http / keepalive / 断开不取消(server-authority) | C(并发) + D(真并发) | 并发不串租户、断开不取消上游 | 并发下 resolve 串号 → 报 |
| D13 演示/桩 | StubOpenAIController chat / stub-image / 确定性返回 | C/D 用桩平台 | 桩稳定可重放 | 桩平台未注册 → 用例报缺前置 |
| D14 一平台多请求方式 | per-pool-item / per-model protocol 覆盖同 platform | A | 同 platform 出不同 protocol | 覆盖被忽略仍用 platformType → 报 |

## canary 原则（贯穿每层）

每层至少一个"必败"用例 + 元断言「执行器确实把它标 FAIL」，证明用例不是空跑：
- B 层：`Canary_*` 用例喂"声称 A 实际 B / 上游错误"payload，用例以**期望失败**语义表达（断言确实检测到不一致），自身通过 = 探测有效。
- C 层：stub gateway 返回 Fail / 错 key → 断言 `GatewayResponse.Success==false` / 401。
- A 层：负向控制——故意 mismatch 的期望行喂给比对器，断言比对器返回"不一致"。
- D 层：指向坏 URL 的模型 → 断言真机失败被记（blackhole/failed），观测页可见。

## 边界

- `ModelTestStub.FailureMode` 当前**未接入** serving 路径（resolver/gateway 不查 `model_test_stubs`）——
  canary 不依赖它，改用桩上游错误端点 / 坏 URL 模型（真实失败路径）。让 FailureMode 生效是独立改动，记
  `doc/debt.llm-gateway-isolation.md`。
- D8 生图走 `ImageGenGateway`/`OpenAIImageClient`，不经 chat 适配器；图片格式还原在 `LlmRequestLogWriter`。
- 不覆盖计费、不重写调度算法。
