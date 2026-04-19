# 周报 MAP 平台工作记录准确性修复

**日期**: 2026-04-10
**影响**: 周报 AI 自动生成草稿中 MAP 平台工作记录出现用户未真实产生的行为数据
**修复分支**: `claude/weekly-report-agent-improvements-gTI0J`

---

## 1. 现象回放

用户「余瑞鹏」是某测试团队的新成员，从未在 MAP 平台上做过任何操作。打开周报，AI 自动生成的草稿里却出现：

- 完成 **122 篇**文档的编辑与创建工作，提升知识库内容覆盖度
- 执行 **1 次**网页发布更新
- 调用 **AI 辅助功能 20 次**，优化内容生成与处理效率

这些条目都挂着「MAP 平台工作记录」的 source 标签，并被 AI 加工成有修饰语的业务描述。

## 2. 根因分析

经过逐项审计，在 `MapActivityCollector` 的 14 个数据流查询中定位到 **两个独立缺陷**：

### 根因 1：`Documents` 查询缺失用户过滤（已在前一次提交 `ab795b3` 修复）

**原始代码**（`MapActivityCollector.cs` 第 179 行）：

```csharp
var count = await _db.Documents.Find(
    d => d.CreatedAt >= periodStart && d.CreatedAt <= periodEnd
).CountDocumentsAsync(ct);
```

该查询 **没有任何用户过滤**，统计的是全站在该周新增的 `ParsedPrd` 文档总数。由于 `ParsedPrd` 模型没有 `UserId` 字段，文档归属必须通过 `Group.OwnerId` 间接确定。

**修复**：改用 `Groups.Find(g => g.OwnerId == userId && g.CreatedAt in range)` 统计用户本周创建的 PRD 项目数。标签从「文档编辑/创建: N 篇」改为「创建 PRD 项目: N 个」以准确反映语义。

### 根因 2：`LlmCalls` 自噬循环（本次新增修复）

**原始代码**（`MapActivityCollector.cs` 第 94 行）：

```csharp
var count = await _db.LlmRequestLogs.Find(
    l => l.UserId == userId && l.StartedAt >= periodStart && l.StartedAt <= periodEnd
).CountDocumentsAsync(ct);
```

该查询会把 **报告生成自身的 LLM 调用** 也计入「用户行为」。具体的自噬链路：

```
1. 用户 A 的周报需要生成
    ↓
2. ReportGenerationService.GenerateAsync(A)
    ↓
3. 构造 GatewayRequest { Context.UserId = A }         ← 把目标用户写进调用上下文
    ↓
4. LlmGateway 发起实际 LLM 调用
    ↓
5. LlmRequestLogWriter 记录日志：{ UserId = A, AppCallerCode = "report-agent.generate::chat" }
    ↓
6. 下周 / 下次生成：MapActivityCollector 查询 A 的 LlmRequestLogs
    ↓
7. 把上面那条日志计入 "AI 调用: N 次"
    ↓
8. 喂给 AI → AI 编造出「调用 AI 辅助功能 20 次，优化内容生成与处理效率」
    ↓
9. 写入新的周报 → 产生新的 LLM 调用日志 → 永动机
```

**这是典型的「虚幻有根之木」**（违反 `.claude/rules/no-rootless-tree.md` 原则〇）：表面上 `LlmRequestLogs.UserId == A` 是真的有数据，但这个"根"是报告生成自己挖出来的，不是用户行为的真实映射。

**修复**：在查询中排除所有 `report-agent.*` 前缀的 `AppCallerCode`，并抽取为可单元测试的静态方法 `MapActivityCollector.ShouldCountLlmLog`。

### 根因 3：AI 提示词被动语义漂移

即使数据层修复了，AI 仍可能把「创建 PRD 项目: 2 个」改写成「完成 122 篇文档的编辑与创建工作」这种听起来像产品经理话术但完全失真的描述。这是 LLM 天然倾向的「润色」行为。

**修复**：在 `BuildUserPrompt` / `BuildUserPromptV2` 末尾添加 4 条「严格约束」，明确禁止：
1. 凭空编造
2. 将指标名称改写成其他活动（给出具体反例）
3. 凑整、放大、捏造修饰语
4. 用「无数据」「待补充」占位

---

## 3. 修复涉及文件

| 文件 | 变更 |
|---|---|
| `prd-api/src/PrdAgent.Api/Services/ReportAgent/MapActivityCollector.cs` | LlmCalls 查询加 AppCallerCode 排除 + 抽取 `ShouldCountLlmLog` 静态方法 |
| `prd-api/src/PrdAgent.Api/Services/ReportAgent/ReportGenerationService.cs` | `BuildUserPrompt` / `BuildUserPromptV2` 替换提示词为 4 条严格约束 |
| `prd-api/tests/PrdAgent.Api.Tests/Services/MapActivityCollectorTests.cs` | **新增**：11 个测试覆盖 LlmCalls 过滤逻辑 |
| `prd-api/tests/PrdAgent.Api.Tests/Services/ReportGenerationServiceBuildPromptTests.cs` | 新增 `BuildUserPrompt_WithPrdGroupCount_ShouldNotLeakOldDocumentLabel` + 对齐新提示词断言 |

---

## 4. 测试用例

### 4.1 `MapActivityCollectorTests` — 11 个用例

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T1 | ShouldCountLlmLog_ReportAgentGenerate_ShouldReturnFalse | `"report-agent.generate::chat"` | `false` — 自噬必须排除 |
| T2 | ShouldCountLlmLog_ReportAgentAggregate_ShouldReturnFalse | `"report-agent.aggregate::chat"` | `false` — 团队汇总自噬必须排除 |
| T3 | ShouldCountLlmLog_AnyReportAgentPrefix_ShouldReturnFalse | `"report-agent.future.code::chat"` | `false` — 防未来新增 report-agent 调用点再次污染 |
| T4 | ShouldCountLlmLog_UserChat_ShouldReturnTrue | `"prd-agent-desktop.chat.sendmessage::chat"` | `true` — 用户亲自发起的 PRD 对话 |
| T5 | ShouldCountLlmLog_VisualAgent_ShouldReturnTrue | `"visual-agent.image.vision::generation"` | `true` — 用户发起的视觉创作 |
| T6 | ShouldCountLlmLog_NullOrEmpty_ShouldReturnTrue | `null` / `""` | `true` — 历史日志兼容 |
| T7 | ShouldCountLlmLog_CaseSensitive_ShouldNotMatchUppercase | `"REPORT-AGENT.something"` | `true` — 大小写不误伤 |
| T8 | ShouldCountLlmLog_SimilarPrefix_ShouldNotMatch | `"report-agent-fake.caller::chat"` | `true` — 相似前缀不误伤 |
| T9 | LlmCallFilter_MixedLogs_ShouldOnlyCountUserInitiated | 4 条 report-agent 自噬日志 | `0` — 真实用户行为为 0 |
| T10 | LlmCallFilter_OnlyUserActions_ShouldCountAll | 3 条用户主动调用 | `3` |
| T11 | LlmCallFilter_MixedUserAndSystem_ShouldCountOnlyUser | 混合 6 条 | `4` — 用户 2 + 历史 2 |

### 4.2 `ReportGenerationServiceBuildPromptTests` — 新增 1 个关键用例 + 其他对齐

| # | 用例 | 验证点 |
|---|---|---|
| T12 | BuildUserPrompt_WithPrdGroupCount_ShouldNotLeakOldDocumentLabel | 模拟「余瑞鹏」场景：`DocumentEditCount = 2`，其他全 0。断言：提示词包含「创建 PRD 项目: 2 个」；不含「文档编辑/创建」「编辑与创建」「122」 |
| T13 | BuildUserPrompt_AllZeroMapMetrics_ShouldNotIncludeMapPlatformSection | 全零指标时整个 MAP 段落不出现 |
| T14 | BuildUserPrompt_ZeroPrdSessions_ShouldNotOutputPrdSessionsLine | 零值指标的数据行（`- PRD 对话会话`）不出现 |
| T15 | BuildUserPrompt_PromptInstruction_ShouldForbidFabrication | 新提示词包含「严格约束」「禁止凭空编造」「禁止凑整、放大、捏造修饰语」 |
| T16 | BuildUserPromptV2_AllZeroSystemStats_ShouldNotIncludeSystemStatsSection | V2 路径同样修复 |
| T17 | BuildUserPromptV2_OnlyDocumentEditCount_ShouldUseNewLabel | V2 路径使用新标签「创建 PRD 项目: 2 个」 |

### 4.3 运行结果

```bash
$ dotnet test --filter "FullyQualifiedName~MapActivityCollectorTests|FullyQualifiedName~ReportGenerationServiceBuildPromptTests"
Passed!  - Failed: 0, Passed: 19, Skipped: 0, Total: 19

$ dotnet test --filter "FullyQualifiedName~Report|FullyQualifiedName~MapActivity"
Passed!  - Failed: 0, Passed: 51, Skipped: 0, Total: 51

$ dotnet test --filter "Category!=Integration"
Passed!  - Failed: 0, Passed: 640, Skipped: 4, Total: 644
```

**全量单元测试 0 失败 0 回归。**

---

## 5. 验收标准

功能声称"完成"前必须全部满足：

### 5.1 代码层（已验证 ✅）

- [x] `dotnet build PrdAgent.sln` 输出 `0 Error(s)`
- [x] `MapActivityCollectorTests` 全部 11 个用例通过
- [x] `ReportGenerationServiceBuildPromptTests` 全部 8 个用例通过
- [x] 全量单元测试 640 个通过，0 回归

### 5.2 数据层（部署后需人工验证）

- [ ] **新建测试用户**（无任何历史活动），添加到某团队
- [ ] 等待或手动触发 AI 生成草稿
- [ ] 断言生成的草稿中 **不包含以下任何内容**：
  - [ ] 任何带具体数字的「文档编辑/创建 N 篇」
  - [ ] 任何「调用 AI 辅助功能 N 次」
  - [ ] 任何「发布 N 个重要网页」
  - [ ] 任何「量较大」「较多」「若干」等修饰语
- [ ] 断言 `llmrequestlogs` 集合中该用户的 `report-agent.*` 日志 **不被计入** 下一次生成的 `activity.LlmCalls`

### 5.3 端到端验证（部署后）

- [ ] 通过预览地址打开周报 Agent 页面
- [ ] 以「新用户」身份进入自己的周报
- [ ] 点击「AI 重新生成草稿」
- [ ] 确认生成内容 **严格对应** 该用户真实的 DailyLogs + MAP 行为指标
- [ ] 若无任何活动，生成内容应该是空 items 或仅基于每日打点的简短条目

### 5.4 回归保护

- [ ] 新增的 `MapActivityCollectorTests.cs` + `ReportGenerationServiceBuildPromptTests.cs` 进入 CI
- [ ] 未来修改 `MapActivityCollector` 或 `BuildUserPrompt` 时必须先跑这两个文件的测试

---

## 6. 数据流审计结果

为保证没有其他类似遗漏，对全部 14 个数据流逐一审计：

| # | 数据流 | 用户过滤字段 | 状态 |
|---|---|---|---|
| 1 | Sessions | `OwnerUserId == userId` | ✅ 正确 |
| 2 | DefectReports | `ReporterId == userId` | ✅ 正确 |
| 3 | ImageMasterSessions | `OwnerUserId == userId` | ✅ 正确 |
| **4** | **LlmRequestLogs** | `UserId == userId` + 排除 `report-agent.*` | **✅ 本次修复** |
| 5 | ReportDailyLogs | `UserId == userId` | ✅ 正确 |
| 6 | ReportCommits | `MappedUserId == userId` | ✅ 正确 |
| 7 | Messages | `SenderId == userId`（bot 消息用 bot 自己的 UserId，不会误伤） | ✅ 正确 |
| 8 | ImageGenRuns | `OwnerAdminId == userId` | ✅ 正确 |
| 9 | VideoGenRuns | `OwnerAdminId == userId` | ✅ 正确 |
| **10** | **Groups**（原 Documents） | `OwnerId == userId` | **✅ 前次 `ab795b3` 已修复** |
| 11 | WorkflowExecutions | `TriggeredBy == userId` | ✅ 正确 |
| 12 | ToolboxRuns | `UserId == userId` | ✅ 正确 |
| 13 | HostedSites | `OwnerUserId == userId` | ✅ 正确 |
| 14 | Attachments | `UploaderId == userId` | ✅ 正确 |

---

## 7. 遗留风险

1. **CDS 部署时延**：本次修复必须推送到 `gTI0J` 分支后等待 CDS 自动部署。在部署完成前，旧代码仍会运行。
2. **其他 Agent 也可能自噬**：`TeamSummaryService` 同样会在被汇总用户名下写入 LlmRequestLogs。本次已通过 `report-agent.*` 前缀统一覆盖。若未来新增其他代用户调用的 AppCallerCode，必须同步更新 `ShouldCountLlmLog` 的排除列表或改为白名单机制。
3. **AI 仍可能违反约束**：提示词约束是软性的，强模型偶尔会违反。长期应考虑在后处理阶段做数值一致性校验（从生成结果回扫提示词中的数字，不匹配则退回规则兜底）。
