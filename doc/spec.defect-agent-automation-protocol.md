# 缺陷自动化协议 · 规格

> **版本**：v1.1 | **日期**：2026-06-22 | **状态**：开发中

## 目标

缺陷自动化协议把“每日任务如何领取缺陷、记录运行、回写 commit、进入发布后验收”定义成稳定契约，让不同智能体、缺陷系统和工作流引擎可以复用同一套闭环。

核心原则：

- 机械编排下沉到协议和后端代码。
- 智能体只负责理解、判断、修复、验证和提交。
- 一次只处理一个缺陷，提交并回写 commit 后再继续下一条。
- 更新中心只按 commit id 展示关联缺陷，不按 changelog 文案或日期关联。
- 正式发布前不通知提交人，正式发布并视觉验收后再通知。

## 参与方

| 参与方 | 职责 |
|--------|------|
| 缺陷系统 | 提供缺陷、评论、运行记录、commit 回写、发布后验收通知接口 |
| 工作流端点 | 维护 run 状态、领取单缺陷、完成回写、阻塞记录 |
| 智能体 | 分析缺陷、判断轻重、修改代码、自测、提交 commit |
| 更新中心 | 读取 `defect_resolution_traces`，在 commit 记录上展示关联缺陷 |
| 验收技能 | 正式发布后执行视觉验收并归档到知识库 |

## 授权

长期任务使用 `domain + K`：

| 字段 | 说明 |
|------|------|
| `domain` | 缺陷系统访问域名 |
| `K` | AgentApiKey 明文，仅由定时任务保存 |
| `scope` | 必须包含 `defect-agent:use` |
| `keyName` | 推荐固定为“缺陷处理 Agent 授权” |

后端不保存 K 明文。明文丢失时，由缺陷页面“缺陷自动化”按钮重新生成。

## 连接器协议

```http
GET {domain}/api/defect-agent/agent/connector
Authorization: Bearer {K}
```

响应必须包含：

| 字段 | 说明 |
|------|------|
| `type` | `map-defect-agent` |
| `auth.requiredScope` | `defect-agent:use` |
| `workflow.version` | `defect-agent-workflow.v1` |
| `workflow.startNext` | 创建或复用 run，并领取下一条缺陷 |
| `workflow.complete` | 完成单缺陷回写 |
| `workflow.block` | 记录阻塞或重量级原因 |
| `policy.lightweight` | 轻量修复判定标准 |
| `acceptance.storeName` | `缺陷修复验收报告` |

## 工作流协议 v1

### 0. 启动前安全自检

如果仓库包含 `scripts/defect-automation-probe.mjs`，每日任务启动前先运行：

```bash
DEFECT_AGENT_DOMAIN="https://map.ebcone.net" DEFECT_AGENT_KEY="<K>" node scripts/defect-automation-probe.mjs --safe
```

安全自检只调用 `connector` 与 `published-pending`，不会领取缺陷。它必须证明：

| 检查项 | 期望 |
|--------|------|
| connector | HTTP 200 |
| `auth.requiredScope` | `defect-agent:use` |
| `workflow.version` | `defect-agent-workflow.v1` |
| `published-pending` | 可访问，返回待验收数量 |

自检失败时停止本轮，不调用 `start-next`，避免授权或协议错误时误改缺陷状态。

### 1. start-next

```http
POST {domain}/api/defect-agent/agent/workflow/start-next
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "可选；为空则创建新 run",
  "triggerType": "schedule",
  "defectId": "可选；精确领取某个缺陷 ID 或缺陷编号，主要用于演练和回归",
  "projectId": "可选",
  "teamId": "可选",
  "status": "submitted,assigned,processing"
}
```

语义：

- 没有 `runId` 时创建 `DefectAutomationRun`。
- 有 `runId` 时复用该 run。
- 每次只领取一条未在当前 run 中完成或失败的缺陷。
- 有 `defectId` 时只领取该缺陷；该字段用于精确演练、回归或人工确认后的单点处理，日常任务默认不传。
- 没有下一条时，将 run 标记为 `completed`。

关键响应：

| 字段 | 说明 |
|------|------|
| `protocol.version` | `defect-agent-workflow.v1` |
| `run.id` | 当前运行记录 |
| `defect` | 当前要处理的缺陷，可能为空 |
| `hasNext` | 是否领取到缺陷 |
| `agentTask` | 给智能体的结构化任务包 |

### 2. comment

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/comments
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "agentName": "Codex",
  "content": "修复计划、轻量判定或验收说明"
}
```

评论仍独立保留，因为内容属于智能体判断与表达，不适合完全由后端生成。

### 3. complete

```http
POST {domain}/api/defect-agent/agent/workflow/complete
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "defectId": "{defectId}",
  "agentName": "Codex",
  "commitSha": "完整 commit id",
  "shortSha": "短 commit id",
  "commitMessage": "中文提交标题",
  "repository": "owner/repo 或仓库名",
  "branch": "当前分支",
  "commitUrl": "commit 地址",
  "previewUrl": "预览地址",
  "visualReportUrl": "预览验收报告地址，可选",
  "resolution": "修复说明",
  "completionComment": "修复完成评论，可选"
}
```

服务端必须完成：

- 写入缺陷结构化字段 `提交信息` 和 `修复提交`。
- upsert `defect_resolution_traces`。
- 标记缺陷为已解决。
- 更新 run item 为 `fixed`。
- 返回下一次 `workflow/start-next` 的调用提示。

### 4. block

```http
POST {domain}/api/defect-agent/agent/workflow/block
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "defectId": "{defectId}",
  "failurePhase": "analysis|fix|test|commit|callback",
  "failureReason": "阻塞原因和下一步建议",
  "comment": "写入缺陷评论的说明",
  "stopRun": true
}
```

语义：

- 默认 `stopRun=true`，重量级缺陷停止本轮运行等待人类确认。
- 如果显式 `stopRun=false`，允许工作流继续领取下一条。
- 该端点必须写入 run item 的失败原因。
- 已阻塞缺陷会切到 `awaiting`，从默认 `submitted,assigned,processing` 自动领取队列移出，避免日常任务反复领取同一条缺陷。

## 状态机

### Run 状态

| 状态 | 含义 |
|------|------|
| `running` | 本轮仍可领取或处理缺陷 |
| `completed` | 没有下一条缺陷 |
| `failed` | 本轮因阻塞或失败停止 |
| `cancelled` | 人工取消 |

### Run item 状态

| 状态 | 含义 |
|------|------|
| `fetched` | 已领取 |
| `commented` | 已评论计划或进度 |
| `commit_written` | 已回写 commit |
| `fixed` | 已标记修复 |
| `failed` | 已记录失败或阻塞 |

## 发布后验收协议

正式发布后，系统把对应 trace 标记为：

- `publishStatus=published`
- `notifyStatus=pending`

智能体或工作流随后调用：

```http
GET {domain}/api/defect-agent/agent/published-pending?limit=20
Authorization: Bearer {K}
```

对每条记录：

1. 使用 `create-visual-test-to-kb` 跑正式环境验收。
2. 报告归档到“缺陷修复验收报告”知识库。
3. 调用 `validation-report` 回写报告地址和结论。
4. 由服务端通知提交人。

正式发布前不得通知提交人“已修复”。

## 更新中心关联规则

`workflow/complete` 写入的 `defect_resolution_traces` 是更新中心关联缺陷的唯一数据来源。

| 规则 | 说明 |
|------|------|
| 关联键 | `commitSha` |
| 展示位置 | GitHub commit 记录行 |
| 普通 changelog 文案行 | 不展示关联缺陷 |
| 日期批量关联 | 禁止 |
| 提交人本人 | 可显示为“我的缺陷 N” |

## 幂等与重试

| 动作 | 幂等规则 |
|------|----------|
| `start-next` | 同一 run 不再领取已 `fixed` 或 `failed` 的缺陷 |
| `complete` | 同一 `defectId + commitSha` upsert trace |
| `block` | 同一 run item 可覆盖失败原因，默认停止运行 |
| `validation-report` | 同一 trace 重复提交时覆盖验收字段，不重复通知已发送用户 |

## 兼容端点

以下端点保留给旧技能、调试和精细排障：

- `POST /api/defect-agent/agent/runs`
- `GET /api/defect-agent/agent/next`
- `POST /api/defect-agent/agent/defects/{id}/comments`
- `POST /api/defect-agent/agent/defects/{id}/commit-info`
- `POST /api/defect-agent/agent/defects/{id}/fix-status`
- `POST /api/defect-agent/agent/runs/{runId}/fail`

日常自动化应优先使用 `defect-agent-workflow.v1`。

## 每日任务提示词要求

缺陷自动化面板复制出的每日计划必须包含：

- `domain`、`K`、`scope`、`status`。
- 启动前安全自检命令。
- 一次只处理一个缺陷的规则。
- 轻量修复与重量级阻塞边界。
- `workflow/complete` 回写 commit/PR/trace 的要求。
- 正式发布后才运行视觉验收、归档“缺陷修复验收报告”、调用 `validation-report` 通知提交人的要求。
- 无缺陷、无待验收通知项时的正常结束规则。
- 每日输出字段：runId、defectNo、commit、PR、预览地址、验收报告、通知结果、阻塞项。
