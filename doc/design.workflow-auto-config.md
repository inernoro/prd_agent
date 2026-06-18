# 工作流自动配置 (Workflow Auto-Config) · 设计

> **appKey**：`workflow-agent` | **状态**：方案待评审 | **主文档**：`design.workflow-engine.md`
>
> 本文只覆盖「降低配置门槛 + AI 一次把问题配清楚」这一子领域，工作流引擎本体（DAG 执行、舱执行链路、调度）见主文档。

## 一、管理摘要

- **解决什么问题**：今天配一个工作流对非工程用户太难——空白画布要拖舱、手动连 slot、逐字段填配置、定义变量；AI 助手虽能一句话生成，但产出的是「草稿」不是「可跑件」（解析脆、不校验、缺项不提示、造不出定时/Webhook 触发）。
- **方案概述**：把 AI 助手从「生成 JSON 就完事」升级为一个**生成 → 校验 → 自愈 → 补缺 → 可跑**的闭环，并把空状态默认入口从画布换成对话。用户只需描述需求 + 补几个必填项，其余自动完成。
- **业务价值**：把「能画出流程图的人才能用」降级为「能说清想干什么的人就能用」，让工作流真正做到「一次性把用户的问题解决清楚」。
- **影响范围**：`WorkflowAgentController`（对话生成端点）、新增 `WorkflowValidationService`、`WorkflowChatPanel` / `WorkflowListPage` 空状态、`CapsuleTypeRegistry`（触发舱开放）。
- **当前状态**：方案待评审，未动代码。

## 二、现状验收结论（为什么要改）

代码实读结论（`WorkflowChatPanel.tsx` / `WorkflowAgentController.cs:1609-2119` / `WorkflowAiFillService.cs` / `capsuleRegistry.tsx`）：

| 维度 | 现状 | 问题 |
|------|------|------|
| 入口 | 空白新建 / 12 个写死模板 / AI 对话 | 空白路对非工程用户不可用；模板只覆盖固定场景 |
| AI 解析 | 只取第一个 ```json 块，正则截取 | 格式漂移即静默返回 null，用户白等 |
| AI 校验 | 仅验节点类型存在（`TryParseWorkflowFromResponse`） | 不验必填字段 / slot 存在性 / 悬空边 / 成环，产出可能跑不起来 |
| 缺项提示 | 无 | AI 引用 `{{cookie}}` 等 secret 时不提示补齐，坑留到运行时 |
| 节点 AI 填写 | 只预填对话框（`WorkflowEditorPage.tsx:1024`） | 不直接填，还要再走一轮对话 |
| 触发能力 | `timer`/`webhook-receiver`/`file-upload` 标 `DisabledReason` 被 prompt 过滤 | AI 造不出定时 / Webhook 触发的工作流——最常见诉求的硬缺口 |
| 输出格式 | `temperature 0.3`，无 structured output | 全靠模型自觉，无回路修正 |

一句话：AI 产出是「草稿」，差一个**校验+自愈+补全**闭环才是「可执行件」。

## 三、目标与非目标

**目标**
1. 默认入口对话化：空状态首屏引导「描述你想做什么」，而非拖画布。
2. AI 生成结果**结构可信**：必填字段、slot 存在性、边连通性、无环全部校验通过才算成功。
3. 生成失败能**自愈**：把校验错误回喂 LLM 自动修最多 N 轮，再不行才降级提示。
4. 缺项**显式补齐**：生成后扫未填必填配置 + secret 变量，弹一个「补这几项就能跑」表单（复用模板表单交互）。
5. slot **自动接线**：边不让用户/LLM 猜 slotId，按节点顺序 + dataType 匹配自动推断。

**非目标（本期不做）**
- 不重做执行引擎 / 调度器（主文档范畴）。
- 不做可视化拖拽体验本身的重构（画布手势、节点样式另议）。
- 不替换现有 12 个模板（保留为快捷路径，与对话入口并存）。

## 四、关键决策

### 决策 1：在「解析」与「应用」之间插入校验自愈层（核心）

现有链路 `LLM 流 → TryParse → 直接落库/确认`，改为：

```
LLM 流 → TryParse → WorkflowValidationService.Validate
   ├─ 通过 → 自动接线补全 → 缺项扫描 → 落库/确认
   └─ 失败 → 错误清单回喂 LLM（最多 N=2 轮）→ 仍失败 → 降级：保留草稿 + 明确告知哪步不合法
```

校验项（服务端，纯函数可单测）：
- 每个 node 的 `nodeType` 存在且未 disabled。
- 每个必填 `ConfigSchema` 字段有值或有对应 `{{变量}}`（变量已在 variables 声明）。
- 每条 edge 的 `sourceSlotId` / `targetSlotId` 真实存在于对应舱的默认插槽。
- 无悬空边（指向不存在的 node）、无环（DAG）、至少一个触发/起点。

### 决策 2：自动接线（dataType 匹配推断）

LLM 经常把 slotId 写错或留空。生成后由服务端按「节点声明顺序 + 上游 output dataType 与下游 input dataType 匹配」自动补/纠正 edges；只有当一个下游有多个 dataType 兼容上游、无法确定时，才在缺项卡里让用户选一次。这样把「连线」这件最易错的事从用户/LLM 手里拿走。

### 决策 3：缺项补齐卡 = 复用模板输入表单

生成完成后返回一个 `requiredInputs` 列表（结构同 `TemplateInput`），前端直接复用 `TemplatePickerDialog` 的字段渲染（含 cookie 验证、workspace 下拉、auth-picker）。用户在一个表单里补完即可跑，不用进画布逐节点找。

### 决策 4：触发能力接地（no-rootless-tree）

两选一，建议**先做 B**：
- A：打开 `timer` / `webhook-receiver` 的后端实现（调度器 / 接收入口），让 AI 能真造定时/Webhook 流（工作量大，依赖主引擎）。
- B（本期）：保留 disabled，但**在 prompt 里显式告诉 AI 这些能力暂未开放**，并要求 AI 在需要时产出「手动触发 + 一句话说明：定时触发待开放」，而不是静默省略。避免 AI 假装能力存在。

### 决策 5：structured output 优先，正则兜底

若 `ILlmGateway` 当前模型支持 JSON mode / response_format，则强制结构化输出消除解析脆弱；不支持时保留现有 ```json 提取 + 决策 1 的自愈回路兜底。需先确认 Gateway 能力（见风险）。

## 五、改动范围（diff 预览）

| 层 | 文件 | 改动 |
|----|------|------|
| 后端 | 新增 `Services/WorkflowValidationService.cs` | 校验 + 自动接线 + 缺项扫描，纯函数可单测 |
| 后端 | `Controllers/Api/WorkflowAgentController.cs` `ChatCreateWorkflow` | 解析后接入校验自愈回路 + 返回 `requiredInputs` + `validation` 事件 |
| 后端 | `Controllers/Api/WorkflowAgentController.cs` `BuildChatSystemPrompt` | 触发能力接地说明 + structured output 约束 |
| 后端 | `tests/.../WorkflowValidationServiceTests.cs` | 校验/接线/缺项单测（首选自测路径） |
| 前端 | `WorkflowChatPanel.tsx` | 新增 `workflow_validating` / `requiredInputs` 事件渲染 + 缺项补齐卡 |
| 前端 | `WorkflowListPage.tsx` 空状态 | 首屏大输入框「描述你想做什么」直连对话生成 |
| 前端 | 复用 `TemplatePickerDialog` 字段组件 | 抽出 `TemplateConfigForm` 为共享，供缺项卡复用 |

## 六、分期实施

- **Phase 1（最高收益，建议先做）**：决策 1 + 决策 2 + 单测。把 AI 产出从「草稿」变「可跑」，纯后端，可用 xUnit 自测闭环，不依赖 UI。
- **Phase 2**：决策 3 缺项补齐卡 + 决策 5 structured output。前端 + prompt。
- **Phase 3**：决策 4 触发能力（先 B 接地，A 视主引擎排期）+ 空状态对话化入口。

## 七、风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 自愈回路放大延迟（N 轮额外 LLM 调用） | 中 | N≤2，且仅在校验失败时触发；流式期间 SSE 推「正在校验/修正」阶段，禁止空白等待 |
| 自动接线推断错连 | 中 | 仅在 dataType 唯一匹配时自动连，多义时让用户选；保留手动改线 |
| Gateway 不支持 structured output | 中 | 决策 5 已留正则兜底；先验证 Gateway 能力再定 |
| 触发舱开放牵动主引擎 | 中 | 本期只做 B（接地说明），A 留主文档排期 |
| 校验过严卡住合法工作流 | 低 | 校验项全部单测覆盖，先 warning 后 block 灰度 |

## 八、自测计划（CLAUDE.md §8.1）

- Phase 1：`WorkflowValidationServiceTests` 覆盖「缺必填 / slot 不存在 / 悬空边 / 成环 / 合法直通 / 自动接线唯一匹配 / 多义不连」，xUnit 全绿。
- 集成：构造一段会让 LLM 产出错误 slot 的指令，断言自愈回路最终落库的工作流校验通过（mock Gateway 返回先错后对）。
- 端到端：`/cds-deploy` 后预览域名走「空状态描述 → 生成 → 补缺 → 试跑」全链路取证。

## 九、关联文档

- `design.workflow-engine.md`：工作流引擎本体（执行/调度/舱执行链路）
- `debt.workflow-agent.md`：工作流债务台账（触发舱开放属此）
- `.claude/rules/no-rootless-tree.md`：触发能力接地依据
- `.claude/rules/llm-gateway.md`：自愈回路的 LlmRequestContext / structured output 约束
- `.claude/rules/artifact-is-experience.md`：校验/自愈期间的等待体验
