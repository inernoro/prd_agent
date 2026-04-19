# MongoDB 索引 · 指南

> 本项目禁止应用启动时自动创建索引。所有索引由 DBA 在数据库中手动创建。
> 索引定义源码位置：`prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs` → `CreateIndexes()`

## 使用方式

连接到 MongoDB 后，在目标数据库中执行以下 JavaScript 命令。

---

## 索引列表

### users

```js
db.users.createIndex({ "Username": 1 })
```

### system_roles

```js
db.system_roles.createIndex({ "Key": 1 })
```

### groups

```js
db.groups.createIndex({ "InviteCode": 1 })
```

### documents

```js
db.documents.createIndex({ "CreatedAt": -1 })
```

### prdcomments

```js
db.prdcomments.createIndex({ "DocumentId": 1, "HeadingId": 1, "CreatedAt": -1 })
```

### groupmembers

```js
db.groupmembers.createIndex({ "GroupId": 1, "UserId": 1 })
```

### sessions

```js
// GroupId 唯一（单群单会话），仅对 GroupId 为字符串类型的文档生效
db.sessions.createIndex(
  { "GroupId": 1 },
  {
    name: "uniq_sessions_group",
    unique: true,
    partialFilterExpression: { "GroupId": { $type: "string" } }
  }
)

// 个人会话列表排序（ownerUserId + lastActiveAt desc）
db.sessions.createIndex(
  { "OwnerUserId": 1, "LastActiveAt": -1 },
  {
    name: "idx_sessions_owner_last_active",
    partialFilterExpression: { "OwnerUserId": { $type: "string" } }
  }
)
```

### messages

```js
db.messages.createIndex({ "GroupId": 1 })

db.messages.createIndex({ "SessionId": 1 })

// replyToMessageId：用于级联删除/一问多答关联
db.messages.createIndex(
  { "ReplyToMessageId": 1 },
  { name: "idx_messages_reply_to" }
)

// groupId + groupSeq：群消息顺序键（SSE 断线续传/严格有序）
db.messages.createIndex(
  { "GroupId": 1, "GroupSeq": 1 },
  {
    name: "uniq_messages_group_seq",
    partialFilterExpression: { "GroupSeq": { $type: "long" } }
  }
)

// 按 sessionId + 时间游标分页
db.messages.createIndex(
  { "SessionId": 1, "Timestamp": -1 },
  { name: "idx_messages_session_ts" }
)
```

### contentgaps

```js
db.contentgaps.createIndex({ "GroupId": 1 })
```

### invitecodes

```js
db.invitecodes.createIndex({ "Code": 1 })
```

### llmplatforms

```js
db.llmplatforms.createIndex({ "Name": 1 })
```

### llmmodels

```js
db.llmmodels.createIndex({ "ModelName": 1 })
db.llmmodels.createIndex({ "PlatformId": 1 })
db.llmmodels.createIndex({ "Priority": 1 })
```

### llmrequestlogs

```js
db.llmrequestlogs.createIndex({ "StartedAt": -1 })
db.llmrequestlogs.createIndex({ "RequestId": 1 })
db.llmrequestlogs.createIndex({ "GroupId": 1 })
db.llmrequestlogs.createIndex({ "SessionId": 1 })
db.llmrequestlogs.createIndex({ "Provider": 1, "Model": 1 })
db.llmrequestlogs.createIndex({ "EndedAt": 1 })
```

### apirequestlogs

```js
db.apirequestlogs.createIndex({ "StartedAt": -1 })
db.apirequestlogs.createIndex({ "RequestId": 1 })
db.apirequestlogs.createIndex({ "UserId": 1 })
db.apirequestlogs.createIndex({ "Path": 1 })
db.apirequestlogs.createIndex({ "StatusCode": 1 })
db.apirequestlogs.createIndex({ "ClientType": 1, "ClientId": 1 })
db.apirequestlogs.createIndex({ "EndedAt": 1 })
```

### model_lab_experiments

```js
db.model_lab_experiments.createIndex({ "OwnerAdminId": 1, "UpdatedAt": -1 })
db.model_lab_experiments.createIndex({ "CreatedAt": -1 })
```

### model_lab_runs

```js
db.model_lab_runs.createIndex({ "OwnerAdminId": 1, "StartedAt": -1 })
db.model_lab_runs.createIndex({ "ExperimentId": 1 })
```

### model_lab_run_items

```js
db.model_lab_run_items.createIndex({ "OwnerAdminId": 1, "RunId": 1 })
db.model_lab_run_items.createIndex({ "ModelId": 1 })
```

### model_lab_model_sets

```js
db.model_lab_model_sets.createIndex({ "OwnerAdminId": 1, "Name": 1 })
db.model_lab_model_sets.createIndex({ "OwnerAdminId": 1, "UpdatedAt": -1 })
```

### model_lab_groups

```js
db.model_lab_groups.createIndex({ "OwnerAdminId": 1, "Name": 1 })
db.model_lab_groups.createIndex({ "OwnerAdminId": 1, "UpdatedAt": -1 })
```

### image_master_sessions

```js
db.image_master_sessions.createIndex({ "OwnerUserId": 1, "UpdatedAt": -1 })
```

### image_master_messages

```js
db.image_master_messages.createIndex({ "SessionId": 1, "CreatedAt": 1 })
db.image_master_messages.createIndex({ "WorkspaceId": 1, "CreatedAt": 1 })
```

### image_assets

```js
db.image_assets.createIndex({ "OwnerUserId": 1, "CreatedAt": -1 })
db.image_assets.createIndex({ "WorkspaceId": 1, "CreatedAt": -1 })

// Workspace 内按 sha256 去重（仅对 workspaceId 为字符串的文档生效）
db.image_assets.createIndex(
  { "workspaceId": 1, "Sha256": 1 },
  {
    name: "uniq_image_assets_workspace_sha256",
    partialFilterExpression: { "workspaceId": { $type: "string" } }
  }
)
```

### image_master_canvases

```js
db.image_master_canvases.createIndex(
  { "OwnerUserId": 1, "SessionId": 1 },
  { name: "idx_image_master_canvases_owner_session" }
)

db.image_master_canvases.createIndex({ "OwnerUserId": 1, "UpdatedAt": -1 })

db.image_master_canvases.createIndex(
  { "WorkspaceId": 1 },
  { name: "idx_image_master_canvases_workspace" }
)
```

### image_master_workspaces

```js
db.image_master_workspaces.createIndex({ "OwnerUserId": 1, "UpdatedAt": -1 })
db.image_master_workspaces.createIndex({ "MemberUserIds": 1 })
```

### image_gen_size_caps

```js
// modelId 唯一（仅对存在 ModelId 字段的文档生效）
db.image_gen_size_caps.createIndex(
  { "ModelId": 1 },
  {
    name: "uniq_image_gen_size_caps_modelId",
    partialFilterExpression: { "ModelId": { $exists: true } }
  }
)

// platformId + modelName 唯一（仅对两个字段都存在的文档生效）
db.image_gen_size_caps.createIndex(
  { "PlatformId": 1, "ModelName": 1 },
  {
    name: "uniq_image_gen_size_caps_platformId_modelName",
    partialFilterExpression: {
      "PlatformId": { $exists: true },
      "ModelName": { $exists: true }
    }
  }
)
```

### image_gen_runs

```js
db.image_gen_runs.createIndex({ "OwnerAdminId": 1, "CreatedAt": -1 })
db.image_gen_runs.createIndex({ "Status": 1, "CreatedAt": 1 })

// 幂等键：同一 admin 下唯一（仅对 IdempotencyKey 为字符串的文档生效）
db.image_gen_runs.createIndex(
  { "OwnerAdminId": 1, "IdempotencyKey": 1 },
  {
    name: "uniq_image_gen_runs_owner_idem",
    partialFilterExpression: { "IdempotencyKey": { $type: "string" } }
  }
)
```

### image_gen_run_items

```js
db.image_gen_run_items.createIndex({ "OwnerAdminId": 1, "RunId": 1 })

db.image_gen_run_items.createIndex(
  { "RunId": 1, "ItemIndex": 1, "ImageIndex": 1 },
  { name: "uniq_image_gen_run_items_run_pos" }
)
```

### image_gen_run_events

```js
db.image_gen_run_events.createIndex({ "OwnerAdminId": 1, "RunId": 1 })

db.image_gen_run_events.createIndex(
  { "RunId": 1, "Seq": 1 },
  { name: "uniq_image_gen_run_events_run_seq" }
)
```

### upload_artifacts

```js
db.upload_artifacts.createIndex({ "RequestId": 1, "CreatedAt": -1 })
db.upload_artifacts.createIndex({ "RequestId": 1, "Kind": 1, "CreatedAt": -1 })
db.upload_artifacts.createIndex({ "Sha256": 1, "CreatedAt": -1 })
```

### admin_prompt_overrides

```js
// 同一管理员 + key 唯一
db.admin_prompt_overrides.createIndex(
  { "OwnerAdminId": 1, "Key": 1 },
  { name: "uniq_admin_prompt_overrides_owner_key" }
)
```

### admin_idempotency

```js
// 同一管理员 + scope + idemKey 唯一（仅对 idempotencyKey 为字符串的文档生效）
db.admin_idempotency.createIndex(
  { "OwnerAdminId": 1, "Scope": 1, "IdempotencyKey": 1 },
  {
    name: "uniq_admin_idempotency_owner_scope_key_v2",
    partialFilterExpression: { "idempotencyKey": { $type: "string" } }
  }
)

db.admin_idempotency.createIndex({ "CreatedAt": -1 })
```

### desktop_asset_skins

```js
db.desktop_asset_skins.createIndex(
  { "Name": 1 },
  { name: "idx_desktop_asset_skins_name" }
)

db.desktop_asset_skins.createIndex(
  { "Enabled": 1 },
  { name: "idx_desktop_asset_skins_enabled" }
)
```

### desktop_asset_keys

```js
db.desktop_asset_keys.createIndex(
  { "Key": 1 },
  { name: "idx_desktop_asset_keys_key" }
)
```

### desktop_assets

```js
// Key + Skin 唯一（仅对 Skin 为字符串的文档生效）
db.desktop_assets.createIndex(
  { "Key": 1, "Skin": 1 },
  {
    name: "uniq_desktop_assets_key_skin",
    partialFilterExpression: { "Skin": { $type: "string" } }
  }
)

// 按 Key 查询所有皮肤的资源
db.desktop_assets.createIndex(
  { "Key": 1 },
  { name: "idx_desktop_assets_key" }
)
```

### literary_prompts

```js
db.literary_prompts.createIndex({ "OwnerUserId": 1, "ScenarioType": 1, "Order": 1 })
db.literary_prompts.createIndex({ "ScenarioType": 1, "Order": 1 })
```

### openplatformapps

```js
db.openplatformapps.createIndex({ "ApiKeyHash": 1 })
db.openplatformapps.createIndex({ "BoundUserId": 1 })
db.openplatformapps.createIndex({ "CreatedAt": -1 })
```

### openplatformrequestlogs

```js
db.openplatformrequestlogs.createIndex({ "AppId": 1, "StartedAt": -1 })
db.openplatformrequestlogs.createIndex({ "AppId": 1, "StatusCode": 1 })
db.openplatformrequestlogs.createIndex({ "StartedAt": -1 })
db.openplatformrequestlogs.createIndex({ "EndedAt": 1 })
```

### model_groups

```js
db.model_groups.createIndex({ "ModelType": 1, "IsDefaultForType": -1 })
db.model_groups.createIndex({ "CreatedAt": -1 })
```

### llm_app_callers

```js
// 按 appCode 唯一
db.llm_app_callers.createIndex(
  { "AppCode": 1 },
  { name: "uniq_llm_app_callers_app_code" }
)

db.llm_app_callers.createIndex({ "LastCalledAt": -1 })
```

### watermark_font_assets

```js
// 同一用户 + fontKey 唯一
db.watermark_font_assets.createIndex(
  { "OwnerUserId": 1, "FontKey": 1 },
  { name: "uniq_watermark_font_owner_key", unique: true }
)
```

### watermark_configs

```js
db.watermark_configs.createIndex(
  { "UserId": 1, "UpdatedAt": -1 },
  { name: "idx_watermark_configs_user_updated" }
)

db.watermark_configs.createIndex(
  { "UserId": 1, "AppKeys": 1 },
  { name: "idx_watermark_configs_user_appkeys" }
)
```

### defect_templates

```js
db.defect_templates.createIndex(
  { "IsDefault": -1, "CreatedAt": -1 },
  { name: "idx_defect_templates_default" }
)
```

### defect_reports

```js
db.defect_reports.createIndex(
  { "ReporterId": 1, "Status": 1, "CreatedAt": -1 },
  { name: "idx_defect_reports_reporter_status" }
)

db.defect_reports.createIndex(
  { "AssigneeId": 1, "Status": 1, "CreatedAt": -1 },
  { name: "idx_defect_reports_assignee_status" }
)

db.defect_reports.createIndex(
  { "Status": 1, "CreatedAt": -1 },
  { name: "idx_defect_reports_status" }
)

// defectNo 唯一（仅对 DefectNo 为字符串的文档生效）
db.defect_reports.createIndex(
  { "DefectNo": 1 },
  {
    name: "uniq_defect_reports_no",
    unique: true,
    partialFilterExpression: { "DefectNo": { $type: "string" } }
  }
)

// 按 projectId + status 查询
db.defect_reports.createIndex(
  { "ProjectId": 1, "Status": 1, "CreatedAt": -1 },
  { name: "idx_defect_reports_project" }
)

// 按 teamId + status 查询
db.defect_reports.createIndex(
  { "TeamId": 1, "Status": 1, "CreatedAt": -1 },
  { name: "idx_defect_reports_team" }
)
```

### defect_messages

```js
db.defect_messages.createIndex(
  { "DefectId": 1, "Seq": 1 },
  { name: "idx_defect_messages_defect_seq" }
)
```

### defect_projects

```js
// 按 key 唯一
db.defect_projects.createIndex(
  { "Key": 1 },
  { name: "uniq_defect_projects_key", unique: true }
)

db.defect_projects.createIndex(
  { "OwnerUserId": 1 },
  { name: "idx_defect_projects_owner" }
)
```

### defect_webhook_configs

```js
db.defect_webhook_configs.createIndex(
  { "TeamId": 1, "ProjectId": 1 },
  { name: "idx_defect_webhooks_team_project" }
)
```

### defect_share_links

```js
db.defect_share_links.createIndex(
  { "Token": 1 },
  { name: "uniq_defect_share_links_token", unique: true }
)

db.defect_share_links.createIndex(
  { "CreatedBy": 1, "CreatedAt": -1 },
  { name: "idx_defect_share_links_creator" }
)
```

### defect_fix_reports

```js
db.defect_fix_reports.createIndex(
  { "ShareLinkId": 1, "CreatedAt": -1 },
  { name: "idx_defect_fix_reports_share" }
)

db.defect_fix_reports.createIndex(
  { "ShareToken": 1 },
  { name: "idx_defect_fix_reports_token" }
)
```

### channel_whitelist

```js
db.channel_whitelist.createIndex(
  { "ChannelType": 1, "IdentifierPattern": 1 },
  { name: "idx_channel_whitelist_type_pattern" }
)

db.channel_whitelist.createIndex(
  { "IsActive": 1, "Priority": 1 },
  { name: "idx_channel_whitelist_active_priority" }
)

db.channel_whitelist.createIndex(
  { "CreatedAt": -1 },
  { name: "idx_channel_whitelist_created" }
)
```

### channel_identity_mappings

```js
// 按 channelType + channelIdentifier 唯一
db.channel_identity_mappings.createIndex(
  { "ChannelType": 1, "ChannelIdentifier": 1 },
  { name: "uniq_channel_identity_type_identifier", unique: true }
)

db.channel_identity_mappings.createIndex(
  { "UserId": 1 },
  { name: "idx_channel_identity_user" }
)
```

### channel_tasks

```js
db.channel_tasks.createIndex(
  { "Status": 1, "CreatedAt": -1 },
  { name: "idx_channel_tasks_status_created" }
)

db.channel_tasks.createIndex(
  { "ChannelType": 1, "SenderIdentifier": 1, "CreatedAt": -1 },
  { name: "idx_channel_tasks_type_sender_created" }
)

db.channel_tasks.createIndex(
  { "MappedUserId": 1, "CreatedAt": -1 },
  { name: "idx_channel_tasks_user_created" }
)

db.channel_tasks.createIndex(
  { "CreatedAt": 1 },
  { name: "idx_channel_tasks_created" }
)
```

### channel_request_logs

```js
db.channel_request_logs.createIndex(
  { "ChannelType": 1, "CreatedAt": -1 },
  { name: "idx_channel_request_logs_type_created" }
)

db.channel_request_logs.createIndex(
  { "MappedUserId": 1, "CreatedAt": -1 },
  { name: "idx_channel_request_logs_user_created" }
)

db.channel_request_logs.createIndex(
  { "TaskId": 1 },
  { name: "idx_channel_request_logs_task" }
)

db.channel_request_logs.createIndex(
  { "EndedAt": 1 },
  { name: "idx_channel_request_logs_ended" }
)
```

### user_shortcuts

```js
// 按 tokenHash 唯一
db.user_shortcuts.createIndex(
  { "TokenHash": 1 },
  { name: "uniq_user_shortcuts_token_hash", unique: true }
)

db.user_shortcuts.createIndex(
  { "UserId": 1 },
  { name: "idx_user_shortcuts_user" }
)
```

### user_collections

```js
db.user_collections.createIndex(
  { "UserId": 1, "CreatedAt": -1 },
  { name: "idx_user_collections_user_created" }
)
```

### shortcut_templates

```js
db.shortcut_templates.createIndex(
  { "IsDefault": 1, "IsActive": 1 },
  { name: "idx_shortcut_templates_default_active" }
)
```

### toolbox_runs

```js
db.toolbox_runs.createIndex(
  { "UserId": 1, "CreatedAt": -1 },
  { name: "idx_toolbox_runs_user_created" }
)

db.toolbox_runs.createIndex(
  { "Status": 1, "CreatedAt": 1 },
  { name: "idx_toolbox_runs_status_created" }
)
```

### toolbox_items

```js
db.toolbox_items.createIndex(
  { "CreatedByUserId": 1, "CreatedAt": -1 },
  { name: "idx_toolbox_items_user_created" }
)

// 市场公开列表
db.toolbox_items.createIndex(
  { "IsPublic": 1, "ForkCount": -1 },
  { name: "idx_toolbox_items_public_forkcount" }
)
```

### toolbox_sessions

```js
db.toolbox_sessions.createIndex(
  { "UserId": 1, "ItemId": 1, "LastActiveAt": -1 },
  { name: "idx_toolbox_sessions_user_item_active" }
)
```

### toolbox_messages

```js
db.toolbox_messages.createIndex(
  { "SessionId": 1, "CreatedAt": 1 },
  { name: "idx_toolbox_messages_session_created" }
)
```

### webhook_delivery_logs

```js
db.webhook_delivery_logs.createIndex(
  { "AppId": 1, "CreatedAt": -1 },
  { name: "idx_webhook_delivery_logs_app_created" }
)

db.webhook_delivery_logs.createIndex(
  { "CreatedAt": 1 },
  { name: "idx_webhook_delivery_logs_created" }
)
```

### automation_rules

```js
db.automation_rules.createIndex(
  { "EventType": 1, "Enabled": 1 },
  { name: "idx_automation_rules_event_enabled" }
)

// 按 HookId 查询（sparse，忽略无 HookId 的文档）
db.automation_rules.createIndex(
  { "HookId": 1 },
  { name: "idx_automation_rules_hook_id", sparse: true }
)
```

### workflows

```js
db.workflows.createIndex(
  { "CreatedBy": 1, "UpdatedAt": -1 },
  { name: "idx_workflows_creator_updated" }
)

db.workflows.createIndex(
  { "IsPublic": 1, "ForkCount": -1 },
  { name: "idx_workflows_public_forkcount" }
)
```

### workflow_executions

```js
db.workflow_executions.createIndex(
  { "WorkflowId": 1, "CreatedAt": -1 },
  { name: "idx_workflow_executions_workflow_created" }
)

db.workflow_executions.createIndex(
  { "Status": 1, "CreatedAt": 1 },
  { name: "idx_workflow_executions_status_created" }
)

db.workflow_executions.createIndex(
  { "TriggeredBy": 1, "CreatedAt": -1 },
  { name: "idx_workflow_executions_trigger_created" }
)
```

### workflow_schedules

```js
db.workflow_schedules.createIndex(
  { "IsEnabled": 1, "NextRunAt": 1 },
  { name: "idx_workflow_schedules_enabled_nextrun" }
)

db.workflow_schedules.createIndex(
  { "WorkflowId": 1 },
  { name: "idx_workflow_schedules_workflow" }
)
```

### workflow_secrets

```js
// 按工作流ID + Key 唯一
db.workflow_secrets.createIndex(
  { "WorkflowId": 1, "Key": 1 },
  { name: "uniq_workflow_secrets_workflow_key", unique: true }
)
```

### share_links

```js
// 按 Token 唯一
db.share_links.createIndex(
  { "Token": 1 },
  { name: "uniq_share_links_token", unique: true }
)

db.share_links.createIndex(
  { "CreatedBy": 1, "CreatedAt": -1 },
  { name: "idx_share_links_creator_created" }
)

db.share_links.createIndex(
  { "ResourceType": 1, "ResourceId": 1 },
  { name: "idx_share_links_resource" }
)
```

### skills

```js
// SkillKey 唯一
db.skills.createIndex(
  { "SkillKey": 1 },
  { name: "uniq_skills_skill_key", unique: true }
)

db.skills.createIndex(
  { "Visibility": 1, "IsEnabled": 1, "Order": 1 },
  { name: "idx_skills_visibility_enabled_order" }
)

db.skills.createIndex(
  { "OwnerUserId": 1, "UpdatedAt": -1 },
  { name: "idx_skills_owner_updated" }
)
```

### model_exchanges

```js
// 按 ModelAlias 唯一
db.model_exchanges.createIndex(
  { "ModelAlias": 1 },
  { name: "uniq_exchange_model_alias", unique: true }
)
```

### tutorial_email_sequences

```js
// 按 sequenceKey 唯一
db.tutorial_email_sequences.createIndex(
  { "SequenceKey": 1 },
  { name: "uniq_tutorial_email_sequences_key", unique: true }
)
```

### tutorial_email_templates

```js
db.tutorial_email_templates.createIndex(
  { "CreatedAt": -1 },
  { name: "idx_tutorial_email_templates_created" }
)
```

### tutorial_email_assets

```js
db.tutorial_email_assets.createIndex(
  { "UploadedAt": -1 },
  { name: "idx_tutorial_email_assets_uploaded" }
)

db.tutorial_email_assets.createIndex(
  { "Tags": 1 },
  { name: "idx_tutorial_email_assets_tags" }
)
```

### tutorial_email_enrollments

```js
db.tutorial_email_enrollments.createIndex(
  { "Status": 1, "NextSendAt": 1 },
  { name: "idx_tutorial_email_enrollments_status_next" }
)

// 按 userId + sequenceKey 唯一
db.tutorial_email_enrollments.createIndex(
  { "UserId": 1, "SequenceKey": 1 },
  { name: "uniq_tutorial_email_enrollments_user_seq", unique: true }
)
```

### report_teams

```js
db.report_teams.createIndex(
  { "LeaderUserId": 1 },
  { name: "idx_report_teams_leader" }
)
```

### report_team_members

```js
// (TeamId, UserId) 唯一
db.report_team_members.createIndex(
  { "TeamId": 1, "UserId": 1 },
  { name: "uniq_report_team_members_team_user", unique: true }
)

db.report_team_members.createIndex(
  { "UserId": 1 },
  { name: "idx_report_team_members_user" }
)
```

### report_templates

```js
db.report_templates.createIndex(
  { "IsDefault": -1, "CreatedAt": -1 },
  { name: "idx_report_templates_default" }
)
```

### report_weekly_reports

```js
// (UserId, TeamId, WeekYear, WeekNumber) 唯一，防止重复周报
db.report_weekly_reports.createIndex(
  { "UserId": 1, "TeamId": 1, "WeekYear": 1, "WeekNumber": 1 },
  { name: "uniq_weekly_reports_user_team_week", unique: true }
)

db.report_weekly_reports.createIndex(
  { "TeamId": 1, "Status": 1, "PeriodEnd": -1 },
  { name: "idx_weekly_reports_team_status" }
)

db.report_weekly_reports.createIndex(
  { "UserId": 1, "PeriodEnd": -1 },
  { name: "idx_weekly_reports_user_period" }
)
```

### report_daily_logs

```js
// (UserId, Date) 唯一，一天一条
db.report_daily_logs.createIndex(
  { "UserId": 1, "Date": 1 },
  { name: "idx_daily_logs_user_date", unique: true }
)
```

### report_data_sources

```js
db.report_data_sources.createIndex(
  { "TeamId": 1 },
  { name: "idx_data_sources_team" }
)
```

### report_commits

```js
// (DataSourceId, CommitHash) 唯一，幂等同步
db.report_commits.createIndex(
  { "DataSourceId": 1, "CommitHash": 1 },
  { name: "idx_commits_source_hash", unique: true }
)

db.report_commits.createIndex(
  { "MappedUserId": 1, "CommittedAt": -1 },
  { name: "idx_commits_user_date" }
)
```

### report_comments

```js
db.report_comments.createIndex(
  { "ReportId": 1, "SectionIndex": 1 },
  { name: "idx_report_comments_report_section" }
)

db.report_comments.createIndex(
  { "ParentCommentId": 1 },
  { name: "idx_report_comments_parent" }
)
```

### report_likes (report_likes)

```js
// (ReportId, UserId) 唯一，防重复点赞
db.report_likes.createIndex(
  { "ReportId": 1, "UserId": 1 },
  { name: "uniq_report_likes_report_user", unique: true }
)

db.report_likes.createIndex(
  { "ReportId": 1, "CreatedAt": -1 },
  { name: "idx_report_likes_report_created" }
)
```

### report_team_summaries

```js
// (TeamId, WeekYear, WeekNumber) 唯一
db.report_team_summaries.createIndex(
  { "TeamId": 1, "WeekYear": 1, "WeekNumber": 1 },
  { name: "idx_team_summaries_team_week", unique: true }
)
```

### report_personal_sources

```js
db.report_personal_sources.createIndex(
  { "UserId": 1, "SourceType": 1 },
  { name: "idx_personal_sources_user_type" }
)
```

### arena_groups

```js
// 按 Key 唯一
db.arena_groups.createIndex(
  { "Key": 1 },
  { name: "uniq_arena_groups_key", unique: true }
)
```

### arena_slots

```js
db.arena_slots.createIndex(
  { "Group": 1, "SortOrder": 1 },
  { name: "idx_arena_slots_group_sort" }
)
```

### arena_battles

```js
db.arena_battles.createIndex(
  { "UserId": 1, "CreatedAt": -1 },
  { name: "idx_arena_battles_user_created" }
)
```

### hosted_sites

```js
db.hosted_sites.createIndex(
  { "OwnerUserId": 1, "CreatedAt": -1 },
  { name: "idx_hosted_sites_owner_created" }
)

db.hosted_sites.createIndex(
  { "Tags": 1 },
  { name: "idx_hosted_sites_tags" }
)

db.hosted_sites.createIndex(
  { "OwnerUserId": 1, "SourceType": 1 },
  { name: "idx_hosted_sites_owner_source" }
)

db.hosted_sites.createIndex(
  { "OwnerUserId": 1, "Folder": 1 },
  { name: "idx_hosted_sites_owner_folder" }
)
```

### web_page_share_links

```js
// 按 Token 唯一
db.web_page_share_links.createIndex(
  { "Token": 1 },
  { name: "uniq_web_page_share_links_token", unique: true }
)

db.web_page_share_links.createIndex(
  { "CreatedBy": 1, "CreatedAt": -1 },
  { name: "idx_web_page_share_links_creator_created" }
)
```

### share_view_logs

```js
db.share_view_logs.createIndex(
  { "ShareOwnerUserId": 1, "ViewedAt": -1 },
  { name: "idx_share_view_logs_owner_viewed" }
)

db.share_view_logs.createIndex(
  { "ShareToken": 1, "ViewedAt": -1 },
  { name: "idx_share_view_logs_token_viewed" }
)
```

### desktop_update_caches

```js
// (Version, Target) 唯一
db.desktop_update_caches.createIndex(
  { "Version": 1, "Target": 1 },
  { name: "uniq_desktop_update_caches_version_target", unique: true }
)

db.desktop_update_caches.createIndex(
  { "CreatedAt": -1 },
  { name: "idx_desktop_update_caches_created" }
)
```

### submissions

```js
db.submissions.createIndex(
  { "IsPublic": 1, "ContentType": 1, "CreatedAt": -1 },
  { name: "idx_submissions_public_type_created" }
)

db.submissions.createIndex(
  { "OwnerUserId": 1 },
  { name: "idx_submissions_owner" }
)

// 按 ImageAssetId 唯一（防重复投稿同一图片，仅对字符串类型生效）
db.submissions.createIndex(
  { "ImageAssetId": 1 },
  {
    name: "uniq_submissions_image_asset",
    unique: true,
    partialFilterExpression: { "ImageAssetId": { $type: "string" } }
  }
)
```

### submission_likes

```js
// (SubmissionId + UserId) 唯一
db.submission_likes.createIndex(
  { "SubmissionId": 1, "UserId": 1 },
  { name: "uniq_submission_likes_sid_uid", unique: true }
)
```

### skill_agent_sessions

技能创建助手的会话中间态（对话 / 意图 / SkillDraft / 阶段进度）。
内存层有 2h 无活动清理；DB 层用 TTL 索引做长窗口兜底，让用户"一周内回来继续"。

```js
// (Id + UserId) 用于上层查询（Id 即 _id，自动索引；UserId 复合加速跨用户隔离校验）
db.skill_agent_sessions.createIndex(
  { "UserId": 1, "LastActiveAt": -1 },
  { name: "ix_skill_agent_sessions_user_recent" }
)

// LastActiveAt 上 7 天 TTL，用户超过 7 天无活动的会话自动清理
db.skill_agent_sessions.createIndex(
  { "LastActiveAt": 1 },
  {
    name: "ttl_skill_agent_sessions_7d",
    expireAfterSeconds: 604800
  }
)
```
