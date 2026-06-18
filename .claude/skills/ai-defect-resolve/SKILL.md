---
name: ai-defect-resolve
description: AI 辅助缺陷修复技能。用于缺陷自动化日常任务：通过 MAP/PrdAgent domain 和长期 AgentApiKey 拉取下一条缺陷，按单个缺陷逐个评论、轻量修复、提交 commit、回写提交信息，并在必要时兼容缺陷分享 agentLaunch。触发词："修复缺陷"、"解决缺陷"、"缺陷自动修复"、"ai-defect-resolve"。
---

# AI 辅助缺陷修复

本技能的主目标是自动化闭环，不是让人在发布中心手动关联缺陷。

## 版本与优先级

- 当前版本：`1.3.0`
- 如果 `agentLaunch.skill.minVersion` 高于当前版本，停止执行并提示升级技能。
- 项目内置优先：当前仓库内置的 `.claude/skills/ai-defect-resolve/SKILL.md` 优先级最高；不得用托管技能、市场技能或官方下载兜底包覆盖本项目内置技能。

## 主输入

日常任务优先使用 `domain + K`：

1. `domain`：缺陷系统访问域名，例如 `https://map.example.com`。
2. `K`：长期 AgentApiKey，推荐名称为“缺陷处理 Agent 授权”。
3. `scope`：K 必须包含 `defect-agent:use`。

日常执行缺少 domain 或 K 时停止，不要猜测环境变量、历史密钥或默认主站。

首次 setup 允许只提供 domain，但必须处于用户登录态或由用户在主站页面发起：

```http
POST {domain}/api/defect-agent/agent/authorization/ensure
Content-Type: application/json

{
  "ttlDays": 1095,
  "forceNew": false
}
```

如果已有名为“缺陷处理 Agent 授权”且包含 `defect-agent:use` scope 的可用 Key，接口返回 `created=false` 和 Key 元信息；如果没有则新建并仅本次返回明文 `apiKey`。后端不保存明文 K，定时任务必须保存这次返回的 K。

兼容输入：

- 如果用户提供 `agentLaunch` 且 `scope.type == daily-next`，按其中的 `domain/auth/scope.nextUrl` 执行。
- 如果用户提供旧分享包且仅有 `scope.shareUrl`，走“分享兼容流程”，但不要把它当成日常任务主路径。

## 自动化主流程

每一轮只处理一个缺陷：

1. 读取连接器协议。
2. 创建运行记录，拿到 `runId`。
3. 带 `runId` 拉取下一条缺陷。
4. 发表评论说明计划。
5. 判断是否轻量修复。
6. 轻量修复则改代码、验证、commit；非轻量则评论阻塞原因并写入 run 失败项。
7. 回写 commit 信息到缺陷系统。
8. 评论验收方式。
9. 标记缺陷已修复。
10. 再拉下一条，重复以上步骤。

### 1. 读取连接器协议

```http
GET {domain}/api/defect-agent/agent/connector
Authorization: Bearer {K}
```

响应会返回：

- 当前连接器类型：`map-defect-agent`
- 当前 K 的 `keyId/name/expiresAt`，如果请求来自 AgentApiKey。
- 长期授权创建建议：优先调用 `/api/defect-agent/agent/authorization/ensure`；兼容手动创建 `/api/agent-api-keys`，名称“缺陷处理 Agent 授权”，scope `defect-agent:use`。
- 自动化端点清单。

后端不保存明文 K。没有可用 K 时，必须先完成 setup 并保存明文；日常任务后续只需要 `domain + K`。

### 2. 创建运行记录

```http
POST {domain}/api/defect-agent/agent/runs
Authorization: Bearer {K}
Content-Type: application/json

{
  "triggerType": "schedule",
  "projectId": "可选",
  "teamId": "可选",
  "status": "submitted,assigned,processing"
}
```

保存返回的 `data.run.id`，后续每个请求都带上 `runId`。运行记录用于恢复：

- 当前处理到哪个缺陷
- 单缺陷状态
- commit 信息
- 失败原因
- 本轮成功/失败数量

### 3. 拉取下一条缺陷

```http
GET {domain}/api/defect-agent/agent/next?runId={runId}
Authorization: Bearer {K}
```

可选 query：

- `projectId`
- `teamId`
- `status=submitted,assigned,processing`

当响应 `data.defect == null` 时，本轮结束。

### 4. 发表评论

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/comments
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "agentName": "Codex",
  "content": "修复计划..."
}
```

评论至少出现三次：

- 开始修复前：说明理解、计划、风险。
- 遇到阻塞时：说明阻塞点和需要人类确认的事项。
- 修复完成后：说明 commit、预览地址、验收步骤。

### 5. 轻量修复判定

参考 `issues-autofix` 的轻量标准：

- 预计改动不超过 200 行。
- 单个缺陷预计 10 分钟内能定位并完成主要修复。
- 根因清晰，行为可验证。
- 不涉及破坏性删除、数据库迁移、权限模型重写、跨服务协议改造。
- 能跑通本地测试、集成测试、CDS 预览或浏览器验收中的至少一条。

不满足轻量标准时：

1. 不提交半成品。
2. 评论说明原因、风险、建议拆分方式。
3. 停止当前缺陷，等待用户确认或后续任务接管。

### 6. 修复与提交

修复代码后按仓库规则执行校验并提交 commit。commit message 使用中文。

提交完成后必须取得：

- `commitSha`
- `shortSha`
- `commitMessage`
- `repository`
- `branch`
- `commitUrl`，如果可用
- `previewUrl`，如果已部署预览
- `visualReportUrl`，如果已完成视觉验收

### 7. 回写提交信息

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/commit-info
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "agentName": "Codex",
  "commitSha": "完整 commit id",
  "shortSha": "短 commit id",
  "commitMessage": "中文提交标题",
  "repository": "owner/repo 或仓库名",
  "branch": "当前分支",
  "commitUrl": "commit 地址",
  "previewUrl": "预览地址",
  "visualReportUrl": "视觉验收报告地址",
  "resolution": "修复说明"
}
```

该接口会同时写入：

- 缺陷结构化字段 `提交信息`
- 缺陷结构化字段 `修复提交`
- 更新中心关联用的 `defect_resolution_traces`

因此发布中心不需要人工点“关联缺陷”。它只需要读取 commit id 关联结果。

### 8. 标记修复

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/fix-status
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "agentName": "Codex",
  "resolution": "修复说明和验收方式"
}
```

正式发布后的用户通知不要在这里提前发送；发布到正式环境并完成视觉验收后，再由发布验收链路通知提交人。

### 9. 记录失败

无法轻量修复、验证失败、提交失败或回写失败时，调用：

```http
POST {domain}/api/defect-agent/agent/runs/{runId}/fail
Authorization: Bearer {K}
Content-Type: application/json

{
  "defectId": "{defectId}",
  "failurePhase": "analysis|fix|test|commit|callback",
  "failureReason": "失败原因和下一步建议"
}
```

写入失败后再决定是否继续下一条。重量级缺陷默认停止，让用户确认。

## 正式发布后的验收通知

修复 commit 被正式发布后，更新中心会把对应 `defect_resolution_traces` 标记为 `published` 且 `notifyStatus=pending`。这时再做验收和通知。

### 1. 拉取待验收通知项

```http
GET {domain}/api/defect-agent/agent/published-pending?limit=20
Authorization: Bearer {K}
```

对每个 item：

1. 使用 `create-visual-test-to-kb` 跑正式环境验收。目标优先取 `item.acceptance.target`，commit 取 `item.acceptance.commitSha`，预览地址取 `item.acceptance.previewUrl`。
2. 复制 `.claude/skills/create-visual-test-to-kb/acceptance.config.json` 到 `/tmp/defect-acceptance.config.json`，只在临时副本里把 `report.storeName` 改成“缺陷修复验收报告”。
3. 用验收技能归档报告；如果知识库不存在，归档脚本按 find-or-create 逻辑创建。
4. 归档后必须用验收技能的 `verify-open.mjs` 打开报告地址，确认标题、正文和截图可见。
5. 回写验收报告并通知提交人。验收失败时不要发送“已修复”，要发送“需要继续改进”。

建议归档参数：

- `--target`：`item.acceptance.target`
- `--module`：`缺陷管理`
- `--feature`：缺陷标题或缺陷编号
- `--type`：`修复`
- `--verdict`：`pass`、`conditional` 或 `fail`

### 2. 回写报告并通知提交人

```http
POST {domain}/api/defect-agent/agent/resolution-traces/{traceId}/validation-report
Authorization: Bearer {K}
Content-Type: application/json

{
  "visualReportId": "视觉验收报告 ID",
  "visualReportUrl": "视觉验收报告地址",
  "knowledgeBaseName": "缺陷修复验收报告",
  "knowledgeBaseDocId": "知识库文档 ID",
  "knowledgeBaseUrl": "知识库文档地址",
  "verdict": "pass",
  "message": "你的问题已修复，请查看验收报告。"
}
```

该接口会更新 trace 的验收状态、验收报告字段和通知状态，并给缺陷提交人发送通知。正式发布前不要调用。

`knowledgeBaseUrl` 必须填写为验收报告知识库可打开地址；缺少该地址时后端会拒绝发送通知，避免用户收到无法查收的消息。

## 分享兼容流程

旧分享包仍可用：

1. `GET {domain}{scope.shareUrl}` 读取缺陷。
2. `POST {scope.shareUrl}/comments` 评论计划。
3. `POST {scope.shareUrl}/report` 提交分析和 commit 信息。
4. `POST {scope.shareUrl}/fix-status` 标记修复。

优先使用 `agentLaunch` 提供的端点，不要自行拼错路径。

## 安全规则

1. 不泄露 K：不要把密钥写入日志、commit、评论、报告或截图。
2. 一次只修一个缺陷：提交并回写 commit 后再继续下一条。
3. 不确定就停：破坏性、重量级、跨系统变更必须评论并等待确认。
4. 不跳过回写：只 commit 不回写 `commit-info` 不算闭环完成。
5. 不提前通知用户：正式发布前只在缺陷内更新进度，不给提交人发“已修复”通知。
