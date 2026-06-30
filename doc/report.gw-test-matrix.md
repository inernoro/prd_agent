# 网关测试矩阵全量报告 · 报告

> **版本**：自动生成 | **日期**：2026-06-30 | **状态**：开发中
> 自动生成（`scripts/gen-gw-matrix-report.py`），勿手改。一处定义三处消费：本报告 +
> `protocol-cells.json`(B 层 [Theory]) + `transport-cells.json`(C 层 [Theory])。
> 报告里 B/C 的每一行都是 CI 真执行的一个 cell（非只列不跑）。矩阵设计 SSOT：
> `doc/spec.llm-gateway-test-matrix.md`；债务台账：`doc/debt.llm-gateway-isolation.md`。

全枚举、不压缩：
- **A 层解析全量**：153 个 appCallerCode 真实解析结果（golden SSOT，第 2 节）。
- **B 层协议保真**：91 个数据驱动 cell，CI `GatewayProtocolFidelityTests` 真跑（第 3 节）。
- **C 层跨进程传输**：18 个数据驱动 cell，CI `CrossProcessServingErrorLoadTests` 真跑（第 4 节）。
- **扩展维度**：20 个 emerge 维度（第 5 节）。
- **合计可见行数**：约 282 行。

## 1. 概览（分布统计）

### 1.1 按 ModelType（从 appCallerCode `::suffix` 解析）

| ModelType | 入口数 |
|---|---|
| chat | 102 |
| intent | 8 |
| vision | 14 |
| generation | 16 |
| code | 4 |
| embedding | 1 |
| rerank | 1 |
| asr | 4 |
| tts | 1 |
| video-gen | 2 |

### 1.2 按解析档位

| 档位 | 入口数 | 含义 |
|---|---|---|
| DedicatedPool | 105 | 命中专属模型池 |
| DefaultPool | 41 | 落 ModelType 默认池 |
| NotFound | 7 | 无匹配池（黑洞，预期内） |

### 1.3 按应用前缀（38 个应用）

| 应用前缀 | 入口数 | | 应用前缀 | 入口数 |
|---|---|---|---|---|
| visual-agent | 17 | | video-agent | 10 |
| ai-toolbox | 9 | | workflow-agent | 8 |
| pm-agent | 7 | | channel-trace-agent | 6 |
| defect-agent | 6 | | md-to-ppt-agent | 6 |
| prd-agent-desktop | 6 | | report-agent | 6 |
| ccas-agent | 5 | | prd-agent-web | 5 |
| product-agent | 5 | | admin | 4 |
| document-store | 4 | | literary-agent | 4 |
| prd-admin | 4 | | speech-agent | 4 |
| system | 4 | | open-platform-agent | 3 |
| prd-agent | 3 | | channel-adapter | 2 |
| emergence-explorer | 2 | | front-end-agent | 2 |
| marketplace-skill | 2 | | open-api | 2 |
| pa-agent | 2 | | pr-review | 2 |
| project-route-agent | 2 | | skill-agent | 2 |
| transcript-agent | 2 | | infra-agent | 1 |
| page-agent | 1 | | review-agent | 1 |
| shitu-agent | 1 | | tapd-bug-agent | 1 |
| task-tree-agent | 1 | | tutorial-email | 1 |

## 2. A 层：全部 153 个入口的真实解析结果（golden SSOT）

> 每行 = 一个 appCallerCode 经 ModelResolver 解析后的真实落点。CI golden 守卫
> `LlmResolutionGoldenIntegrationTests` 比对同一份夹具；任一行漂移即报 mismatch。

| # | appCallerCode | ModelType | 档位 | actualModel | 平台 | 协议 | 健康 | 兜底 | 解析依据 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | admin.platforms.available-models::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 2 | admin.platforms.fetch-models::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 3 | admin.platforms.reclassify.fetch-models::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 4 | admin.platforms.refresh-models::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 5 | ai-toolbox.agent.defect::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 6 | ai-toolbox.agent.literary::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 7 | ai-toolbox.agent.prd::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 8 | ai-toolbox.agent.visual::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 9 | ai-toolbox.agent.visual::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 10 | ai-toolbox.agent.visual::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 11 | ai-toolbox.orchestration::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 12 | ai-toolbox.orchestration::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 13 | ai-toolbox.orchestration::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 14 | ccas-agent.equipment::generation | generation | DefaultPool | stub-image | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 15 | ccas-agent.flow::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 16 | ccas-agent.prd::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 17 | ccas-agent.qa::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 18 | ccas-agent.sql-ai::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 19 | channel-adapter.email.classify::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 20 | channel-adapter.email.todo-extract::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 21 | channel-trace-agent.case-import::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 22 | channel-trace-agent.code-diff.keywords::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 23 | channel-trace-agent.code-diff::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 24 | channel-trace-agent.diagnose::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 25 | channel-trace-agent.knowledge::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 26 | channel-trace-agent.knowledge::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 27 | defect-agent.analyze-image::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 28 | defect-agent.extract::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 29 | defect-agent.polish-stream::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 30 | defect-agent.polish::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 31 | defect-agent.review::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 32 | defect-agent.scoring::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 33 | document-store.reprocess::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 34 | document-store.selection-rewrite::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 35 | document-store.subtitle::asr | asr | DedicatedPool | openai/gpt-audio | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 36 | document-store.subtitle::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 37 | emergence-explorer.emerge::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 38 | emergence-explorer.explore::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 39 | front-end-agent.assistant::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 40 | front-end-agent.assistant::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 41 | infra-agent.review-lite::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 42 | literary-agent.content::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 43 | literary-agent.illustration.img2img::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 44 | literary-agent.illustration.text2img::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 45 | literary-agent.prompt.optimize::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 46 | marketplace-skill.draft-description::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 47 | marketplace-skill.summary::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 48 | md-to-ppt-agent.chat-refine::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 49 | md-to-ppt-agent.generation::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 50 | md-to-ppt-agent.html-generate::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 51 | md-to-ppt-agent.outline::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 52 | md-to-ppt-agent.patch::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 53 | md-to-ppt-agent.template-extract::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 54 | open-api.proxy::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 55 | open-api.proxy::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 56 | open-platform-agent.proxy::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 57 | open-platform-agent.proxy::embedding | embedding | NotFound | — | — | — | — | 否 | — |
| 58 | open-platform-agent.proxy::rerank | rerank | NotFound | — | — | — | — | 否 | — |
| 59 | pa-agent.chat::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 60 | pa-agent.review::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 61 | page-agent.generate::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 62 | pm-agent.assistant::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 63 | pm-agent.briefing::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 64 | pm-agent.closure-report::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 65 | pm-agent.decompose::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 66 | pm-agent.goal-decompose::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 67 | pm-agent.health-diagnosis::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 68 | pm-agent.milestone-suggest::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 69 | pr-review.alignment::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 70 | pr-review.summary::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 71 | prd-admin.ai-news.commentary::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 72 | prd-admin.changelog.ai-summary::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 73 | prd-admin.team-activity.endpoint-diagnose::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 74 | prd-admin.team-activity.insight-brief::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 75 | prd-agent-desktop.chat.sendmessage::chat | chat | DedicatedPool | deepseek/deepseek-v3.2 | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 76 | prd-agent-desktop.chat.suggested-questions::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 77 | prd-agent-desktop.gap.detection::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 78 | prd-agent-desktop.gap.summarization::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 79 | prd-agent-desktop.group-name.suggest::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 80 | prd-agent-desktop.preview-ask.section::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 81 | prd-agent-web.lab::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 82 | prd-agent-web.lab::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 83 | prd-agent-web.lab::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 84 | prd-agent-web.model-lab.run::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 85 | prd-agent-web.platforms.reclassify::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 86 | prd-agent.arena.battle::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 87 | prd-agent.guide::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 88 | prd-agent.skill-gen::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 89 | product-agent.graph-summary::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 90 | product-agent.marketing-consult::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 91 | product-agent.requirement-ai-fill::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 92 | product-agent.trace-relation-analysis::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 93 | product-agent.work-assistant::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 94 | project-route-agent.extract.apps::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 95 | project-route-agent.resolve.routemap::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 96 | report-agent.aggregate::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 97 | report-agent.daily-log.polish::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 98 | report-agent.generate::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 99 | report-agent.import::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 100 | report-agent.weekly-poster.autopilot::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 101 | report-agent.weekly-poster.image::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 102 | review-agent.review::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 103 | shitu-agent.qa::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 104 | skill-agent.export.readme::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 105 | skill-agent.guide::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 106 | speech-agent.mindmap.outline::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 107 | speech-agent.mindmap.speaker-notes::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 108 | speech-agent.node-image::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 109 | speech-agent.node-rewrite::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 110 | system.health-probe::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 111 | system.health-probe::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 112 | system.health-probe::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 113 | system.health-probe::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 114 | tapd-bug-agent.extract::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 115 | task-tree-agent.extract::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 116 | transcript-agent.copywrite::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 117 | transcript-agent.transcribe::asr | asr | DefaultPool | openai/gpt-audio | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 118 | tutorial-email.generate::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 119 | video-agent.audio::tts | tts | NotFound | — | — | — | — | 否 | — |
| 120 | video-agent.image.text2img::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 121 | video-agent.scene.codegen::code | code | NotFound | — | — | — | — | 否 | — |
| 122 | video-agent.script::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 123 | video-agent.text-to-copy::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 124 | video-agent.v2d.analyze::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 125 | video-agent.v2d.transcribe::asr | asr | DedicatedPool | openai/gpt-audio | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 126 | video-agent.video-to-text::asr | asr | DedicatedPool | openai/gpt-audio | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 127 | video-agent.video-to-text::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 128 | video-agent.videogen::video-gen | video-gen | DefaultPool | alibaba/wan-2.6 | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 129 | visual-agent.compose::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 130 | visual-agent.compose::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 131 | visual-agent.drawing-board::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 132 | visual-agent.image-gen.batch-generate::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 133 | visual-agent.image-gen.clarify::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 134 | visual-agent.image-gen.extract-style::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 135 | visual-agent.image-gen.generate::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 136 | visual-agent.image-gen.plan::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 137 | visual-agent.image.describe::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 138 | visual-agent.image.img2img::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 139 | visual-agent.image.text2img::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 140 | visual-agent.image.vision::generation | generation | DefaultPool | stub-image | openai | — | Healthy | 否 | — |
| 141 | visual-agent.image::vision | vision | DefaultPool | qwen/qwen3.6-plus | openai | — | Healthy | 否 | — |
| 142 | visual-agent.scene.codegen::code | code | NotFound | — | — | — | — | 否 | — |
| 143 | visual-agent.storyboard.script::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 144 | visual-agent.videogen::video-gen | video-gen | DefaultPool | alibaba/wan-2.6 | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 145 | visual-agent.workspace-title::intent | intent | DefaultPool | deepseek/deepseek-v4-flash | openai | — | Healthy | 否 | — |
| 146 | workflow-agent.ai-fill::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 147 | workflow-agent.chat-assistant::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 148 | workflow-agent.chat-repair::chat | chat | DedicatedPool | deepseek/deepseek-v4-flash | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 149 | workflow-agent.cli-agent::code | code | NotFound | — | — | — | — | 否 | — |
| 150 | workflow-agent.error-analyzer::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 151 | workflow-agent.llm-analyzer::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 152 | workflow-agent.report-generator::chat | chat | DedicatedPool | qwen/qwen3.6-plus | openai | openai | Healthy | 否 | protocol-from-platform-type |
| 153 | workflow-agent.webpage-generator::code | code | NotFound | — | — | — | — | 否 | — |

## 3. B 层：协议保真数据驱动 cell（91 个，CI 真跑）

> 喂 canned 上游 payload 给真实 `OpenAIGatewayAdapter`/`ClaudeGatewayAdapter`/`ThinkTagStripper`，
> 断言归一结果。`GatewayProtocolFidelityTests` 经 `[Theory]` 读 `protocol-cells.json` 逐 cell 执行。

分组小计：claude-content-text=9 · claude-edge-null=2 · claude-error=1 · claude-message-content=9 · claude-message-stop=1 · claude-stop-reason=4 · claude-tooluse-2=1 · claude-tooluse-normalize=1 · claude-usage-cache=3 · openai-content-text=9 · openai-edge-null=4 · openai-finish=4 · openai-finish-with-content=1 · openai-message-content=9 · openai-nonstream-tool=1 · openai-nonstream-tool-2=1 · openai-nonstream-usage=3 · openai-stream-usage=3 · openai-think-reasoning=9 · openai-think-reasoning_content=9 · openai-tool-delta=1 · openai-tool-delta-2=1 · think-cross-chunk=1 · think-inline=1 · think-nonascii-after=1 · think-only=1 · think-plain=1

| # | adapter | method | 维度 | payload(节选) | 期望 |
|---|---|---|---|---|---|
| B001 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=hello |
| B002 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=café-naïve-Zürich |
| B003 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=中文深度思考内容 |
| B004 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=مرحبا بالعالم |
| B005 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=a   b   c |
| B006 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=he said "hi" to me |
| B007 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=line1\nline2 |
| B008 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=Omega-Ω-approx-≈-sqrt-√ |
| B009 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning_content": … | chunkType=Thinking, content=xxxxxxxxxxxxxxxxxxxxxxx… |
| B010 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "hello"}… | chunkType=Thinking, content=hello |
| B011 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "café-na… | chunkType=Thinking, content=café-naïve-Zürich |
| B012 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "中文深度思考内… | chunkType=Thinking, content=中文深度思考内容 |
| B013 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "مرحبا ب… | chunkType=Thinking, content=مرحبا بالعالم |
| B014 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "a   b  … | chunkType=Thinking, content=a   b   c |
| B015 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "he said… | chunkType=Thinking, content=he said "hi" to me |
| B016 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "line1\n… | chunkType=Thinking, content=line1\nline2 |
| B017 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "Omega-Ω… | chunkType=Thinking, content=Omega-Ω-approx-≈-sqrt-√ |
| B018 | openai | stream | D5/E2 | {"choices": [{"delta": {"reasoning": "xxxxxxx… | chunkType=Thinking, content=xxxxxxxxxxxxxxxxxxxxxxx… |
| B019 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "hello"}}]} | chunkType=Text, content=hello |
| B020 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "café-naïv… | chunkType=Text, content=café-naïve-Zürich |
| B021 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "中文深度思考内容"… | chunkType=Text, content=中文深度思考内容 |
| B022 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "مرحبا بال… | chunkType=Text, content=مرحبا بالعالم |
| B023 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "a   b   c… | chunkType=Text, content=a   b   c |
| B024 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "he said \… | chunkType=Text, content=he said "hi" to me |
| B025 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "line1\nli… | chunkType=Text, content=line1\nline2 |
| B026 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "Omega-Ω-a… | chunkType=Text, content=Omega-Ω-approx-≈-sqrt-√ |
| B027 | openai | stream | D2/E2 | {"choices": [{"delta": {"content": "xxxxxxxxx… | chunkType=Text, content=xxxxxxxxxxxxxxxxxxxxxxx… |
| B028 | openai | stream | E3 | {"choices": [{"delta": {}, "finish_reason": "… | chunkType=Done, finishReason=stop |
| B029 | openai | stream | E3 | {"choices": [{"delta": {}, "finish_reason": "… | chunkType=Done, finishReason=length |
| B030 | openai | stream | E3 | {"choices": [{"delta": {}, "finish_reason": "… | chunkType=Done, finishReason=tool_calls |
| B031 | openai | stream | E3 | {"choices": [{"delta": {}, "finish_reason": "… | chunkType=Done, finishReason=content_filter |
| B032 | openai | stream | E3 | {"choices": [{"delta": {"content": "tail"}, "… | chunkType=Done, finishReason=stop, content=tail |
| B033 | openai | stream | D7 | {"choices": [], "usage": {"prompt_tokens": 12… | chunkType=Done, inputTokens=12, outputTokens=7 |
| B034 | openai | stream | D7 | {"choices": [], "usage": {"prompt_tokens": 1,… | chunkType=Done, inputTokens=1, outputTokens=0 |
| B035 | openai | stream | D7 | {"choices": [], "usage": {"prompt_tokens": 40… | chunkType=Done, inputTokens=4096, outputTokens=2048 |
| B036 | openai | stream | D6 | {"choices": [{"delta": {"tool_calls": [{"inde… | chunkType=ToolCall |
| B037 | openai | stream | D6/E8 | {"choices": [{"delta": {"tool_calls": [{"inde… | chunkType=ToolCall |
| B038 | openai | stream | E1 | chunks:[] | chunkType=null |
| B039 | openai | stream | E1 |     | chunkType=null |
| B040 | openai | stream | E1 | {} | chunkType=null |
| B041 | openai | stream | E1 | {"choices": [{"delta": {}}]} | chunkType=null |
| B042 | openai | tokenUsage | D7 | {"usage": {"prompt_tokens": 30, "completion_t… | inputTokens=30, outputTokens=11 |
| B043 | openai | tokenUsage | D7 | {"usage": {"prompt_tokens": 0, "completion_to… | inputTokens=0, outputTokens=0 |
| B044 | openai | tokenUsage | D7 | {"usage": {"prompt_tokens": 1000, "completion… | inputTokens=1000, outputTokens=500 |
| B045 | openai | toolCalls | D6 | {"choices": [{"message": {"tool_calls": [{"id… | toolCount=1 |
| B046 | openai | toolCalls | D6/E8 | {"choices": [{"message": {"tool_calls": [{"id… | toolCount=2 |
| B047 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "hello"}… | content=hello |
| B048 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "café-na… | content=café-naïve-Zürich |
| B049 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "中文深度思考内… | content=中文深度思考内容 |
| B050 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "مرحبا ب… | content=مرحبا بالعالم |
| B051 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "a   b  … | content=a   b   c |
| B052 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "he said… | content=he said "hi" to me |
| B053 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "line1\n… | content=line1\nline2 |
| B054 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "Omega-Ω… | content=Omega-Ω-approx-≈-sqrt-√ |
| B055 | openai | messageContent | D9/E2 | {"choices": [{"message": {"content": "xxxxxxx… | content=xxxxxxxxxxxxxxxxxxxxxxx… |
| B056 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=hello |
| B057 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=café-naïve-Zürich |
| B058 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=中文深度思考内容 |
| B059 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=مرحبا بالعالم |
| B060 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=a   b   c |
| B061 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=he said "hi" to me |
| B062 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=line1\nline2 |
| B063 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=Omega-Ω-approx-≈-sqrt-√ |
| B064 | claude | stream | D2/E2 | {"type": "content_block_delta", "delta": {"te… | chunkType=Text, content=xxxxxxxxxxxxxxxxxxxxxxx… |
| B065 | claude | stream | E3 | {"type": "message_delta", "delta": {"stop_rea… | chunkType=Done, finishReason=end_turn |
| B066 | claude | stream | E3 | {"type": "message_delta", "delta": {"stop_rea… | chunkType=Done, finishReason=max_tokens |
| B067 | claude | stream | E3 | {"type": "message_delta", "delta": {"stop_rea… | chunkType=Done, finishReason=tool_use |
| B068 | claude | stream | E3 | {"type": "message_delta", "delta": {"stop_rea… | chunkType=Done, finishReason=stop_sequence |
| B069 | claude | stream | E3 | {"type": "message_stop"} | chunkType=Done, finishReason=stop |
| B070 | claude | stream | D11 | {"type": "error", "error": {"message": "upstr… | chunkType=Error, error=upstream boom |
| B071 | claude | stream | E1 | chunks:[] | chunkType=null |
| B072 | claude | stream | E1 | {"type": "ping"} | chunkType=null |
| B073 | claude | tokenUsage | D7/E9 | {"usage": {"input_tokens": 40, "output_tokens… | inputTokens=40, outputTokens=9, cacheCreation=15, cacheRead=3 |
| B074 | claude | tokenUsage | D7/E9 | {"usage": {"input_tokens": 100, "output_token… | inputTokens=100, outputTokens=50, cacheCreation=0, cacheRead=0 |
| B075 | claude | tokenUsage | D7/E9 | {"usage": {"input_tokens": 10, "output_tokens… | inputTokens=10, outputTokens=5, cacheCreation=7, cacheRead=2 |
| B076 | claude | toolCalls | D6 | {"content": [{"type": "tool_use", "id": "tu_1… | toolCount=1, toolFirstName=search, toolFirstType=function |
| B077 | claude | toolCalls | D6/E8 | {"content": [{"type": "tool_use", "id": "t1",… | toolCount=2, toolFirstName=alpha, toolFirstType=function |
| B078 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "hello"… | content=hello |
| B079 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "café-n… | content=café-naïve-Zürich |
| B080 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "中文深度思考… | content=中文深度思考内容 |
| B081 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "مرحبا … | content=مرحبا بالعالم |
| B082 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "a   b … | content=a   b   c |
| B083 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "he sai… | content=he said "hi" to me |
| B084 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "line1\… | content=line1\nline2 |
| B085 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "Omega-… | content=Omega-Ω-approx-≈-sqrt-√ |
| B086 | claude | messageContent | D9/E2 | {"content": [{"type": "text", "text": "xxxxxx… | content=xxxxxxxxxxxxxxxxxxxxxxx… |
| B087 | — | thinkStripper | D5 | chunks:["<think>推理内容</think>正式回答"] | thinkVisible=正式回答, thinkCaptured=推理内容 |
| B088 | — | thinkStripper | D5/E4 | chunks:["abc<thi", "nk>secret</thi", "nk>xyz"] | thinkVisible=abcxyz |
| B089 | — | thinkStripper | D5 | chunks:["just text"] | thinkVisible=just text, thinkCapturedEmpty=True |
| B090 | — | thinkStripper | D5 | chunks:["<think>only thinking</think>"] | thinkVisible=, thinkCaptured=only thinking |
| B091 | — | thinkStripper | D5/E2 | chunks:["<think>t</think>done-完成"] | thinkVisible=done-完成, thinkCaptured=t |

## 4. C 层：跨进程传输数据驱动 cell（18 个，CI 真跑）

> 真 Kestrel + 真 `HttpLlmGatewayClient` + stub gateway。`CrossProcessServingErrorLoadTests` 经
> `[Theory]` 读 `transport-cells.json` 逐 cell 执行（方法×上游×鉴权×并发）。

| # | 方法 | 上游(stub) | 鉴权 | 并发 | 维度 | 期望 |
|---|---|---|---|---|---|---|
| C001 | send | echo | 对 | 1 | D1 | success=True, contentEcho=True |
| C002 | send | echo | 错 | 1 | E17 | success=False, statusCode=401 |
| C003 | send | failing | 对 | 1 | D11 | success=False, errorCodeNonEmpty=True |
| C004 | send | throwing | 对 | 1 | D11 | success=False |
| C005 | send | empty | 对 | 1 | E1 | success=True, contentEmpty=True |
| C006 | send | echo | 对 | 16 | D12/E15 | success=True, contentEcho=True, concurrentNoCrossTalk=True |
| C007 | stream | echo | 对 | 1 | D2 | minChunks=2, seqMonotonic=True, textJoined=hello |
| C008 | stream | echo | 错 | 1 | E17 | streamFailed=True |
| C009 | stream | failing | 对 | 1 | D11 | streamHasError=True |
| C010 | stream | echo | 对 | 8 | D12 | minChunks=2, concurrentNoCrossTalk=True |
| C011 | raw | echo | 对 | 1 | D8 | success=True |
| C012 | raw | failing | 对 | 1 | D11 | success=False |
| C013 | raw | echo | 错 | 1 | E17 | success=False, statusCode=401 |
| C014 | pools | echo | 对 | 1 | D3 | poolsOk=True |
| C015 | pools | echo | 错 | 1 | E17 | poolsFailed=True |
| C016 | resolve | echo | 对 | 1 | E12/安全 | actualModel=m1, apiKeyNull=True |
| C017 | resolve | echo | 错 | 1 | E17 | resolveFailed=True |
| C018 | client-stream | echo | 对 | 1 | D2 | minChunks=2, textJoined=hi |

## 5. 扩展维度（emerge，20 个）

| 维度 | 取值 | 覆盖层 | 期望 |
|---|---|---|---|
| E1 内容边界 | 空响应 / 超长截断[TEXT_COS] / 单字符 / 纯空白 | B+C | 还原可读、截断标记、空内容兜底、不内联超长 |
| E2 字符集 | ASCII / emoji / CJK / RTL / 含引号 / 换行 / unicode 符号 / 300 字长串 | B | 原样透传不乱码 |
| E3 finish 全枚举 | openai stop/length/tool_calls/content_filter；claude end_turn/max_tokens/tool_use/stop_sequence/message_stop | B | 归一为 Done + 保留原因 |
| E4 畸形 SSE | 跨 chunk 半截 <think> / 缺 [DONE] / 乱序 Seq / keepalive 心跳 | B+C | 缝合或兜底 Done、Seq 单调 |
| E5 断线续传 | afterSeq 重连从断点续 chunk | C/D | afterSeq 后不重发已收 chunk |
| E6 vision 入图 | detail high/low/auto + 多图 + 坏图 URL | B+D | 多图都解析、坏图兜底不崩 |
| E7 生图三格式 | base64 inline / [BASE64_IMAGE:sha] / COS URL | B+D | 三格式归一成可显示 URL、不内联 base64 |
| E8 parallel tools | 多 tool_calls 并行（openai 数组 / claude 多 tool_use） | B | ToolCallCount 准、首个名称对 |
| E9 prompt-cache | claude cache_creation vs cache_read 分别采集 | B+D | cache token 分字段落库 |
| E10 池故障转移 | 主池故障 → IsFallback=true + FallbackReason | A+D | 兜底标记 + 原因可观测 |
| E11 exchange 中继 | exchange transformer 改写请求/响应 | A+B | 选对 transformer、协议来源记录 |
| E12 防选A给B | 直连 expectedModel + 跨进程 resolve ApiKey 不过线 | A+C+D | actualModel==expected，ApiKey 跨进程恒 null |
| E13 NotFound 黑洞 | 无匹配池 → blackhole 落库（golden 中 7 条 NotFound） | A+D | Status=blackhole 入库可见（非静默丢） |
| E14 假流式 | firstByte 慢 + 心跳文案分级(0-15/15-40/40s+) | C+D | 心跳推进、文案带 model 名 |
| E15 租户隔离 | 并发同 session 顺序 + 跨租户 UserId 不串（16 并发回显自己） | C+D | Context.UserId 各归各、非空 |
| E16 raw 大负载 | multipart 文件引用不内联 base64 + 图片 base64→sha | C+D | 走对象存储引用、行不内联 |
| E17 鉴权三态 | 无 key / 错 key / 对 key（C 层每方法都覆盖错 key→401） | C | 401 / 401 / 200 |
| E18 协议来源三层 | pool-item > model > platform 各覆盖一次（golden ResolutionReason） | A | ResolutionReason 记录命中层级 |
| E19 ModelType 覆盖 | golden 实际出现 chat/intent/vision/generation/asr/embedding/rerank/tts/code/video-gen | A | 每类至少一个入口注册并解析 |
| E20 观测落库闭环 | 每 cell 跑完日志页可查 requestId + 字段 | D | requestId 可查、字段齐 |

## 6. D 层：真机 live 结果（待 CDS 升级后追加）

> CDS 支持单分支多容器 + 导入审批通过后，`scripts/gw-smoke.py` 对真网关跑全 153 resolve
> + 抽样真打 + 必败 canary，把 live 结果（model/finish/token/图片URL/requestId）追加到本节。当前为占位。

