# Codebase Skill（代码库快照）

> **最后更新**：2026-02-07 | **总提交数**：329 | **文档版本**：SRS v3.0, PRD v3.0
>
> AI 读取此段落即可跳过全盘扫描，仅对增量变更定点校验。

## 项目结构

```
prd_agent/
├── prd-api/          # .NET 8 后端 (C# 12)
│   └── src/ → PrdAgent.Api/ + PrdAgent.Core/ + PrdAgent.Infrastructure/
├── prd-admin/        # React 18 管理后台 (Vite, Zustand, Radix UI)
├── prd-desktop/      # Tauri 2.0 桌面客户端 (Rust + React)
├── prd-video/        # Remotion 视频合成
├── doc/              # 编号文档 (design.*, spec.*, plan.*, rule.*, guide.*, report.*)
└── scripts/          # 构建/部署脚本
```

## 核心架构模式

| 模式 | 说明 |
|------|------|
| **Run/Worker** | 对话创建 Run → Worker 后台执行 → SSE (afterSeq 重连) |
| **Platform + Model** | `(platformId, modelId)` 替代原 Provider |
| **App Identity** | Controller 硬编码 `appKey` |
| **RBAC** | `SystemRole` + `AdminPermissionCatalog` (60+) + Middleware |
| **LLM Gateway** | `ILlmGateway` + `ModelResolver` + 三级调度 + 健康管理 |
| **ModelPool** | 6 种策略引擎 (`Infrastructure/ModelPool/`) |
| **Marketplace** | `CONFIG_TYPE_REGISTRY` + `IForkable` 白名单复制 |

## 功能状态速查

**已完成**：对话 Run/Worker, 提示词阶段, 权限矩阵, 水印系统, VisualAgent, 文学代理, 速率限制, 液态玻璃主题, Open Platform, 模型组/Gateway, 模型池策略引擎+UI, 桌面自动更新, PRD 评论, 内容缺失检测, 会话归档, 数据管理, 管理通知, 缺陷管理 Agent, 缺陷分享(外部Agent分析+修复报告+验收), 视频 Agent, 视觉创作视频生成, 视频工作流胶囊, 配置市场, 周报管理 Agent (Phase 1-4), 附件上传, 技能系统, 网页托管, 文档空间 (文件上传存盘+内容预览+订阅源定期同步), 涌现探索器 (种子→探索→涌现三维度+SSE流式+ReactFlow画布)

**部分完成**：知识库 (多文档上传+类型管理+三阶段格式检测+UTF-16 BOM 支持已实现, RAG/embedding 未实现)

**未实现**：i18n, K8s 部署, 告警通知 (邮件/Webhook)

## 已废弃概念 (勿再引用)

| 废弃 | 替代 |
|------|------|
| Guide / GuideController | Prompt Stages |
| Provider | Platform |
| ImageMaster (代码层) | VisualAgent (DB 名保留兼容) |
| 直接 SSE 流 | Run/Worker + afterSeq |
| IEEE 830-1998 | ISO/IEC/IEEE 29148:2018 |
| SmartModelScheduler | ILlmGateway + ModelResolver |

## MongoDB 集合 (105 个)

核心：users, groups, groupmembers, documents, sessions, messages, group_message_counters, contentgaps, attachments, prdcomments, share_links | 网页托管：hosted_sites, web_page_share_links | LLM：llmconfigs, llmplatforms, llmmodels, llmrequestlogs, model_groups, model_scheduler_config, model_test_stubs, llm_app_callers, model_exchanges | Model Lab：model_lab_experiments, model_lab_runs, model_lab_run_items, model_lab_model_sets, model_lab_groups | Arena：arena_groups, arena_slots, arena_battles | VisualAgent：image_master_workspaces, image_assets, image_master_sessions, image_master_messages, image_master_canvases, image_gen_size_caps, image_gen_runs, image_gen_run_items, image_gen_run_events, upload_artifacts | 水印：watermark_configs, watermark_font_assets | 权限：system_roles, admin_notifications, invitecodes | 桌面：desktop_asset_skins, desktop_asset_keys, desktop_assets | 提示词/技能：promptstages, systemprompts, literary_prompts, skill_settings, skills, admin_prompt_overrides, literary_agent_configs, reference_image_configs | 开放平台：openplatformapps, openplatformrequestlogs | 缺陷：defect_templates, defect_reports, defect_messages, defect_folders, defect_projects, defect_webhook_configs, defect_share_links, defect_fix_reports | 视频：video_gen_runs | 周报：report_teams, report_team_members, report_templates, report_weekly_reports, report_daily_logs, report_data_sources, report_commits, report_comments, report_likes, report_view_events, report_team_summaries | 海鲜市场：marketplace_fork_logs | 渠道：channel_whitelist, channel_identity_mappings, channel_tasks, channel_request_logs, channel_settings | 工作流：workflows, workflow_executions, workflow_schedules, workflow_secrets | 工具箱：toolbox_runs, toolbox_items | 邮件：email_classifications, email_workflows | 教程邮件：tutorial_email_sequences, tutorial_email_templates, tutorial_email_assets, tutorial_email_enrollments | 路由：registered_apps, routing_rules | 文档空间：document_stores, document_entries | 涌现探索：emergence_trees, emergence_nodes | 其他：apirequestlogs, user_preferences, appsettings, automation_rules, admin_idempotency, todo_items, webhook_delivery_logs

## 交叉校验检查点

更新文档时必须做：
1. 代码→文档：Controller/Service 存在 → SRS 有描述
2. 文档→代码：SRS 描述 → 代码有实现
3. Git log→文档：近期 commit → 已反映
4. DB→数据字典：MongoDbContext → rule.data-dictionary.md
5. 关系→访问路径：Model 新增引用 → 端点权限校验已更新
6. 写入→读取对称：能写入 → 必有读取/展示路径
7. UI→API 闭环：前端入口 → API 增删改查通
