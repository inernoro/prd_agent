---
name: ai-defect-resolve
description: AI 辅助缺陷修复技能。用于缺陷自动化日常任务：通过 MAP/PrdAgent domain 和长期 AgentApiKey 拉取下一条缺陷，按单个缺陷逐个评论、轻量修复、提交 commit、回写提交信息，并在必要时兼容缺陷分享 agentLaunch。触发词："修复缺陷"、"解决缺陷"、"缺陷自动修复"、"ai-defect-resolve"。
---

# AI 辅助缺陷修复

本技能的主目标是自动化闭环，不是让人在发布中心手动关联缺陷。

## 版本与优先级

- 当前版本：`1.2.0`
- 如果 `agentLaunch.skill.minVersion` 高于当前版本，停止执行并提示升级技能。
- 项目内置优先：当前仓库内置的 `.claude/skills/ai-defect-resolve/SKILL.md` 优先级最高；不得用托管技能、市场技能或官方下载兜底包覆盖本项目内置技能。

## 主输入

日常任务优先使用 `domain + K`：

1. `domain`：缺陷系统访问域名，例如 `https://map.example.com`。
2. `K`：长期 AgentApiKey，推荐名称为“缺陷处理 Agent 授权”。
3. `scope`：K 必须包含 `defect-agent:use`。

缺少 domain 或 K 时停止，不要猜测环境变量、历史密钥或默认主站。

兼容输入：

- 如果用户提供 `agentLaunch` 且 `scope.type == daily-next`，按其中的 `domain/auth/scope.nextUrl` 执行。
- 如果用户提供旧分享包且仅有 `scope.shareUrl`，走“分享兼容流程”，但不要把它当成日常任务主路径。

## 自动化主流程

每一轮只处理一个缺陷：

1. 拉取下一条缺陷。
2. 发表评论说明计划。
3. 判断是否轻量修复。
4. 轻量修复则改代码、验证、commit；非轻量则评论阻塞原因并停止该缺陷。
5. 回写 commit 信息到缺陷系统。
6. 评论验收方式。
7. 标记缺陷已修复。
8. 再拉下一条，重复以上步骤。

### 1. 拉取下一条缺陷

```http
GET {domain}/api/defect-agent/agent/next
Authorization: Bearer {K}
```

可选 query：

- `projectId`
- `teamId`
- `status=submitted,assigned,processing`

当响应 `data.defect == null` 时，本轮结束。

### 2. 发表评论

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/comments
Authorization: Bearer {K}
Content-Type: application/json

{
  "agentName": "Codex",
  "content": "修复计划..."
}
```

评论至少出现三次：

- 开始修复前：说明理解、计划、风险。
- 遇到阻塞时：说明阻塞点和需要人类确认的事项。
- 修复完成后：说明 commit、预览地址、验收步骤。

### 3. 轻量修复判定

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

### 4. 修复与提交

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

### 5. 回写提交信息

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/commit-info
Authorization: Bearer {K}
Content-Type: application/json

{
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

### 6. 标记修复

```http
POST {domain}/api/defect-agent/agent/defects/{defectId}/fix-status
Authorization: Bearer {K}
Content-Type: application/json

{
  "agentName": "Codex",
  "resolution": "修复说明和验收方式"
}
```

正式发布后的用户通知不要在这里提前发送；发布到正式环境并完成视觉验收后，再由发布验收链路通知提交人。

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
