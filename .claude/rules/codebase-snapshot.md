# Codebase Skill（代码库快照）

> **最后更新**：2026-05-31 | **总提交数**：~375 | **文档版本**：SRS v3.0, PRD v3.0
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
├── cds/              # Cloud Dev Suite — 分支预览部署工具 (独立 Node/Express)
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
| **LLM Gateway** | `ILlmGateway` + `ModelResolver` + 三级调度 + 健康管理 + `SendRawWithResolutionAsync`（compute-then-send，发送阶段不得二次 Resolve） |
| **ModelPool** | 6 种策略引擎 (`Infrastructure/ModelPool/`) |
| **Marketplace** | `CONFIG_TYPE_REGISTRY` + `IForkable` 白名单复制 |
| **CLI Agent Executor** | `executorType` 分发 + `CliAgentContext` 共享上下文 + 多轮迭代 |

## 功能状态速查

**已完成**：对话 Run/Worker, 提示词阶段, 权限矩阵, 水印系统, VisualAgent, 文学代理, 速率限制, 液态玻璃主题, Open Platform, 模型组/Gateway, 模型池策略引擎+UI, 桌面自动更新, PRD 评论, 内容缺失检测, 会话归档, 数据管理, 管理通知, 缺陷管理 Agent, 缺陷分享(外部Agent分析+修复报告+验收), 视频 Agent, 视觉创作视频生成, 视频工作流胶囊, 配置市场, 周报管理 Agent (Phase 1-4), PR 审查工作台 V2（每用户 OAuth Device Flow + PR 快照 + 笔记）, 附件上传, 技能系统, 网页托管, 文档空间 (文件上传存盘+内容预览+订阅源定期同步), 涌现探索器 (种子→探索→涌现三维度+SSE流式+ReactFlow画布), 技术分析文档格式校验 Agent（PM2502 模板生成/上传检查/流式生成后自动校验）, CLI Agent 执行器(多执行器分发: builtin-llm/docker/api/script/lobster, 多轮迭代), **海鲜市场技能开放接口** (AgentApiKey `sk-ak-*` 长效 M2M + scope 白名单 [marketplace.skills:read/write + defect-agent:fix + 动态 agent.{key}:{action}] + 「接入 AI」弹窗三 Tab + findmapskills 官方技能虚拟注入到海鲜市场 + 演示视频通用 slot 基础设施 `demo.{id}.video` + P3 AgentOpenEndpoint 铺路 + MarketplaceSkill.ReferenceType 预留桥接), **LLM Gateway compute-then-send 重构 (PR #490)** (`ExpectedModelRespectingResolver` 已删除 + `SendRawWithResolutionAsync` 单次 Resolve 路径已落地 + 生图预解析 UI badge 已实现), **缺陷分享外部 Agent 临时密钥** (1 天 TTL `defect-agent:fix` scope + 分享弹窗/批量分享均支持 + 评论/标记修复接口启用 AiAccessKey 直连认证), **桌面端更新成功面板** (首次启动后展示版本更新内容，按版本只展示一次，数据源 `scripts/recent-updates.json`), **版本接口** (`GET /api/v` + `GET /api/version` 返回 commit/构建信息)

**CDS (P4 Part 18, 2026-04-14)**: 多项目隔离 (Project model + dockerNetwork) + **多仓库 git clone (G1 — Project.repoPath + 无状态 WorktreeService + POST /projects/:id/clone SSE)** + Topology 视图 Deploy 按钮 + Public URL 卡片 + Infra 连接串 + **MongoDB 存储后端 (D.1-D.3, JSON ↔ Mongo 运行时切换 + auto-fallback + seed-from-json)** + **GitHub Device Flow 仓库选择器 (E.1-E.3, /api/github/oauth/device-start + repos picker + Settings tab)** + **Stack auto-detect (G10, 8 种栈 nodejs/python/go/rust/java/ruby/php/dockerfile)** + **Self-update pre-check 防护 (validateBuildReadiness + /api/self-update-dry-run + module-load smoke test)** + 空模板 → 创建 → clone → detect → 自动 build profile 端到端 zero-friction 流程

**CDS GitHub 集成 (PR #450, 2026-04-19)**: **push 即部署** —— GitHub App webhook (POST /api/github/webhook) + check-run runner 实时把构建状态推回 PR Checks 面板 + `/cds help|redeploy|stop|logs` PR 评论 slash 命令 + 自动删分支/归档 + 注入防御 + orphan check run 回收。**AI Agent 交付流程相应更新**：对已 link 项目不再提示跑 `/cds-deploy-pipeline`(那是旧版流),push 后 CDS 自动建分支 + 构建 + 部署,2-5 分钟后预览域名就位。后端发 `branch.created/status` SSE 事件(GET /api/branches/stream),前端 Dashboard 打开时能实时看到分支出现 + 构建动画,无需刷新。详见 `.claude/rules/cds-auto-deploy.md`

**CDS 教程 + cdscli 评分/自愈 (PR #696, 2026-05-31)**: 4 个隔离示例工程 (`cds/examples/tutorial-0{1..4}-*/`) + 教程指南 (`doc/guide.cds-tutorial.md`) + 知识库发布脚本 (`scripts/publish-cds-tutorial-kb.py`，4 个独立 DocumentStore，appKey=cds-tutorial)。cdscli verify 扩展：**评分 0-100 分**（ERROR -25/WARNING -8/INFO -2，A≥90/B≥75/C≥60/D≥40/F<40）+ `--min-score N` 门禁 + `--fix/--write` 自愈（env-var 自动注入 placeholder、depends-on 自动补 healthcheck 提示，不可修项输出建议清单）。规则 SSOT 见 `doc/spec.cds-compose-contract.md` §4.4/§4.5，pytest 覆盖 `.claude/skills/cds/tests/test_verify_{score,selfheal}.py`。

**知识库卡片改版 (PR #696, 2026-05-31)**: `DocumentStorePage.tsx` — 多彩渐变图标（按库 ID hash 取色，6 色板）+ 文章迷你目录（序号+标题+标签+相对时间，露前 3 篇+「还有 N 篇」）+ 浏览/点赞 meta + 右下角（相对修改时间+贡献者头像）+ 视图切换（我的空间/收藏/点赞）上移到标题行。移除底部蓝条。后端 `recentEntries` 补 `tags` 字段，`with-preview` 补 LikeCount/ViewCount/FavoriteCount，RelativeTime 列表场景 `refreshIntervalMs={0}`。

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

## MongoDB 集合 (118 个)

核心：users, groups, groupmembers, documents, sessions, messages, group_message_counters, contentgaps, attachments, prdcomments, share_links | 网页托管：hosted_sites, web_page_share_links | LLM：llmconfigs, llmplatforms, llmmodels, llmrequestlogs, model_groups, model_scheduler_config, model_test_stubs, llm_app_callers, model_exchanges | Model Lab：model_lab_experiments, model_lab_runs, model_lab_run_items, model_lab_model_sets, model_lab_groups | Arena：arena_groups, arena_slots, arena_battles | VisualAgent：image_master_workspaces, image_assets, image_master_sessions, image_master_messages, image_master_canvases, image_gen_size_caps, image_gen_runs, image_gen_run_items, image_gen_run_events, upload_artifacts | 水印：watermark_configs, watermark_font_assets | 权限：system_roles, admin_notifications, invitecodes | 桌面：desktop_asset_skins, desktop_asset_keys, desktop_assets | 提示词/技能：promptstages, systemprompts, literary_prompts, skill_settings, skills, admin_prompt_overrides, literary_agent_configs, reference_image_configs | 开放平台：openplatformapps, openplatformrequestlogs, **agent_api_keys**, **agent_open_endpoints**, **external_authorizations** | 缺陷：defect_templates, defect_reports, defect_messages, defect_folders, defect_projects, defect_webhook_configs, defect_share_links, defect_fix_reports | 产品评审：review_submissions, review_results, review_dimension_configs, review_webhook_configs | PR 审查：github_user_connections, pr_review_items | 视频：video_gen_runs | 周报：report_teams, report_team_members, report_templates, report_weekly_reports, report_daily_logs, report_data_sources, report_commits, report_comments, report_likes, report_view_events, report_team_summaries | 海鲜市场：marketplace_fork_logs, marketplace_skills | 渠道：channel_whitelist, channel_identity_mappings, channel_tasks, channel_request_logs, channel_settings | 工作流：workflows, workflow_executions, workflow_schedules, workflow_secrets | 工具箱：toolbox_runs, toolbox_items | 邮件：email_classifications, email_workflows | 教程邮件：tutorial_email_sequences, tutorial_email_templates, tutorial_email_assets, tutorial_email_enrollments | 路由：registered_apps, routing_rules | 文档空间：document_stores, document_entries, document_sync_logs, document_store_likes, document_store_favorites, document_store_share_links, document_store_agent_runs, document_store_view_events, document_inline_comments | 涌现探索：emergence_trees, emergence_nodes | 工作空间：workspaces | 其他：apirequestlogs, user_preferences, appsettings, automation_rules, admin_idempotency, todo_items, webhook_delivery_logs, homepage_assets

## 交叉校验检查点

更新文档时必须做：
1. 代码→文档：Controller/Service 存在 → SRS 有描述
2. 文档→代码：SRS 描述 → 代码有实现
3. Git log→文档：近期 commit → 已反映
4. DB→数据字典：MongoDbContext → rule.data-dictionary.md
5. 关系→访问路径：Model 新增引用 → 端点权限校验已更新
6. 写入→读取对称：能写入 → 必有读取/展示路径
7. UI→API 闭环：前端入口 → API 增删改查通
