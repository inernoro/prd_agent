---
name: ai-defect-resolve
description: AI 辅助缺陷修复技能。用于缺陷自动化日常任务：通过 MAP/PrdAgent domain 和长期 AgentApiKey 使用缺陷工作流协议领取单个缺陷，完成轻量修复、提交 commit、回写提交信息，并在必要时兼容缺陷分享 agentLaunch。触发词："修复缺陷"、"解决缺陷"、"缺陷自动修复"、"ai-defect-resolve"。
---

# AI 辅助缺陷修复

本技能的主目标是自动化闭环，不是让人在更新中心手动关联缺陷。

## 版本与优先级

- 当前版本：`1.6.0`
- 如果 `agentLaunch.skill.minVersion` 高于当前版本，停止执行并提示升级技能。
- 项目内置优先：当前仓库内置的 `.claude/skills/ai-defect-resolve/SKILL.md` 优先级最高；不得用托管技能、市场技能或官方下载兜底包覆盖本项目内置技能。

## 主输入

日常任务优先使用正式缺陷页面“缺陷自动化”按钮复制出的 `domain + K`：

1. `domain`：缺陷系统访问域名，例如 `https://map.ebcone.net`。正式闭环必须使用正式环境 domain；测试环境只允许演练协议，不允许当成正式缺陷处理结果。
2. `K`：长期 AgentApiKey，推荐名称为“缺陷处理 Agent 授权”。
3. `scope`：K 必须包含 `defect-agent:use`。

日常执行缺少 domain 或 K 时停止，不要猜测环境变量、历史密钥或默认主站。

首次 setup 推荐在缺陷页面点击“缺陷自动化”按钮，再点击“生成并复制每日任务配置”。这会生成名为“缺陷处理 Agent 授权”的长期 K，并把每日计划内容复制到剪贴板。

接口 setup 允许只提供 domain，但必须处于用户登录态或由用户在主站页面发起：

```http
POST {domain}/api/defect-agent/agent/authorization/ensure
Content-Type: application/json

{
  "forceNew": false
}
```

如果已有名为“缺陷处理 Agent 授权”且包含 `defect-agent:use` scope 的可用 Key，接口返回 `created=false` 和 Key 元信息；如果没有则新建永不过期 K 并仅本次返回明文 `apiKey`。后端不保存明文 K，定时任务必须保存这次返回的 K。明文丢失时，重新点击按钮生成新 K。

兼容输入：

- 如果用户提供 `agentLaunch` 且 `scope.type == daily-next`，按其中的 `domain/auth/scope.nextUrl` 执行。
- 如果用户提供旧分享包且仅有 `scope.shareUrl`，走“分享兼容流程”，但不要把它当成日常任务主路径。

## 自动化主流程

完成标准不是“生成计划”，而是至少有一条真实缺陷完成可审计闭环。日常任务执行时必须先跑线上接口，不能停在流程复述或提示词整理。

优先使用缺陷工作流协议 `defect-agent-workflow.v1`。固定编排由后端工作流端点完成，智能体只负责理解缺陷、评论计划、判断轻量、修代码、验证和提交。

1. 读取连接器协议。
2. 调用 `workflow/start-next` 创建或复用运行记录，并领取一条缺陷。
3. 发表评论说明计划。
4. 判断是否轻量修复。
5. 轻量修复则改代码、验证、commit、创建 PR，然后调用 `workflow/complete` 一次性回写 PR、commit、写入 `defect_resolution_traces`、标记缺陷已修复。
6. 非轻量或无法自测时调用 `workflow/block`，写入阻塞原因并默认停止本轮运行。
7. `workflow/complete` 返回下一次 `workflow/start-next` 入参后，继续下一条或结束。

旧端点 `runs`、`next`、`comments`、`commit-info`、`fix-status` 只用于兼容和排障；日常自动化不要优先使用旧端点拆步骤。

### 0. 真实闭环验收门禁

任何声称“缺陷自动化可用”的交付，必须拿到以下证据。缺一项只能说“未完成”，不能让用户代为校验：

1. `GET /agent/connector` 返回 200，证明 `domain + K` 可用。
2. `POST /agent/workflow/start-next` 返回 `runId` 和具体缺陷，证明运行记录和领取缺陷都由工作流完成。
3. 领取响应包含 `protocol.version == defect-agent-workflow.v1`。
4. `POST /agent/defects/{id}/comments` 返回 `messageId`，证明已评论开始分析和轻量判定。
5. 代码或技能实际产生 diff，并通过对应校验。
6. git commit 成功，取得完整 `commitSha`，并创建或更新 PR，取得 `pullRequestUrl`。
7. `POST /agent/workflow/complete` 返回成功，证明 PR、commit 已写回缺陷系统，且单缺陷已标记修复。
8. `workflow/complete` 返回下一次 `workflow/start-next` 入参，证明流程能继续下一条。
9. 阻塞或重量级缺陷必须调用 `POST /agent/workflow/block` 并写入失败原因。
10. 更新中心的 commit 记录必须在 UI 上出现可点击的“关联缺陷 N”或“我的缺陷 N”标志，点击后能看到缺陷编号、标题、PR、commit、发布状态、验收报告或知识库链接；只验证接口 `linkedDefects` 不算完成。普通 changelog 文案行没有 commit id，不允许按日期批量贴缺陷标志。如果 commit 未正式发布，只能记录“需要真人审核发布”，不能冒充已发布。
11. 正式发布后才能跑 `create-visual-test-to-kb`，报告必须进入“缺陷修复验收报告”知识库。
12. 只有正式发布且验收通过后，才能调用 `validation-report` 通知提交人。

执行者必须维护一份本轮证据摘要，至少记录 `domain`、`environment`、`runId`、`defectNo`、`defectId`、`messageId`、`commitSha`、`pullRequestUrl`、`commitInfoResult`、`fixStatusResult`、`nextResult`、`previewUrl`、`visualReportUrl`、更新中心 UI 截图路径和点击弹窗截图路径。摘要不能包含 K 明文。

### 1. 读取连接器协议

```http
GET {domain}/api/defect-agent/agent/connector
Authorization: Bearer {K}
```

响应会返回：

- 当前连接器类型：`map-defect-agent`
- 当前 K 的 `keyId/name/expiresAt`，如果请求来自 AgentApiKey。
- 长期授权创建建议：优先使用缺陷页面“缺陷自动化”按钮；接口兜底调用 `/api/defect-agent/agent/authorization/ensure`；兼容手动创建 `/api/agent-api-keys`，名称“缺陷处理 Agent 授权”，scope `defect-agent:use`。
- 自动化端点清单。

后端不保存明文 K。没有可用 K 时，必须先完成 setup 并保存明文；日常任务后续只需要 `domain + K`。

### 2. 领取单个缺陷

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

响应中的 `data.run.id` 是本轮运行记录，`data.defect` 是当前唯一要处理的缺陷。当 `data.hasNext == false` 或 `data.defect == null` 时，本轮结束。

日常任务默认不传 `defectId`，让系统按项目、团队和状态自动领取。演练、回归或人工确认后的单点处理必须传 `defectId`，避免误领其它存量缺陷。

### 3. 发表评论

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
- 修复完成后：说明 PR、commit、预览地址、验收步骤；正式环境验收报告生成后必须再评论报告地址和知识库地址。

### 4. 轻量修复判定

参考 `issues-autofix` 的轻量标准：

- 预计改动不超过 200 行。
- 单个缺陷预计 10 分钟内能定位并完成主要修复。
- 根因清晰，行为可验证。
- 不涉及破坏性删除、数据库迁移、权限模型重写、跨服务协议改造。
- 能跑通本地测试、集成测试、CDS 预览或浏览器验收中的至少一条。

不满足轻量标准时：

1. 不提交半成品。
2. 评论说明原因、风险、建议拆分方式。
3. 调用 `workflow/block` 停止当前缺陷。后端会把缺陷切到 `awaiting`，让它退出默认自动领取队列，等待用户确认或后续任务接管。

### 5. 修复与提交

修复代码后按仓库规则执行校验并提交 commit。commit message 使用中文。

提交完成后必须取得：

- `commitSha`
- `shortSha`
- `commitMessage`
- `repository`
- `branch`
- `pullRequestNumber`，如果可用
- `pullRequestUrl`
- `commitUrl`，如果可用
- `previewUrl`，如果已部署预览
- `visualReportUrl`，如果已完成视觉验收

所有代码改动必须通过 PR 完成。缺陷自动化可以提交分支和创建 PR，但不能把“有 commit”当成完成；`workflow/complete` 必须尽量带上 `pullRequestUrl`。如果仓库权限导致无法创建 PR，先评论阻塞并调用 `workflow/block`，不要把缺陷标记为已解决。

### 6. 完成工作流

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
  "pullRequestNumber": 861,
  "pullRequestUrl": "PR 地址",
  "commitUrl": "commit 地址",
  "previewUrl": "预览地址",
  "visualReportUrl": "视觉验收报告地址",
  "resolution": "修复说明",
  "completionComment": "修复完成评论，可选"
}
```

该接口会同时写入：

- 缺陷结构化字段 `提交信息`
- 缺陷结构化字段 `修复提交`
- 缺陷结构化字段 `修复PR地址`
- 更新中心关联用的 `defect_resolution_traces`
- 缺陷状态 `已解决`
- 缺陷评论：自动包含 PR、commit、验收地址和“正式发布后生成验收报告”的说明

因此更新中心不需要人工点“关联缺陷”。它只需要读取 commit id 关联结果。

正式发布后的用户通知不要在这里提前发送；发布到正式环境并完成视觉验收后，再由发布验收链路通知提交人。

### 7. 阻塞当前缺陷

无法轻量修复、验证失败、提交失败或回写失败时，调用：

```http
POST {domain}/api/defect-agent/agent/workflow/block
Authorization: Bearer {K}
Content-Type: application/json

{
  "runId": "{runId}",
  "defectId": "{defectId}",
  "failurePhase": "analysis|fix|test|commit|callback",
  "failureReason": "失败原因和下一步建议",
  "comment": "写给缺陷提交者或维护者的阻塞说明",
  "stopRun": true
}
```

重量级缺陷默认停止，让用户确认。只有明确要求继续时，才允许 `stopRun=false`。

`workflow/block` 会把缺陷状态切到 `awaiting`。日常任务默认状态过滤是 `submitted,assigned,processing`，因此被阻塞缺陷不会在下一轮自动反复领取；需要人工补充或重新提交后再进入自动化队列。

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
3. 用验收技能归档报告；如果知识库不存在，归档脚本按 find-or-create 逻辑创建。归档必须走知识库传输共享协议：正文和截图 `assets[]` 一次性提交给知识库后端，由知识库决定正式图片域名和缓存刷新。禁止直接写 Mongo、禁止手动上传图片后拼 URL、禁止把 `data:image` 写进报告。
4. 视觉验收必须进入更新中心的 commit 记录列表，截取对应 commit 行上的“关联缺陷 N”或“我的缺陷 N”按钮；必须点击按钮并截取弹窗，证明缺陷编号、标题、发布状态、验收报告或知识库链接可见。提交者本人场景必须证明按钮显示“我的缺陷 N”或弹窗内出现“我提交的”。普通 changelog 文案行不作为缺陷关联验收目标。
5. 归档后必须用验收技能的 `verify-open.mjs` 打开报告地址，确认标题、正文和截图可见。
6. 回写验收报告并通知提交人。验收失败时不要发送“已修复”，要发送“需要继续改进”。如果正式验收报告证明用户描述不成立，`verdict` 使用 `invalid`，回复必须引用验收报告证明该结论。

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

该接口会更新 trace 的验收状态、验收报告字段和通知状态，并给缺陷提交人发送通知，同时在缺陷评论里写入知识库、验收报告、commit 和 PR 证据链。正式发布前不要调用。

`verdict` 可取值：

- `pass`：正式环境验收通过。
- `conditional`：有条件通过，必须在报告和消息中说明限制。
- `fail`：正式环境验收未通过，需要继续改进。
- `invalid`：验收报告证明用户提交的缺陷陈述不成立，用于有证据地回复用户。

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
4. 不跳过回写：只 commit 不调用 `workflow/complete` 不算闭环完成；旧 `commit-info` 只用于兼容和排障。
5. 不提前通知用户：正式发布前只在缺陷内更新进度，不给提交人发“已修复”通知。
6. 不把“已创建 PR”当作完成：必须等 commit 被正式发布后，才进入视觉验收和提交人通知。
7. 不处理无关缺陷：验收或演练时先创建独立项目，运行记录带 `projectId` 过滤，避免领取线上其它人的存量缺陷。
8. 不混淆环境：测试环境数据库和正式环境数据库不同。测试环境通过只能证明协议可用，不能证明正式缺陷已修复。
