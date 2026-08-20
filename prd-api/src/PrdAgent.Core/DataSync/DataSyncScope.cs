namespace PrdAgent.Core.DataSync;

/// <summary>
/// 跨 MAP 实例数据同步的导出白名单 —— 唯一数据源。
///
/// 为什么是白名单而不是黑名单：黑名单下，日后新增一个装凭据的集合会被**默认导出**，
/// 而且没有任何东西会报错。白名单反过来——新集合不在名单里就同步不到，最坏是漏，
/// 不会是泄。代价是新集合必须来这里登记一次，这个代价由 DataSyncScopeCoverageTests
/// 强制：MongoDbContext 里注册的每一个集合，必须要么在某个分组里，要么在
/// Excluded 里写明不导出的理由，二者缺一 CI 变红。
///
/// RedactFields 在**源站出口处**清空，不是到目标站再删。出口清空才是硬保证：
/// 中间任何一段（网络传输、目标站日志、失败重试的临时文件）都不会碰到密文。
/// 被清空的字段由操作者在目标站手工补填，同步页会列出「待补」清单。
/// </summary>
public sealed record DataSyncCollection(string Name, IReadOnlyList<string> RedactFields);

public sealed record DataSyncGroup(string Key, string Label, IReadOnlyList<DataSyncCollection> Collections);

public static class DataSyncScope
{
    /// <summary>可导出的分组。同意页按分组勾选，默认全选。</summary>
    public static readonly IReadOnlyList<DataSyncGroup> Groups = new[]
    {
        new DataSyncGroup("users", "账号与组织", new[]
        {
            new DataSyncCollection("default_nav_config", System.Array.Empty<string>()),
            new DataSyncCollection("groupmembers", System.Array.Empty<string>()),
            new DataSyncCollection("groups", System.Array.Empty<string>()),
            new DataSyncCollection("home_recent_opens", System.Array.Empty<string>()),
            new DataSyncCollection("report_team_members", System.Array.Empty<string>()),
            new DataSyncCollection("report_teams", System.Array.Empty<string>()),
            new DataSyncCollection("system_roles", System.Array.Empty<string>()),
            new DataSyncCollection("team_members", System.Array.Empty<string>()),
            new DataSyncCollection("teams", System.Array.Empty<string>()),
            new DataSyncCollection("user_collections", System.Array.Empty<string>()),
            new DataSyncCollection("user_preferences", System.Array.Empty<string>()),
            new DataSyncCollection("user_report_template_preferences", System.Array.Empty<string>()),
            new DataSyncCollection("user_shortcuts", new[] { "TokenHash" }),
            new DataSyncCollection("users", new[] { "PasswordHash" }),
        }),
        new DataSyncGroup("llm-config", "平台与模型配置", new[]
        {
            new DataSyncCollection("admin_prompt_overrides", System.Array.Empty<string>()),
            new DataSyncCollection("appsettings", new[] { "MiduoSsoAppSecret", "ConsoleSsoClientSecret" }),
            new DataSyncCollection("arena_groups", System.Array.Empty<string>()),
            new DataSyncCollection("arena_slots", System.Array.Empty<string>()),
            new DataSyncCollection("automation_rules", new[] { "WebhookUrl", "WebhookSecret" }),
            new DataSyncCollection("image_gen_size_caps", System.Array.Empty<string>()),
            new DataSyncCollection("llm_app_callers", System.Array.Empty<string>()),
            new DataSyncCollection("llmconfigs", new[] { "ApiKeyEncrypted" }),
            new DataSyncCollection("llmmodels", new[] { "ApiKeyEncrypted" }),
            new DataSyncCollection("llmplatforms", new[] { "ApiKeyEncrypted" }),
            new DataSyncCollection("model_groups", System.Array.Empty<string>()),
            new DataSyncCollection("model_lab_groups", System.Array.Empty<string>()),
            new DataSyncCollection("model_lab_model_sets", System.Array.Empty<string>()),
            new DataSyncCollection("model_scheduler_config", System.Array.Empty<string>()),
            new DataSyncCollection("product_agent_settings", System.Array.Empty<string>()),
            new DataSyncCollection("reference_image_configs", System.Array.Empty<string>()),
            new DataSyncCollection("routing_rules", System.Array.Empty<string>()),
            new DataSyncCollection("shortcut_templates", System.Array.Empty<string>()),
            new DataSyncCollection("systemprompts", System.Array.Empty<string>()),
            new DataSyncCollection("watermark_configs", System.Array.Empty<string>()),
            new DataSyncCollection("watermark_font_assets", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("defect", "缺陷管理", new[]
        {
            new DataSyncCollection("defect_fix_reports", new[] { "ShareToken" }),
            new DataSyncCollection("defect_folders", System.Array.Empty<string>()),
            new DataSyncCollection("defect_messages", System.Array.Empty<string>()),
            new DataSyncCollection("defect_projects", System.Array.Empty<string>()),
            new DataSyncCollection("defect_reports", System.Array.Empty<string>()),
            new DataSyncCollection("defect_resolution_traces", new[] { "ShareToken" }),
            new DataSyncCollection("defect_templates", System.Array.Empty<string>()),
            new DataSyncCollection("defect_webhook_configs", new[] { "WebhookUrl" }),
        }),
        new DataSyncGroup("knowledge", "知识库与文档", new[]
        {
            new DataSyncCollection("document_entries", System.Array.Empty<string>()),
            new DataSyncCollection("document_entry_versions", System.Array.Empty<string>()),
            new DataSyncCollection("document_inline_comments", System.Array.Empty<string>()),
            new DataSyncCollection("document_store_conversations", System.Array.Empty<string>()),
            new DataSyncCollection("document_store_favorites", System.Array.Empty<string>()),
            new DataSyncCollection("document_store_likes", System.Array.Empty<string>()),
            new DataSyncCollection("document_store_sync_links", new[] { "RemoteToken" }),
            new DataSyncCollection("document_stores", new[] { "SyncToken" }),
            new DataSyncCollection("documents", System.Array.Empty<string>()),
            new DataSyncCollection("knowledge_base_drafts", System.Array.Empty<string>()),
            new DataSyncCollection("prdcomments", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("report", "周报与团队", new[]
        {
            new DataSyncCollection("report_comments", System.Array.Empty<string>()),
            new DataSyncCollection("report_commits", System.Array.Empty<string>()),
            new DataSyncCollection("report_data_sources", new[] { "EncryptedAccessToken" }),
            new DataSyncCollection("report_likes", System.Array.Empty<string>()),
            new DataSyncCollection("report_personal_sources", new[] { "EncryptedToken" }),
            new DataSyncCollection("report_team_summaries", System.Array.Empty<string>()),
            new DataSyncCollection("report_templates", System.Array.Empty<string>()),
            new DataSyncCollection("report_webhook_configs", new[] { "WebhookUrl" }),
            new DataSyncCollection("report_weekly_reports", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("pm", "项目管理", new[]
        {
            new DataSyncCollection("pm_briefings", new[] { "ShareToken" }),
            new DataSyncCollection("pm_decisions", System.Array.Empty<string>()),
            new DataSyncCollection("pm_goal_checkins", System.Array.Empty<string>()),
            new DataSyncCollection("pm_goal_cycles", System.Array.Empty<string>()),
            new DataSyncCollection("pm_goals", System.Array.Empty<string>()),
            new DataSyncCollection("pm_knowledge_files", System.Array.Empty<string>()),
            new DataSyncCollection("pm_meetings", System.Array.Empty<string>()),
            new DataSyncCollection("pm_milestones", System.Array.Empty<string>()),
            new DataSyncCollection("pm_projects", System.Array.Empty<string>()),
            new DataSyncCollection("pm_reward_configs", System.Array.Empty<string>()),
            new DataSyncCollection("pm_risks", System.Array.Empty<string>()),
            new DataSyncCollection("pm_tasks", System.Array.Empty<string>()),
            new DataSyncCollection("pm_weekly_reports", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("product", "产品与需求", new[]
        {
            new DataSyncCollection("contentgaps", System.Array.Empty<string>()),
            new DataSyncCollection("feature_versions", System.Array.Empty<string>()),
            new DataSyncCollection("features", System.Array.Empty<string>()),
            new DataSyncCollection("product_categories", System.Array.Empty<string>()),
            new DataSyncCollection("product_desc_templates", System.Array.Empty<string>()),
            new DataSyncCollection("product_form_templates", System.Array.Empty<string>()),
            new DataSyncCollection("product_grade_options", System.Array.Empty<string>()),
            new DataSyncCollection("product_initiations", System.Array.Empty<string>()),
            new DataSyncCollection("product_item_summaries", System.Array.Empty<string>()),
            new DataSyncCollection("product_releases", System.Array.Empty<string>()),
            new DataSyncCollection("product_rules", System.Array.Empty<string>()),
            new DataSyncCollection("product_structure_nodes", System.Array.Empty<string>()),
            new DataSyncCollection("product_terms", System.Array.Empty<string>()),
            new DataSyncCollection("product_versions", System.Array.Empty<string>()),
            new DataSyncCollection("product_workflow_definitions", System.Array.Empty<string>()),
            new DataSyncCollection("products", System.Array.Empty<string>()),
            new DataSyncCollection("requirement_types", System.Array.Empty<string>()),
            new DataSyncCollection("requirements", System.Array.Empty<string>()),
            new DataSyncCollection("version_upgrade_requests", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("review", "评审与投稿", new[]
        {
            new DataSyncCollection("arena_battles", System.Array.Empty<string>()),
            new DataSyncCollection("pr_review_items", System.Array.Empty<string>()),
            new DataSyncCollection("review_appeals", System.Array.Empty<string>()),
            new DataSyncCollection("review_dimension_configs", System.Array.Empty<string>()),
            new DataSyncCollection("review_results", System.Array.Empty<string>()),
            new DataSyncCollection("review_submissions", System.Array.Empty<string>()),
            new DataSyncCollection("review_webhook_configs", new[] { "WebhookUrl" }),
            new DataSyncCollection("submission_likes", System.Array.Empty<string>()),
            new DataSyncCollection("submissions", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("creation", "创作与素材", new[]
        {
            new DataSyncCollection("asset_registry", System.Array.Empty<string>()),
            new DataSyncCollection("attachments", System.Array.Empty<string>()),
            new DataSyncCollection("desktop_asset_skins", System.Array.Empty<string>()),
            new DataSyncCollection("desktop_assets", System.Array.Empty<string>()),
            new DataSyncCollection("direct_video_job_ownerships", System.Array.Empty<string>()),
            new DataSyncCollection("homepage_assets", System.Array.Empty<string>()),
            new DataSyncCollection("image_assets", System.Array.Empty<string>()),
            new DataSyncCollection("image_master_canvases", System.Array.Empty<string>()),
            new DataSyncCollection("image_master_workspaces", System.Array.Empty<string>()),
            new DataSyncCollection("literary_agent_configs", System.Array.Empty<string>()),
            new DataSyncCollection("literary_prompts", System.Array.Empty<string>()),
            new DataSyncCollection("md_to_ppt_templates", System.Array.Empty<string>()),
            new DataSyncCollection("speech_decks", new[] { "PublishedShareToken" }),
            new DataSyncCollection("speech_nodes", System.Array.Empty<string>()),
            new DataSyncCollection("transcript_templates", System.Array.Empty<string>()),
            new DataSyncCollection("transcript_workspaces", System.Array.Empty<string>()),
            new DataSyncCollection("video_projects", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("hosting", "网页托管", new[]
        {
            new DataSyncCollection("hosted_site_comments", new[] { "ShareToken" }),
            new DataSyncCollection("hosted_sites", new[] { "Token" }),
            new DataSyncCollection("project_route_plans", System.Array.Empty<string>()),
            new DataSyncCollection("project_route_site_specs", System.Array.Empty<string>()),
            new DataSyncCollection("web_folders", System.Array.Empty<string>()),
            new DataSyncCollection("web_page_groups", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("channel", "渠道与邮件", new[]
        {
            new DataSyncCollection("channel_identity_mappings", System.Array.Empty<string>()),
            new DataSyncCollection("channel_settings", new[] { "ImapPassword", "SmtpPassword" }),
            new DataSyncCollection("channel_trace_cases", System.Array.Empty<string>()),
            new DataSyncCollection("channel_trace_checklists", System.Array.Empty<string>()),
            new DataSyncCollection("channel_trace_knowledge", System.Array.Empty<string>()),
            new DataSyncCollection("channel_whitelist", System.Array.Empty<string>()),
            new DataSyncCollection("email_classifications", System.Array.Empty<string>()),
            new DataSyncCollection("email_templates", System.Array.Empty<string>()),
            new DataSyncCollection("email_workflows", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("tutorial", "教程与引导", new[]
        {
            new DataSyncCollection("daily_tips", System.Array.Empty<string>()),
            new DataSyncCollection("tutorial_email_assets", System.Array.Empty<string>()),
            new DataSyncCollection("tutorial_email_enrollments", System.Array.Empty<string>()),
            new DataSyncCollection("tutorial_email_sequences", System.Array.Empty<string>()),
            new DataSyncCollection("tutorial_email_templates", System.Array.Empty<string>()),
            new DataSyncCollection("tutorial_link_graphs", System.Array.Empty<string>()),
        }),
        new DataSyncGroup("misc", "其他业务", new[]
        {
            new DataSyncCollection("ai_news_enrichments", System.Array.Empty<string>()),
            new DataSyncCollection("ccas_equipment_assets", System.Array.Empty<string>()),
            new DataSyncCollection("ccas_flow_diagrams", System.Array.Empty<string>()),
            new DataSyncCollection("customer_follow_ups", System.Array.Empty<string>()),
            new DataSyncCollection("customers", System.Array.Empty<string>()),
            new DataSyncCollection("emergence_nodes", System.Array.Empty<string>()),
            new DataSyncCollection("emergence_trees", System.Array.Empty<string>()),
            new DataSyncCollection("marketing_consult_reports", new[] { "ShareToken" }),
            new DataSyncCollection("marketplace_skills", System.Array.Empty<string>()),
            new DataSyncCollection("messages", System.Array.Empty<string>()),
            new DataSyncCollection("reprocess_agents", System.Array.Empty<string>()),
            new DataSyncCollection("skills", System.Array.Empty<string>()),
            new DataSyncCollection("task_nodes", System.Array.Empty<string>()),
            new DataSyncCollection("task_trees", System.Array.Empty<string>()),
            new DataSyncCollection("todo_items", System.Array.Empty<string>()),
            new DataSyncCollection("toolbox_items", System.Array.Empty<string>()),
            new DataSyncCollection("workflow_schedules", new[] { "Token", "Password" }),
            new DataSyncCollection("workflows", System.Array.Empty<string>()),
            new DataSyncCollection("workspaces", System.Array.Empty<string>()),
        }),
    };

    /// <summary>
    /// 明确不导出的集合 -> 理由。理由原样展示在同意页的「不会带走」一栏，
    /// 让批准的人看得见边界，而不是只看见一个勾选列表。
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> Excluded = new Dictionary<string, string>
    {
        ["account_data_transfers"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["activity_logs"] = "日志与埋点：量大且只对源站有意义",
        ["admin_idempotency"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["admin_notifications"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["admin_push_delivery_logs"] = "日志与埋点：量大且只对源站有意义",
        ["admin_push_profiles"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["admin_push_subscriptions"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["agent_api_keys"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["agent_open_endpoints"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["apirequestlogs"] = "日志与埋点：量大且只对源站有意义",
        ["behavior_events"] = "日志与埋点：量大且只对源站有意义",
        ["behavior_insight_states"] = "日志与埋点：量大且只对源站有意义",
        ["changelog_report_sources"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["changelog_snapshots"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["channel_request_logs"] = "日志与埋点：量大且只对源站有意义",
        ["channel_tasks"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["channel_trace_diagnose_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["channel_trace_diffs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["chat_agent_events"] = "日志与埋点：量大且只对源站有意义",
        ["chat_agent_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["chat_agent_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["console_sso_tickets"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["defect_automation_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["data_sync_grants"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["data_sync_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["defect_share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["desktop_asset_keys"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["desktop_update_caches"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_asset_cleanup_tasks"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_embeddings"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_recording_upload_chunks"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_recording_upload_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_store_agent_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_store_share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["document_store_view_events"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["document_sync_logs"] = "日志与埋点：量大且只对源站有意义",
        ["external_authorizations"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["github_user_connections"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["group_message_counters"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["hosted_site_ask_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["hosted_site_ask_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["image_gen_run_events"] = "日志与埋点：量大且只对源站有意义",
        ["image_gen_run_items"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["image_gen_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["image_master_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["image_master_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["inbox_items"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["infra_agent_events"] = "日志与埋点：量大且只对源站有意义",
        ["infra_agent_hook_profiles"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["infra_agent_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["infra_agent_runtime_profiles"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["infra_agent_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["infra_connections"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["invitecodes"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["llmrequestlogs"] = "日志与埋点：量大且只对源站有意义",
        ["llmshadow_comparisons"] = "日志与埋点：量大且只对源站有意义",
        ["marketplace_fork_logs"] = "日志与埋点：量大且只对源站有意义",
        ["marketplace_skill_share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["md_to_ppt_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["mentions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["model_exchanges"] = "日志与埋点：量大且只对源站有意义",
        ["model_lab_experiments"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["model_lab_run_items"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["model_lab_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["model_test_stubs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["open_api_request_logs"] = "日志与埋点：量大且只对源站有意义",
        ["openplatformapps"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["openplatformrequestlogs"] = "日志与埋点：量大且只对源站有意义",
        ["pa_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["pa_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["pa_tasks"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["pa_user_profiles"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["peer_nodes"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["peer_pairing_codes"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["peer_sync_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["pm_audit_logs"] = "日志与埋点：量大且只对源站有意义",
        ["pm_task_activities"] = "日志与埋点：量大且只对源站有意义",
        ["pm_task_work_logs"] = "日志与埋点：量大且只对源站有意义",
        ["product_item_activities"] = "日志与埋点：量大且只对源站有意义",
        ["profile_avatar_object_cleanup_tasks"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["registered_apps"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["report_daily_logs"] = "日志与埋点：量大且只对源站有意义",
        ["report_share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["report_view_events"] = "日志与埋点：量大且只对源站有意义",
        ["requirement_assessment_items"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["requirement_assessment_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["sessions"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["share_view_logs"] = "日志与埋点：量大且只对源站有意义",
        ["short_link_counters"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["short_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["short_video_material_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["site_view_events"] = "日志与埋点：量大且只对源站有意义",
        ["skill_agent_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["team_activity_logs"] = "日志与埋点：量大且只对源站有意义",
        ["toolbox_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["toolbox_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["toolbox_sessions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["toolbox_share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["transcript_items"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["transcript_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["upload_artifacts"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["video_export_tasks"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["video_gen_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["video_to_doc_runs"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["web_page_share_links"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
        ["webhook_delivery_logs"] = "日志与埋点：量大且只对源站有意义",
        ["weekly_posters"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["workflow_chat_messages"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["workflow_executions"] = "运行时会话/缓存/派生数据：跨实例没有意义，重新跑一次即可",
        ["workflow_secrets"] = "凭据/票据/分享令牌：跨实例复制等于复制访问权",
    };

    private static readonly Dictionary<string, DataSyncCollection> ByNameIndex =
        Groups.SelectMany(g => g.Collections).ToDictionary(c => c.Name, StringComparer.Ordinal);

    private static readonly Dictionary<string, string> GroupOfIndex =
        Groups.SelectMany(g => g.Collections.Select(c => (c.Name, g.Key)))
              .ToDictionary(x => x.Name, x => x.Key, StringComparer.Ordinal);

    public static IReadOnlyCollection<string> AllExportableCollections => ByNameIndex.Keys;

    /// <summary>集合是否可导出。名字不在白名单里一律 false——包括拼错的名字。</summary>
    public static bool TryResolve(string? collection, out DataSyncCollection resolved)
    {
        resolved = default!;
        if (string.IsNullOrWhiteSpace(collection)) return false;
        return ByNameIndex.TryGetValue(collection!, out resolved!);
    }

    public static string? GroupOf(string collection) =>
        GroupOfIndex.TryGetValue(collection, out var g) ? g : null;

    /// <summary>
    /// 把请求方勾选的分组展开成集合清单。不认识的分组 key 直接忽略而不是报错：
    /// 授权是人点出来的，一个过期的 key 不该让整次同步失败；而且忽略**只会缩小
    /// 范围**——展开只从 Groups 取，无从扩大。
    /// </summary>
    public static IReadOnlyList<DataSyncCollection> Expand(IEnumerable<string>? groupKeys)
    {
        var wanted = new HashSet<string>(groupKeys ?? Array.Empty<string>(), StringComparer.Ordinal);
        return Groups.Where(g => wanted.Contains(g.Key))
                     .SelectMany(g => g.Collections)
                     .ToList();
    }
}
