# 演讲智能体 · 设计

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：已落地

> **appKey**：`speech-agent`

## 一、管理摘要

- **产品目标**：把长文或知识库文档转换为可编辑、可演讲、可发布的结构化演讲材料。
- **当前能力**：演讲列表与创建、思维导图大纲生成、节点编辑与改写、讲稿、节点配图、播放模式和 HTML 发布。
- **架构决策**：文本模型通过 LLM Gateway，图片通过 Image Gateway；演讲与节点由服务端持久化，前端只负责编辑和展示。
- **已知边界**：大纲生成使用服务器权威的内联 SSE 与生成指纹防并发覆盖，尚未迁移为通用 Run/Worker 断线续读。

## 1. 产品边界

演讲智能体负责从输入材料提取演讲结构，并围绕每个节点补充要点、讲稿和视觉素材。它不替代完整幻灯片设计器，也不承诺自动生成的内容无需人工校对。

支持直接粘贴文本和从文档创建。服务端限制输入长度并保留来源类型与引用，前端不能绕过长度、所有权和文档访问校验。

## 2. 核心流程

1. 用户创建演讲，填写标题、受众、风格、深度和源材料。
2. 服务端保存 deck，再启动大纲生成。
3. 模型流式返回思考和正文，服务端解析为树形节点。
4. 新一代节点通过 generation run 指纹原子替换旧节点。
5. 用户编辑节点、生成或修改讲稿、改写内容并生成配图。
6. 用户进入播放模式，或发布为可访问的 HTML 演讲页面。

## 3. 领域模型

| 对象 | 责任 |
|------|------|
| SpeechDeck | 标题、来源、受众、风格、状态、当前生成指纹和发布信息 |
| SpeechNode | 树层级、顺序、标题、要点、讲稿、图片引用和所属生成批次 |

Deck 是聚合根。节点必须同时按 deck ID 与节点 ID 查询，所有 deck 操作必须校验当前用户所有权。删除 deck 时级联处理节点及业务引用，对象存储资产的生命周期仍按资产规则执行。

## 4. 大纲生成与 SSE

大纲生成使用 `SpeechAgent.Mindmap.Outline` 调用身份，通过 LLM Gateway 选择文本模型。输入包括源材料和演讲参数，输出先累积为结构化结果，再转换为节点。

| 事件 | 含义 |
|------|------|
| phase | 准备、分析等阶段状态 |
| model | 实际模型和平台 |
| thinking | 模型推理增量，能力支持时展示 |
| typing | 正文增量 |
| node | 已解析并持久化的节点 |
| done | 节点数、耗时和完成状态 |
| error | 结构化失败原因 |

客户端断开不能取消服务端任务。当前协议没有通用 afterSeq 重放，断线后以前端重新读取 deck 状态和节点为兜底。

## 5. 并发与原子替换

- 每次生成分配独立 `GenerationRunId`。
- 短时间内已有活动生成时拒绝重复启动。
- 新节点全部携带本批指纹，完成前不删除现有可用节点。
- 交换前重读 deck；只有指纹仍属于本批才能清理旧节点并写入 ready 终态。
- 较慢的旧任务被新任务取代后停止提交，不能覆盖新结果和模型信息。

这套指纹是当前大纲生成的并发保护，不等同于通用 Run/Worker 状态机。

## 6. 节点增强能力

| 能力 | 调用身份 | 结果 |
|------|----------|------|
| 生成单节点或批量讲稿 | `SpeechAgent.Mindmap.SpeakerNotes` | 写回 speaker notes |
| 改写节点 | `SpeechAgent.Mindmap.NodeRewrite` | 更新标题、要点或讲稿 |
| 生成节点配图 | `SpeechAgent.Mindmap.NodeImage` | 保存图片资产引用 |

文本增强经过 LLM Gateway，图片生成经过统一 Image Gateway。任何失败只影响目标节点，不应破坏整份演讲。

## 7. 播放与发布

播放页读取服务端 deck 和节点，支持结构浏览、当前节点聚焦和讲稿查看。发布由服务端渲染 HTML，并对无根节点、缺失图片和异常树结构提供可见降级。

发布结果是 deck 当前内容的快照。后续编辑是否自动更新已发布页面以 Controller 的发布行为为准，前端不能仅凭本地状态宣称发布成功。

## 8. 安全与可观测性

- 所有入口要求 `speech-agent.use` 权限，并按 owner 隔离 deck。
- 文档来源必须先通过知识库访问校验。
- LLM 与图片调用记录 appCallerCode、用户、模型和失败阶段。
- SSE 持续展示阶段，不允许超过两秒只显示静态加载。
- 发布内容必须转义用户文本，图片引用使用受控资产 URL。
- 错误日志不输出完整源文、讲稿或模型凭据。

## 9. 当前事实入口

| 能力 | 事实入口 |
|------|----------|
| API 与生成协议 | `prd-api/src/PrdAgent.Api/Controllers/Api/SpeechAgentController.cs` |
| 生成、增强和发布 | `prd-api/src/PrdAgent.Api/Services/SpeechAgentService.cs` |
| 演讲模型 | `prd-api/src/PrdAgent.Core/Models/SpeechAgent/SpeechDeck.cs` |
| 节点模型 | `prd-api/src/PrdAgent.Core/Models/SpeechAgent/SpeechNode.cs` |
| 前端页面 | `prd-admin/src/pages/speech-agent/` |
| 前端契约 | `prd-admin/src/services/contracts/speechAgent.ts` |
| 导航 | `prd-admin/src/app/navRegistry.tsx` |
| 百宝箱 | `prd-admin/src/stores/toolboxStore.ts` |

## 10. 验收标准

- 用户只能读取和修改自己的演讲与节点。
- 生成过程持续显示阶段、模型、文本和节点进度。
- 重复或过期生成不能覆盖较新的节点批次。
- 单节点讲稿、改写或配图失败不破坏 deck。
- 播放与发布在缺图和异常树结构下有明确降级。
- 发布页面不注入未转义的用户内容。

## 关联文档

- `doc/spec.speech-agent.md`
- `doc/debt.speech-agent.md`
- `doc/rule.platform.llm-gateway.md`
- `doc/rule.platform.server-authority.md`
