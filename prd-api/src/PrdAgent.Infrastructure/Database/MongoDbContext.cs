using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// MongoDB数据库上下文
/// </summary>
public class MongoDbContext
{
    private readonly IMongoDatabase _database;

    /// <summary>
    /// 暴露底层 IMongoDatabase 实例（用于 DropCollectionAsync 等高级操作）
    /// </summary>
    public IMongoDatabase Database => _database;

    public MongoDbContext(string connectionString, string databaseName)
    {
        // 注册 BSON 类映射（替代注解方式）
        BsonClassMapRegistration.Register();
        
        var client = new MongoClient(connectionString);
        _database = client.GetDatabase(databaseName);
        
        // 索引由 DBA 手动创建，禁止应用启动时自动创建
        // 索引定义文档：doc/guide.mongodb-indexes.md
        // CreateIndexes();
    }

    public IMongoCollection<User> Users => _database.GetCollection<User>("users");
    public IMongoCollection<Group> Groups => _database.GetCollection<Group>("groups");
    public IMongoCollection<GroupMember> GroupMembers => _database.GetCollection<GroupMember>("groupmembers");
    // PRD 文档长期存储（原文 + 解析结构）
    public IMongoCollection<ParsedPrd> Documents => _database.GetCollection<ParsedPrd>("documents");
    // Sessions：对话会话元数据（IM 形态的“会话线程”）
    public IMongoCollection<Session> Sessions => _database.GetCollection<Session>("sessions");
    public IMongoCollection<Message> Messages => _database.GetCollection<Message>("messages");
    public IMongoCollection<GroupMessageCounter> GroupMessageCounters => _database.GetCollection<GroupMessageCounter>("group_message_counters");
    public IMongoCollection<ContentGap> ContentGaps => _database.GetCollection<ContentGap>("contentgaps");
    public IMongoCollection<Attachment> Attachments => _database.GetCollection<Attachment>("attachments");
    public IMongoCollection<LLMConfig> LLMConfigs => _database.GetCollection<LLMConfig>("llmconfigs");
    public IMongoCollection<InviteCode> InviteCodes => _database.GetCollection<InviteCode>("invitecodes");
    public IMongoCollection<LLMPlatform> LLMPlatforms => _database.GetCollection<LLMPlatform>("llmplatforms");
    public IMongoCollection<LLMModel> LLMModels => _database.GetCollection<LLMModel>("llmmodels");
    public IMongoCollection<AppSettings> AppSettings => _database.GetCollection<AppSettings>("appsettings");
    public IMongoCollection<AdminNotification> AdminNotifications => _database.GetCollection<AdminNotification>("admin_notifications");
    public IMongoCollection<DailyTip> DailyTips => _database.GetCollection<DailyTip>("daily_tips");
    public IMongoCollection<AutomationRule> AutomationRules => _database.GetCollection<AutomationRule>("automation_rules");
    /// <summary>
    /// PRD 问答系统提示词（非 JSON 输出任务）：按角色（PM/DEV/QA）可被管理后台覆盖
    /// </summary>
    public IMongoCollection<SystemPromptSettings> SystemPrompts => _database.GetCollection<SystemPromptSettings>("systemprompts");
    public IMongoCollection<LlmRequestLog> LlmRequestLogs => _database.GetCollection<LlmRequestLog>("llmrequestlogs");
    public IMongoCollection<ApiRequestLog> ApiRequestLogs => _database.GetCollection<ApiRequestLog>("apirequestlogs");
    public IMongoCollection<PrdComment> PrdComments => _database.GetCollection<PrdComment>("prdcomments");
    public IMongoCollection<ModelLabExperiment> ModelLabExperiments => _database.GetCollection<ModelLabExperiment>("model_lab_experiments");
    public IMongoCollection<ModelLabRun> ModelLabRuns => _database.GetCollection<ModelLabRun>("model_lab_runs");
    public IMongoCollection<ModelLabRunItem> ModelLabRunItems => _database.GetCollection<ModelLabRunItem>("model_lab_run_items");
    public IMongoCollection<ModelLabModelSet> ModelLabModelSets => _database.GetCollection<ModelLabModelSet>("model_lab_model_sets");
    public IMongoCollection<ModelLabGroup> ModelLabGroups => _database.GetCollection<ModelLabGroup>("model_lab_groups");
    public IMongoCollection<ImageMasterSession> ImageMasterSessions => _database.GetCollection<ImageMasterSession>("image_master_sessions");
    public IMongoCollection<ImageMasterMessage> ImageMasterMessages => _database.GetCollection<ImageMasterMessage>("image_master_messages");
    public IMongoCollection<ImageAsset> ImageAssets => _database.GetCollection<ImageAsset>("image_assets");
    public IMongoCollection<ImageMasterCanvas> ImageMasterCanvases => _database.GetCollection<ImageMasterCanvas>("image_master_canvases");
    public IMongoCollection<ImageMasterWorkspace> ImageMasterWorkspaces => _database.GetCollection<ImageMasterWorkspace>("image_master_workspaces");
    public IMongoCollection<ImageGenSizeCaps> ImageGenSizeCaps => _database.GetCollection<ImageGenSizeCaps>("image_gen_size_caps");
    public IMongoCollection<ImageGenRun> ImageGenRuns => _database.GetCollection<ImageGenRun>("image_gen_runs");
    public IMongoCollection<ImageGenRunItem> ImageGenRunItems => _database.GetCollection<ImageGenRunItem>("image_gen_run_items");
    public IMongoCollection<ImageGenRunEvent> ImageGenRunEvents => _database.GetCollection<ImageGenRunEvent>("image_gen_run_events");
    public IMongoCollection<UploadArtifact> UploadArtifacts => _database.GetCollection<UploadArtifact>("upload_artifacts");
    public IMongoCollection<AdminPromptOverride> AdminPromptOverrides => _database.GetCollection<AdminPromptOverride>("admin_prompt_overrides");
    public IMongoCollection<AdminIdempotencyRecord> AdminIdempotencyRecords => _database.GetCollection<AdminIdempotencyRecord>("admin_idempotency");
    public IMongoCollection<DesktopAssetSkin> DesktopAssetSkins => _database.GetCollection<DesktopAssetSkin>("desktop_asset_skins");
    public IMongoCollection<DesktopAssetKey> DesktopAssetKeys => _database.GetCollection<DesktopAssetKey>("desktop_asset_keys");
    public IMongoCollection<DesktopAsset> DesktopAssets => _database.GetCollection<DesktopAsset>("desktop_assets");
    public IMongoCollection<HomepageAsset> HomepageAssets => _database.GetCollection<HomepageAsset>("homepage_assets");
    public IMongoCollection<LiteraryPrompt> LiteraryPrompts => _database.GetCollection<LiteraryPrompt>("literary_prompts");
    public IMongoCollection<OpenPlatformApp> OpenPlatformApps => _database.GetCollection<OpenPlatformApp>("openplatformapps");
    public IMongoCollection<OpenPlatformRequestLog> OpenPlatformRequestLogs => _database.GetCollection<OpenPlatformRequestLog>("openplatformrequestlogs");

    // Agent 开放接口 API Key（海鲜市场开放接口 / Agent 开放入口 M2M 鉴权）
    public IMongoCollection<AgentApiKey> AgentApiKeys => _database.GetCollection<AgentApiKey>("agent_api_keys");

    // Agent 开放接口登记（P3 基础设施）—— 每个 Agent 可登记多条 HTTP 入口让外部 AI 调用
    public IMongoCollection<AgentOpenEndpoint> AgentOpenEndpoints => _database.GetCollection<AgentOpenEndpoint>("agent_open_endpoints");
    public IMongoCollection<ModelGroup> ModelGroups => _database.GetCollection<ModelGroup>("model_groups");
    public IMongoCollection<LLMAppCaller> LLMAppCallers => _database.GetCollection<LLMAppCaller>("llm_app_callers");
    public IMongoCollection<ModelSchedulerConfig> ModelSchedulerConfigs => _database.GetCollection<ModelSchedulerConfig>("model_scheduler_config");
    public IMongoCollection<ModelTestStub> ModelTestStubs => _database.GetCollection<ModelTestStub>("model_test_stubs");
    public IMongoCollection<SystemRole> SystemRoles => _database.GetCollection<SystemRole>("system_roles");
    public IMongoCollection<UserPreferences> UserPreferences => _database.GetCollection<UserPreferences>("user_preferences");
    public IMongoCollection<WatermarkFontAsset> WatermarkFontAssets => _database.GetCollection<WatermarkFontAsset>("watermark_font_assets");
    public IMongoCollection<WatermarkConfig> WatermarkConfigs => _database.GetCollection<WatermarkConfig>("watermark_configs");

    // 海鲜市场 Fork 下载记录
    public IMongoCollection<MarketplaceForkLog> MarketplaceForkLogs => _database.GetCollection<MarketplaceForkLog>("marketplace_fork_logs");

    // 海鲜市场「技能」条目（用户上传的 zip 技能包）
    public IMongoCollection<MarketplaceSkill> MarketplaceSkills => _database.GetCollection<MarketplaceSkill>("marketplace_skills");

    // Literary Agent 文学创作配置
    public IMongoCollection<LiteraryAgentConfig> LiteraryAgentConfigs => _database.GetCollection<LiteraryAgentConfig>("literary_agent_configs");
    public IMongoCollection<ReferenceImageConfig> ReferenceImageConfigs => _database.GetCollection<ReferenceImageConfig>("reference_image_configs");

    // Defect Agent 缺陷管理
    public IMongoCollection<DefectTemplate> DefectTemplates => _database.GetCollection<DefectTemplate>("defect_templates");
    public IMongoCollection<DefectReport> DefectReports => _database.GetCollection<DefectReport>("defect_reports");
    public IMongoCollection<DefectMessage> DefectMessages => _database.GetCollection<DefectMessage>("defect_messages");
    public IMongoCollection<DefectFolder> DefectFolders => _database.GetCollection<DefectFolder>("defect_folders");
    public IMongoCollection<DefectProject> DefectProjects => _database.GetCollection<DefectProject>("defect_projects");
    public IMongoCollection<DefectWebhookConfig> DefectWebhookConfigs => _database.GetCollection<DefectWebhookConfig>("defect_webhook_configs");
    public IMongoCollection<DefectShareLink> DefectShareLinks => _database.GetCollection<DefectShareLink>("defect_share_links");
    public IMongoCollection<DefectFixReport> DefectFixReports => _database.GetCollection<DefectFixReport>("defect_fix_reports");

    // Review Agent 产品评审员
    public IMongoCollection<ReviewSubmission> ReviewSubmissions => _database.GetCollection<ReviewSubmission>("review_submissions");
    public IMongoCollection<ReviewResult> ReviewResults => _database.GetCollection<ReviewResult>("review_results");
    public IMongoCollection<ReviewDimensionConfig> ReviewDimensionConfigs => _database.GetCollection<ReviewDimensionConfig>("review_dimension_configs");
    public IMongoCollection<ReviewWebhookConfig> ReviewWebhookConfigs => _database.GetCollection<ReviewWebhookConfig>("review_webhook_configs");

    // PR Review V2（pr-review）：用户级 GitHub OAuth 连接 + 审查记录
    public IMongoCollection<GitHubUserConnection> GitHubUserConnections => _database.GetCollection<GitHubUserConnection>("github_user_connections");
    public IMongoCollection<PrReviewItem> PrReviewItems => _database.GetCollection<PrReviewItem>("pr_review_items");

    // Report Agent 周报管理
    public IMongoCollection<ReportTeam> ReportTeams => _database.GetCollection<ReportTeam>("report_teams");
    public IMongoCollection<ReportTeamMember> ReportTeamMembers => _database.GetCollection<ReportTeamMember>("report_team_members");
    public IMongoCollection<ReportTemplate> ReportTemplates => _database.GetCollection<ReportTemplate>("report_templates");
    public IMongoCollection<UserReportTemplatePreference> UserReportTemplatePreferences => _database.GetCollection<UserReportTemplatePreference>("user_report_template_preferences");
    public IMongoCollection<WeeklyReport> WeeklyReports => _database.GetCollection<WeeklyReport>("report_weekly_reports");
    public IMongoCollection<ReportDailyLog> ReportDailyLogs => _database.GetCollection<ReportDailyLog>("report_daily_logs");
    public IMongoCollection<ReportDataSource> ReportDataSources => _database.GetCollection<ReportDataSource>("report_data_sources");
    public IMongoCollection<ReportCommit> ReportCommits => _database.GetCollection<ReportCommit>("report_commits");
    public IMongoCollection<ReportComment> ReportComments => _database.GetCollection<ReportComment>("report_comments");
    public IMongoCollection<ReportLike> ReportLikes => _database.GetCollection<ReportLike>("report_likes");
    public IMongoCollection<ReportViewEvent> ReportViewEvents => _database.GetCollection<ReportViewEvent>("report_view_events");
    public IMongoCollection<TeamSummary> ReportTeamSummaries => _database.GetCollection<TeamSummary>("report_team_summaries");
    public IMongoCollection<ReportWebhookConfig> ReportWebhookConfigs => _database.GetCollection<ReportWebhookConfig>("report_webhook_configs");
    public IMongoCollection<PersonalSource> PersonalSources => _database.GetCollection<PersonalSource>("report_personal_sources");
    public IMongoCollection<ReportShareLink> ReportShareLinks => _database.GetCollection<ReportShareLink>("report_share_links");

    // 周报海报：登录后主页轮播弹窗
    public IMongoCollection<WeeklyPosterAnnouncement> WeeklyPosters => _database.GetCollection<WeeklyPosterAnnouncement>("weekly_posters");

    // 更新中心「周报来源」配置（绑定知识库 + 文件名关键词，全员共享）
    public IMongoCollection<ChangelogReportSource> ChangelogReportSources => _database.GetCollection<ChangelogReportSource>("changelog_report_sources");

    // Channel Adapter 多通道适配器
    public IMongoCollection<ChannelWhitelist> ChannelWhitelists => _database.GetCollection<ChannelWhitelist>("channel_whitelist");
    public IMongoCollection<ChannelIdentityMapping> ChannelIdentityMappings => _database.GetCollection<ChannelIdentityMapping>("channel_identity_mappings");
    public IMongoCollection<ChannelTask> ChannelTasks => _database.GetCollection<ChannelTask>("channel_tasks");
    public IMongoCollection<ChannelRequestLog> ChannelRequestLogs => _database.GetCollection<ChannelRequestLog>("channel_request_logs");
    public IMongoCollection<ChannelSettings> ChannelSettings => _database.GetCollection<ChannelSettings>("channel_settings");

    // Apple Shortcuts 快捷指令
    public IMongoCollection<UserShortcut> UserShortcuts => _database.GetCollection<UserShortcut>("user_shortcuts");
    public IMongoCollection<UserCollection> UserCollections => _database.GetCollection<UserCollection>("user_collections");
    public IMongoCollection<ShortcutTemplate> ShortcutTemplates => _database.GetCollection<ShortcutTemplate>("shortcut_templates");

    // Email Channel 邮件通道
    public IMongoCollection<TodoItem> TodoItems => _database.GetCollection<TodoItem>("todo_items");
    public IMongoCollection<EmailClassification> EmailClassifications => _database.GetCollection<EmailClassification>("email_classifications");
    public IMongoCollection<EmailWorkflow> EmailWorkflows => _database.GetCollection<EmailWorkflow>("email_workflows");

    // App Registry 应用注册中心
    public IMongoCollection<RegisteredApp> RegisteredApps => _database.GetCollection<RegisteredApp>("registered_apps");
    public IMongoCollection<RoutingRule> RoutingRules => _database.GetCollection<RoutingRule>("routing_rules");
    // AI Toolbox 百宝箱
    public IMongoCollection<ToolboxRun> ToolboxRuns => _database.GetCollection<ToolboxRun>("toolbox_runs");
    public IMongoCollection<ToolboxItem> ToolboxItems => _database.GetCollection<ToolboxItem>("toolbox_items");
    public IMongoCollection<ToolboxSession> ToolboxSessions => _database.GetCollection<ToolboxSession>("toolbox_sessions");
    public IMongoCollection<ToolboxMessage> ToolboxMessages => _database.GetCollection<ToolboxMessage>("toolbox_messages");
    public IMongoCollection<ToolboxShareLink> ToolboxShareLinks => _database.GetCollection<ToolboxShareLink>("toolbox_share_links");

    // 统一技能集合
    public IMongoCollection<Skill> Skills => _database.GetCollection<Skill>("skills");

    // 技能生成 Agent 会话持久化：保证刷新 / 重启 / 2h 后不丢失中间态
    // 建议由 DBA 手动添加 LastActiveAt TTL 索引（7 天），见 doc/guide.mongodb-indexes.md
    public IMongoCollection<SkillAgentSession> SkillAgentSessions => _database.GetCollection<SkillAgentSession>("skill_agent_sessions");

    // Workflow Agent 工作流引擎
    public IMongoCollection<Workflow> Workflows => _database.GetCollection<Workflow>("workflows");
    public IMongoCollection<WorkflowExecution> WorkflowExecutions => _database.GetCollection<WorkflowExecution>("workflow_executions");
    public IMongoCollection<WorkflowSchedule> WorkflowSchedules => _database.GetCollection<WorkflowSchedule>("workflow_schedules");
    public IMongoCollection<WorkflowSecret> WorkflowSecrets => _database.GetCollection<WorkflowSecret>("workflow_secrets");
    public IMongoCollection<WorkflowChatMessage> WorkflowChatMessages => _database.GetCollection<WorkflowChatMessage>("workflow_chat_messages");
    public IMongoCollection<ShareLink> ShareLinks => _database.GetCollection<ShareLink>("share_links");

    // Webhook 通知
    public IMongoCollection<WebhookDeliveryLog> WebhookDeliveryLogs => _database.GetCollection<WebhookDeliveryLog>("webhook_delivery_logs");

    // Arena 竞技场（盲评对战）
    public IMongoCollection<ArenaGroup> ArenaGroups => _database.GetCollection<ArenaGroup>("arena_groups");
    public IMongoCollection<ArenaSlot> ArenaSlots => _database.GetCollection<ArenaSlot>("arena_slots");
    public IMongoCollection<ArenaBattle> ArenaBattles => _database.GetCollection<ArenaBattle>("arena_battles");

    // 模型中继 (Exchange)
    public IMongoCollection<ModelExchange> ModelExchanges => _database.GetCollection<ModelExchange>("model_exchanges");

    // Account Data Transfer 账户数据分享
    public IMongoCollection<AccountDataTransfer> AccountDataTransfers => _database.GetCollection<AccountDataTransfer>("account_data_transfers");

    // Video Agent 文章转视频
    public IMongoCollection<VideoGenRun> VideoGenRuns => _database.GetCollection<VideoGenRun>("video_gen_runs");

    // Desktop 更新加速缓存
    public IMongoCollection<DesktopUpdateCache> DesktopUpdateCaches => _database.GetCollection<DesktopUpdateCache>("desktop_update_caches");

    // Web Hosting 网页托管与分享
    public IMongoCollection<HostedSite> HostedSites => _database.GetCollection<HostedSite>("hosted_sites");
    public IMongoCollection<WebPageShareLink> WebPageShareLinks => _database.GetCollection<WebPageShareLink>("web_page_share_links");
    public IMongoCollection<ShareViewLog> ShareViewLogs => _database.GetCollection<ShareViewLog>("share_view_logs");

    // MAP Inbox — 跨系统数据导入通道（骨架，Controller 留待下次迭代开发）
    public IMongoCollection<InboxItem> InboxItems => _database.GetCollection<InboxItem>("inbox_items");

    // Workspace 工作空间
    public IMongoCollection<Workspace> Workspaces => _database.GetCollection<Workspace>("workspaces");

    // Video Agent 视频转文档
    public IMongoCollection<VideoToDocRun> VideoToDocRuns => _database.GetCollection<VideoToDocRun>("video_to_doc_runs");

    // 作品投稿展示
    public IMongoCollection<Submission> Submissions => _database.GetCollection<Submission>("submissions");
    public IMongoCollection<SubmissionLike> SubmissionLikes => _database.GetCollection<SubmissionLike>("submission_likes");

    // Tutorial Email 教程邮件
    public IMongoCollection<TutorialEmailSequence> TutorialEmailSequences => _database.GetCollection<TutorialEmailSequence>("tutorial_email_sequences");
    public IMongoCollection<TutorialEmailTemplate> TutorialEmailTemplates => _database.GetCollection<TutorialEmailTemplate>("tutorial_email_templates");
    public IMongoCollection<TutorialEmailAsset> TutorialEmailAssets => _database.GetCollection<TutorialEmailAsset>("tutorial_email_assets");
    public IMongoCollection<TutorialEmailEnrollment> TutorialEmailEnrollments => _database.GetCollection<TutorialEmailEnrollment>("tutorial_email_enrollments");

    // Transcript Agent 音视频转录
    public IMongoCollection<TranscriptWorkspace> TranscriptWorkspaces => _database.GetCollection<TranscriptWorkspace>("transcript_workspaces");
    public IMongoCollection<TranscriptItem> TranscriptItems => _database.GetCollection<TranscriptItem>("transcript_items");
    public IMongoCollection<TranscriptRun> TranscriptRuns => _database.GetCollection<TranscriptRun>("transcript_runs");
    public IMongoCollection<TranscriptTemplate> TranscriptTemplates => _database.GetCollection<TranscriptTemplate>("transcript_templates");

    // Document Store 文档空间
    public IMongoCollection<DocumentStore> DocumentStores => _database.GetCollection<DocumentStore>("document_stores");
    public IMongoCollection<DocumentEntry> DocumentEntries => _database.GetCollection<DocumentEntry>("document_entries");
    public IMongoCollection<DocumentStoreLike> DocumentStoreLikes => _database.GetCollection<DocumentStoreLike>("document_store_likes");
    public IMongoCollection<DocumentStoreFavorite> DocumentStoreFavorites => _database.GetCollection<DocumentStoreFavorite>("document_store_favorites");
    public IMongoCollection<DocumentStoreShareLink> DocumentStoreShareLinks => _database.GetCollection<DocumentStoreShareLink>("document_store_share_links");
    public IMongoCollection<DocumentSyncLog> DocumentSyncLogs => _database.GetCollection<DocumentSyncLog>("document_sync_logs");
    public IMongoCollection<DocumentStoreAgentRun> DocumentStoreAgentRuns => _database.GetCollection<DocumentStoreAgentRun>("document_store_agent_runs");
    public IMongoCollection<DocumentStoreViewEvent> DocumentStoreViewEvents => _database.GetCollection<DocumentStoreViewEvent>("document_store_view_events");
    public IMongoCollection<DocumentInlineComment> DocumentInlineComments => _database.GetCollection<DocumentInlineComment>("document_inline_comments");

    // Emergence Explorer 涌现探索器
    public IMongoCollection<EmergenceTree> EmergenceTrees => _database.GetCollection<EmergenceTree>("emergence_trees");
    public IMongoCollection<EmergenceNode> EmergenceNodes => _database.GetCollection<EmergenceNode>("emergence_nodes");

    // Asset Registry 资产登记簿（跨存储迁移基础设施）
    public IMongoCollection<AssetRegistryEntry> AssetRegistry => _database.GetCollection<AssetRegistryEntry>("asset_registry");

    private void CreateIndexes()
    {
        static bool IsIndexConflict(MongoCommandException ex)
        {
            // 兼容不同 MongoDB 版本/代理层返回差异：
            // - 有些环境会返回 CodeName
            // - 有些环境只返回 Code 或 message（CodeName 为空）
            if (ex.CodeName is "IndexOptionsConflict" or "IndexKeySpecsConflict" or "IndexAlreadyExists")
            {
                return true;
            }

            if (ex.Code is 85 or 86 or 68)
            {
                return true;
            }

            var message = ex.Message ?? string.Empty;
            return message.Contains("equivalent index already exists", StringComparison.OrdinalIgnoreCase)
                || message.Contains("already exists with a different name and options", StringComparison.OrdinalIgnoreCase)
                || message.Contains("IndexOptionsConflict", StringComparison.OrdinalIgnoreCase)
                || message.Contains("IndexKeySpecsConflict", StringComparison.OrdinalIgnoreCase)
                || message.Contains("IndexAlreadyExists", StringComparison.OrdinalIgnoreCase);
        }

        void EnsureTtlIndex<TDocument>(
            IMongoCollection<TDocument> collection,
            string collectionName,
            string fieldName,
            TimeSpan expireAfter,
            string? indexName = null)
        {
            var options = new CreateIndexOptions
            {
                ExpireAfter = expireAfter
            };
            if (!string.IsNullOrWhiteSpace(indexName))
            {
                options.Name = indexName;
            }

            try
            {
                collection.Indexes.CreateOne(new CreateIndexModel<TDocument>(
                    Builders<TDocument>.IndexKeys.Ascending(fieldName),
                    options));
            }
            catch (MongoCommandException ex) when (IsIndexConflict(ex))
            {
                // 兼容历史环境：旧索引可能已存在（同 key 但非 TTL），此时 createIndexes 会因选项冲突失败并导致进程启动中断。
                // 优先按 name 执行 collMod 升级 TTL，若名称不匹配则回退到 keyPattern 升级。
                var ttlSeconds = (long)Math.Floor(expireAfter.TotalSeconds);
                try
                {
                    var collModByName = new BsonDocument
                    {
                        { "collMod", collectionName },
                        { "index", new BsonDocument
                            {
                                { "name", indexName ?? $"{fieldName}_1" },
                                { "expireAfterSeconds", ttlSeconds }
                            }
                        }
                    };
                    _database.RunCommand<BsonDocument>(collModByName);
                }
                catch (MongoCommandException)
                {
                    try
                    {
                        var collModByPattern = new BsonDocument
                        {
                            { "collMod", collectionName },
                            { "index", new BsonDocument
                                {
                                    { "keyPattern", new BsonDocument(fieldName, 1) },
                                    { "expireAfterSeconds", ttlSeconds }
                                }
                            }
                        };
                        _database.RunCommand<BsonDocument>(collModByPattern);
                    }
                    catch (MongoCommandException ex2) when (IsIndexConflict(ex2))
                    {
                        // ignore
                    }
                }
            }
        }

        // Users索引
        try
        {
            Users.Indexes.CreateOne(new CreateIndexModel<User>(
                Builders<User>.IndexKeys.Ascending(u => u.Username),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore：旧环境可能存在 unique 索引；按“业务控制”原则不再强制
        }

        // SystemRoles 索引（按 Key 查询）
        try
        {
            SystemRoles.Indexes.CreateOne(new CreateIndexModel<SystemRole>(
                Builders<SystemRole>.IndexKeys.Ascending(x => x.Key),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // Groups索引
        try
        {
            Groups.Indexes.CreateOne(new CreateIndexModel<Group>(
                Builders<Group>.IndexKeys.Ascending(g => g.InviteCode),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // Documents：Id 为 _id（内容 hash），天然唯一；额外加一个 CreatedAt 索引便于排序/排查
        Documents.Indexes.CreateOne(new CreateIndexModel<ParsedPrd>(
            Builders<ParsedPrd>.IndexKeys.Descending(d => d.CreatedAt)));

        // PrdComments：按文档/章节聚合查询
        PrdComments.Indexes.CreateOne(new CreateIndexModel<PrdComment>(
            Builders<PrdComment>.IndexKeys
                .Ascending(x => x.DocumentId)
                .Ascending(x => x.HeadingId)
                .Descending(x => x.CreatedAt)));

        // GroupMembers复合索引
        try
        {
            GroupMembers.Indexes.CreateOne(new CreateIndexModel<GroupMember>(
                Builders<GroupMember>.IndexKeys
                    .Ascending(m => m.GroupId)
                    .Ascending(m => m.UserId),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // Sessions：groupId 唯一（单群单会话）。注意：个人会话 groupId 为空，应通过 partial filter 排除。
        try
        {
            Sessions.Indexes.CreateOne(new CreateIndexModel<Session>(
                Builders<Session>.IndexKeys.Ascending(s => s.GroupId),
                new CreateIndexOptions<Session>
                {
                    Name = "uniq_sessions_group",
                    Unique = true,
                    PartialFilterExpression = new BsonDocument("GroupId", new BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore：可能已存在 unique 版本
        }

        // Sessions：个人会话列表排序/查询（ownerUserId + lastActiveAt desc）
        Sessions.Indexes.CreateOne(new CreateIndexModel<Session>(
            Builders<Session>.IndexKeys
                .Ascending(s => s.OwnerUserId)
                .Descending(s => s.LastActiveAt),
            new CreateIndexOptions<Session>
            {
                Name = "idx_sessions_owner_last_active",
                PartialFilterExpression = new BsonDocument("OwnerUserId", new BsonDocument("$type", "string"))
            }));

        // Messages索引
        Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
            Builders<Message>.IndexKeys.Ascending(m => m.GroupId)));
        Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
            Builders<Message>.IndexKeys.Ascending(m => m.SessionId)));
        // replyToMessageId：用于级联删除/一问多答关联
        Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
            Builders<Message>.IndexKeys.Ascending(m => m.ReplyToMessageId),
            new CreateIndexOptions { Name = "idx_messages_reply_to" }));
        // groupId + groupSeq 唯一：用于群消息顺序键（SSE 断线续传/严格有序）。
        // 注意：历史/非群消息 groupSeq 可能为空；若不加 partial filter，Unique 会导致同群多个 null 冲突。
        try
        {
            Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
                Builders<Message>.IndexKeys
                    .Ascending(m => m.GroupId)
                    .Ascending(m => m.GroupSeq),
                new CreateIndexOptions<Message>
                {
                    Name = "uniq_messages_group_seq",
                    // 仅对存在且为 long 的 groupSeq 建唯一约束；避免 null / 缺失字段冲突
                    PartialFilterExpression = new BsonDocument("GroupSeq", new BsonDocument("$type", "long"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore：可能已存在 unique 版本
        }
        // 用于按 sessionId + 时间游标分页（before）
        Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
            Builders<Message>.IndexKeys
                .Ascending(m => m.SessionId)
                .Descending(m => m.Timestamp),
            new CreateIndexOptions { Name = "idx_messages_session_ts" }));

        // ContentGaps索引
        ContentGaps.Indexes.CreateOne(new CreateIndexModel<ContentGap>(
            Builders<ContentGap>.IndexKeys.Ascending(g => g.GroupId)));
        
        // InviteCodes: 禁止用业务字段 Code 当 _id；统一使用 string Id(Guid) 作为 _id，因此需要对 Code 建唯一索引
        try
        {
            InviteCodes.Indexes.CreateOne(new CreateIndexModel<InviteCode>(
                Builders<InviteCode>.IndexKeys.Ascending(x => x.Code),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        
        // LLMPlatforms索引
        try
        {
            LLMPlatforms.Indexes.CreateOne(new CreateIndexModel<LLMPlatform>(
                Builders<LLMPlatform>.IndexKeys.Ascending(p => p.Name),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        
        // LLMModels索引
        LLMModels.Indexes.CreateOne(new CreateIndexModel<LLMModel>(
            Builders<LLMModel>.IndexKeys.Ascending(m => m.ModelName)));
        LLMModels.Indexes.CreateOne(new CreateIndexModel<LLMModel>(
            Builders<LLMModel>.IndexKeys.Ascending(m => m.PlatformId)));
        LLMModels.Indexes.CreateOne(new CreateIndexModel<LLMModel>(
            Builders<LLMModel>.IndexKeys.Ascending(m => m.Priority)));

        // LLMRequestLogs 索引（调试与监控）
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Descending(l => l.StartedAt)));
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Ascending(l => l.RequestId)));
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Ascending(l => l.GroupId)));
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Ascending(l => l.SessionId)));
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Ascending(l => l.Provider).Ascending(l => l.Model)));

        // EndedAt 普通索引（仅用于查询，不自动删除数据）
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Ascending(l => l.EndedAt)));

        // ApiRequestLogs 索引（系统请求日志）
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Descending(x => x.StartedAt)));
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.RequestId)));
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.UserId)));
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.Path)));
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.StatusCode)));
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.ClientType).Ascending(x => x.ClientId)));

        // EndedAt 普通索引（仅用于查询，不自动删除数据）
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.EndedAt)));

        // ModelLabExperiments 索引
        ModelLabExperiments.Indexes.CreateOne(new CreateIndexModel<ModelLabExperiment>(
            Builders<ModelLabExperiment>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.UpdatedAt)));
        ModelLabExperiments.Indexes.CreateOne(new CreateIndexModel<ModelLabExperiment>(
            Builders<ModelLabExperiment>.IndexKeys.Descending(x => x.CreatedAt)));

        // ModelLabRuns 索引
        ModelLabRuns.Indexes.CreateOne(new CreateIndexModel<ModelLabRun>(
            Builders<ModelLabRun>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.StartedAt)));
        ModelLabRuns.Indexes.CreateOne(new CreateIndexModel<ModelLabRun>(
            Builders<ModelLabRun>.IndexKeys.Ascending(x => x.ExperimentId)));

        // ModelLabRunItems 索引
        ModelLabRunItems.Indexes.CreateOne(new CreateIndexModel<ModelLabRunItem>(
            Builders<ModelLabRunItem>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.RunId)));
        ModelLabRunItems.Indexes.CreateOne(new CreateIndexModel<ModelLabRunItem>(
            Builders<ModelLabRunItem>.IndexKeys.Ascending(x => x.ModelId)));

        // ModelLabModelSets 索引（同一 Admin 下名称唯一）
        try
        {
            ModelLabModelSets.Indexes.CreateOne(new CreateIndexModel<ModelLabModelSet>(
                Builders<ModelLabModelSet>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.Name),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        ModelLabModelSets.Indexes.CreateOne(new CreateIndexModel<ModelLabModelSet>(
            Builders<ModelLabModelSet>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.UpdatedAt)));

        // ModelLabGroups 索引（同一 Admin 下名称唯一）
        try
        {
            ModelLabGroups.Indexes.CreateOne(new CreateIndexModel<ModelLabGroup>(
                Builders<ModelLabGroup>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.Name),
                new CreateIndexOptions()));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        ModelLabGroups.Indexes.CreateOne(new CreateIndexModel<ModelLabGroup>(
            Builders<ModelLabGroup>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.UpdatedAt)));

        // ImageMasterSessions：按 owner + updatedAt
        ImageMasterSessions.Indexes.CreateOne(new CreateIndexModel<ImageMasterSession>(
            Builders<ImageMasterSession>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.UpdatedAt)));

        // ImageMasterMessages：按 session + createdAt
        ImageMasterMessages.Indexes.CreateOne(new CreateIndexModel<ImageMasterMessage>(
            Builders<ImageMasterMessage>.IndexKeys.Ascending(x => x.SessionId).Ascending(x => x.CreatedAt)));
        // ImageMasterMessages（Workspace 场景）：按 workspace + createdAt
        ImageMasterMessages.Indexes.CreateOne(new CreateIndexModel<ImageMasterMessage>(
            Builders<ImageMasterMessage>.IndexKeys.Ascending(x => x.WorkspaceId).Ascending(x => x.CreatedAt)));

        // ImageAssets：按 owner + createdAt
        ImageAssets.Indexes.CreateOne(new CreateIndexModel<ImageAsset>(
            Builders<ImageAsset>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.CreatedAt)));

        // ImageAssets（Workspace 场景）：按 workspace + createdAt；按 workspace + sha256 去重（仅对存在 workspaceId 的文档生效）
        ImageAssets.Indexes.CreateOne(new CreateIndexModel<ImageAsset>(
            Builders<ImageAsset>.IndexKeys.Ascending(x => x.WorkspaceId).Descending(x => x.CreatedAt)));
        try
        {
            ImageAssets.Indexes.CreateOne(new CreateIndexModel<ImageAsset>(
                Builders<ImageAsset>.IndexKeys.Ascending(x => x.WorkspaceId).Ascending(x => x.Sha256),
                new CreateIndexOptions<ImageAsset>
                {
                    Name = "uniq_image_assets_workspace_sha256",
                    // 兼容旧 Mongo：partial index 不支持 $ne（会被解析成 $not/$eq 导致 createIndexes 失败）
                    // 约束由业务保证：workspaceId 必须是非空字符串；legacy 数据应清空（你已选择清库）。
                    PartialFilterExpression = new BsonDocument("workspaceId", new BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore：可能已存在 unique 版本
        }

        // ImageMasterCanvases：按 owner + session 查询（不做唯一约束，避免历史脏数据/字段缺失导致启动失败或写入冲突）
        ImageMasterCanvases.Indexes.CreateOne(new CreateIndexModel<ImageMasterCanvas>(
            Builders<ImageMasterCanvas>.IndexKeys.Ascending(x => x.OwnerUserId).Ascending(x => x.SessionId),
            new CreateIndexOptions<ImageMasterCanvas> { Name = "idx_image_master_canvases_owner_session" }));
        ImageMasterCanvases.Indexes.CreateOne(new CreateIndexModel<ImageMasterCanvas>(
            Builders<ImageMasterCanvas>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.UpdatedAt)));
        // ImageMasterCanvases（Workspace 场景）：按 workspaceId 查询（不做唯一约束）
        ImageMasterCanvases.Indexes.CreateOne(new CreateIndexModel<ImageMasterCanvas>(
            Builders<ImageMasterCanvas>.IndexKeys.Ascending(x => x.WorkspaceId),
            new CreateIndexOptions<ImageMasterCanvas> { Name = "idx_image_master_canvases_workspace" }));

        // ImageMasterWorkspaces：按 owner + updatedAt；按 memberUserIds（multi-key）便于共享可见性查询
        ImageMasterWorkspaces.Indexes.CreateOne(new CreateIndexModel<ImageMasterWorkspace>(
            Builders<ImageMasterWorkspace>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.UpdatedAt)));
        ImageMasterWorkspaces.Indexes.CreateOne(new CreateIndexModel<ImageMasterWorkspace>(
            Builders<ImageMasterWorkspace>.IndexKeys.Ascending(x => x.MemberUserIds)));

        // ImageGenSizeCaps：为兼容更多 Mongo 版本，拆成两个 unique partial index，避免 partial filter 中出现 $not/$ne null
        // 1) modelId 唯一：仅对存在 ModelId 字段的文档生效（upsert 插入时未设置 ModelId 的字段将不存在）
        try
        {
            ImageGenSizeCaps.Indexes.CreateOne(new CreateIndexModel<ImageGenSizeCaps>(
                Builders<ImageGenSizeCaps>.IndexKeys.Ascending(x => x.ModelId),
                new CreateIndexOptions<ImageGenSizeCaps>
                {
                    Name = "uniq_image_gen_size_caps_modelId",
                    PartialFilterExpression = new BsonDocument("ModelId", new BsonDocument("$exists", true))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // 2) platformId + modelId 唯一（字段名：ModelName）：仅对存在 PlatformId & ModelName 字段的文档生效
        try
        {
            ImageGenSizeCaps.Indexes.CreateOne(new CreateIndexModel<ImageGenSizeCaps>(
                Builders<ImageGenSizeCaps>.IndexKeys
                    .Ascending(x => x.PlatformId)
                    .Ascending(x => x.ModelName),
                new CreateIndexOptions<ImageGenSizeCaps>
                {
                    Name = "uniq_image_gen_size_caps_platformId_modelName",
                    PartialFilterExpression = new BsonDocument
                    {
                        { "PlatformId", new BsonDocument("$exists", true) },
                        { "ModelName", new BsonDocument("$exists", true) }
                    }
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // ImageGenRuns：按 owner + createdAt；worker 取队列时按 status + createdAt
        ImageGenRuns.Indexes.CreateOne(new CreateIndexModel<ImageGenRun>(
            Builders<ImageGenRun>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.CreatedAt)));
        ImageGenRuns.Indexes.CreateOne(new CreateIndexModel<ImageGenRun>(
            Builders<ImageGenRun>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.CreatedAt)));
        // 幂等键：同一 admin 下唯一（只对存在 IdempotencyKey 的文档生效）
        try
        {
            ImageGenRuns.Indexes.CreateOne(new CreateIndexModel<ImageGenRun>(
                Builders<ImageGenRun>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.IdempotencyKey),
                new CreateIndexOptions<ImageGenRun>
                {
                    Name = "uniq_image_gen_runs_owner_idem",
                    // 仅对字符串类型生效：避免 null 字段也命中 partial index，导致同一 admin 只能创建 1 条 run
                    PartialFilterExpression = new BsonDocument("IdempotencyKey", new BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // ImageGenRunItems：按 runId + (itemIndex,imageIndex) 唯一；按 owner + runId 查询
        ImageGenRunItems.Indexes.CreateOne(new CreateIndexModel<ImageGenRunItem>(
            Builders<ImageGenRunItem>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.RunId)));
        try
        {
            ImageGenRunItems.Indexes.CreateOne(new CreateIndexModel<ImageGenRunItem>(
                Builders<ImageGenRunItem>.IndexKeys.Ascending(x => x.RunId).Ascending(x => x.ItemIndex).Ascending(x => x.ImageIndex),
                new CreateIndexOptions<ImageGenRunItem> { Name = "uniq_image_gen_run_items_run_pos" }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // ImageGenRunEvents：按 runId + seq；用于 SSE afterSeq 续传
        ImageGenRunEvents.Indexes.CreateOne(new CreateIndexModel<ImageGenRunEvent>(
            Builders<ImageGenRunEvent>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.RunId)));
        try
        {
            ImageGenRunEvents.Indexes.CreateOne(new CreateIndexModel<ImageGenRunEvent>(
                Builders<ImageGenRunEvent>.IndexKeys.Ascending(x => x.RunId).Ascending(x => x.Seq),
                new CreateIndexOptions<ImageGenRunEvent> { Name = "uniq_image_gen_run_events_run_seq" }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // UploadArtifacts：按 requestId + createdAt；按 requestId + kind；按 sha256（非唯一，仅便于排查）
        UploadArtifacts.Indexes.CreateOne(new CreateIndexModel<UploadArtifact>(
            Builders<UploadArtifact>.IndexKeys.Ascending(x => x.RequestId).Descending(x => x.CreatedAt)));
        UploadArtifacts.Indexes.CreateOne(new CreateIndexModel<UploadArtifact>(
            Builders<UploadArtifact>.IndexKeys.Ascending(x => x.RequestId).Ascending(x => x.Kind).Descending(x => x.CreatedAt)));
        UploadArtifacts.Indexes.CreateOne(new CreateIndexModel<UploadArtifact>(
            Builders<UploadArtifact>.IndexKeys.Ascending(x => x.Sha256).Descending(x => x.CreatedAt)));

        // AdminPromptOverrides：同一管理员 + key 唯一（用于覆盖 system prompt）
        try
        {
            AdminPromptOverrides.Indexes.CreateOne(new CreateIndexModel<AdminPromptOverride>(
                Builders<AdminPromptOverride>.IndexKeys
                    .Ascending(x => x.OwnerAdminId)
                    .Ascending(x => x.Key),
                new CreateIndexOptions<AdminPromptOverride>
                {
                    Name = "uniq_admin_prompt_overrides_owner_key",
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // AdminIdempotencyRecords：同一管理员 + scope + idemKey 唯一（用于写接口幂等，替代 Redis）
        try
        {
            AdminIdempotencyRecords.Indexes.CreateOne(new CreateIndexModel<AdminIdempotencyRecord>(
                Builders<AdminIdempotencyRecord>.IndexKeys
                    .Ascending(x => x.OwnerAdminId)
                    .Ascending(x => x.Scope)
                    .Ascending(x => x.IdempotencyKey),
                new CreateIndexOptions<AdminIdempotencyRecord>
                {
                    // 注意：历史环境可能已存在同名索引，但字段名为 PascalCase（OwnerAdminId/Scope/IdempotencyKey）。
                    // MongoDB 不允许“同名但定义不同”的索引，会导致启动时 createIndexes 直接抛异常并使 API 进程崩溃。
                    // 这里改用新名字，避免冲突；旧索引可后续人工清理。
                    Name = "uniq_admin_idempotency_owner_scope_key_v2",
                    // 仅对字符串类型生效（与 ImageGenRuns 的 idemKey 规则一致）
                    PartialFilterExpression = new BsonDocument("idempotencyKey", new BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        AdminIdempotencyRecords.Indexes.CreateOne(new CreateIndexModel<AdminIdempotencyRecord>(
            Builders<AdminIdempotencyRecord>.IndexKeys.Descending(x => x.CreatedAt)));

        // DesktopAssets：skin/key 允许未来扩展；不强制 unique 以避免因历史脏数据导致启动失败，约束由业务控制
        DesktopAssetSkins.Indexes.CreateOne(new CreateIndexModel<DesktopAssetSkin>(
            Builders<DesktopAssetSkin>.IndexKeys.Ascending(x => x.Name),
            new CreateIndexOptions { Name = "idx_desktop_asset_skins_name" }));
        DesktopAssetSkins.Indexes.CreateOne(new CreateIndexModel<DesktopAssetSkin>(
            Builders<DesktopAssetSkin>.IndexKeys.Ascending(x => x.Enabled),
            new CreateIndexOptions { Name = "idx_desktop_asset_skins_enabled" }));
        DesktopAssetKeys.Indexes.CreateOne(new CreateIndexModel<DesktopAssetKey>(
            Builders<DesktopAssetKey>.IndexKeys.Ascending(x => x.Key),
            new CreateIndexOptions { Name = "idx_desktop_asset_keys_key" }));
        
        // DesktopAssets：实际资源表，Key + Skin 唯一（使用 partial filter 避免 null skin 冲突）
        try
        {
            DesktopAssets.Indexes.CreateOne(new CreateIndexModel<DesktopAsset>(
                Builders<DesktopAsset>.IndexKeys.Ascending(x => x.Key).Ascending(x => x.Skin),
                new CreateIndexOptions<DesktopAsset>
                {
                    Name = "uniq_desktop_assets_key_skin",
                    // 仅对存在 Skin 字段的文档生效（null 视为默认，多个 null 共存）
                    PartialFilterExpression = new BsonDocument("Skin", new BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        // 按 Key 查询所有皮肤的资源（用于回退逻辑）
        DesktopAssets.Indexes.CreateOne(new CreateIndexModel<DesktopAsset>(
            Builders<DesktopAsset>.IndexKeys.Ascending(x => x.Key),
            new CreateIndexOptions { Name = "idx_desktop_assets_key" }));

        // LiteraryPrompts：按 owner + scenarioType + order；按 scenarioType + order（用于全局共享查询）
        LiteraryPrompts.Indexes.CreateOne(new CreateIndexModel<LiteraryPrompt>(
            Builders<LiteraryPrompt>.IndexKeys.Ascending(x => x.OwnerUserId).Ascending(x => x.ScenarioType).Ascending(x => x.Order)));
        LiteraryPrompts.Indexes.CreateOne(new CreateIndexModel<LiteraryPrompt>(
            Builders<LiteraryPrompt>.IndexKeys.Ascending(x => x.ScenarioType).Ascending(x => x.Order)));

        // OpenPlatformApps：按 ApiKeyHash 查询（用于认证）
        OpenPlatformApps.Indexes.CreateOne(new CreateIndexModel<OpenPlatformApp>(
            Builders<OpenPlatformApp>.IndexKeys.Ascending(x => x.ApiKeyHash)));
        OpenPlatformApps.Indexes.CreateOne(new CreateIndexModel<OpenPlatformApp>(
            Builders<OpenPlatformApp>.IndexKeys.Ascending(x => x.BoundUserId)));
        OpenPlatformApps.Indexes.CreateOne(new CreateIndexModel<OpenPlatformApp>(
            Builders<OpenPlatformApp>.IndexKeys.Descending(x => x.CreatedAt)));

        // OpenPlatformRequestLogs：按 appId + startedAt；按 appId + statusCode
        OpenPlatformRequestLogs.Indexes.CreateOne(new CreateIndexModel<OpenPlatformRequestLog>(
            Builders<OpenPlatformRequestLog>.IndexKeys.Ascending(x => x.AppId).Descending(x => x.StartedAt)));
        OpenPlatformRequestLogs.Indexes.CreateOne(new CreateIndexModel<OpenPlatformRequestLog>(
            Builders<OpenPlatformRequestLog>.IndexKeys.Ascending(x => x.AppId).Ascending(x => x.StatusCode)));
        OpenPlatformRequestLogs.Indexes.CreateOne(new CreateIndexModel<OpenPlatformRequestLog>(
            Builders<OpenPlatformRequestLog>.IndexKeys.Descending(x => x.StartedAt)));
        // EndedAt 普通索引（仅用于查询，不自动删除数据）
        OpenPlatformRequestLogs.Indexes.CreateOne(new CreateIndexModel<OpenPlatformRequestLog>(
            Builders<OpenPlatformRequestLog>.IndexKeys.Ascending(x => x.EndedAt)));

        // ModelGroups：按 modelType + isDefaultForType 查询默认分组
        ModelGroups.Indexes.CreateOne(new CreateIndexModel<ModelGroup>(
            Builders<ModelGroup>.IndexKeys.Ascending(x => x.ModelType).Descending(x => x.IsDefaultForType)));
        ModelGroups.Indexes.CreateOne(new CreateIndexModel<ModelGroup>(
            Builders<ModelGroup>.IndexKeys.Descending(x => x.CreatedAt)));

        // LLMAppCallers：按 appCode 唯一
        try
        {
            LLMAppCallers.Indexes.CreateOne(new CreateIndexModel<LLMAppCaller>(
                Builders<LLMAppCaller>.IndexKeys.Ascending(x => x.AppCode),
                new CreateIndexOptions { Name = "uniq_llm_app_callers_app_code" }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        LLMAppCallers.Indexes.CreateOne(new CreateIndexModel<LLMAppCaller>(
            Builders<LLMAppCaller>.IndexKeys.Descending(x => x.LastCalledAt)));

        // WatermarkFontAssets：同一用户 + fontKey 唯一
        try
        {
            WatermarkFontAssets.Indexes.CreateOne(new CreateIndexModel<WatermarkFontAsset>(
                Builders<WatermarkFontAsset>.IndexKeys.Ascending(x => x.OwnerUserId).Ascending(x => x.FontKey),
                new CreateIndexOptions { Unique = true, Name = "uniq_watermark_font_owner_key" }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // WatermarkConfigs：按 userId + appKeys 查询
        WatermarkConfigs.Indexes.CreateOne(new CreateIndexModel<WatermarkConfig>(
            Builders<WatermarkConfig>.IndexKeys.Ascending(x => x.UserId).Descending(x => x.UpdatedAt),
            new CreateIndexOptions { Name = "idx_watermark_configs_user_updated" }));
        WatermarkConfigs.Indexes.CreateOne(new CreateIndexModel<WatermarkConfig>(
            Builders<WatermarkConfig>.IndexKeys.Ascending(x => x.UserId).Ascending(x => x.AppKeys),
            new CreateIndexOptions { Name = "idx_watermark_configs_user_appkeys" }));

        // DefectTemplates：按 isDefault 查询默认模板
        DefectTemplates.Indexes.CreateOne(new CreateIndexModel<DefectTemplate>(
            Builders<DefectTemplate>.IndexKeys.Descending(x => x.IsDefault).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_templates_default" }));

        // DefectReports：按 reporterId + status 查询；按 assigneeId + status 查询
        DefectReports.Indexes.CreateOne(new CreateIndexModel<DefectReport>(
            Builders<DefectReport>.IndexKeys.Ascending(x => x.ReporterId).Ascending(x => x.Status).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_reports_reporter_status" }));
        DefectReports.Indexes.CreateOne(new CreateIndexModel<DefectReport>(
            Builders<DefectReport>.IndexKeys.Ascending(x => x.AssigneeId).Ascending(x => x.Status).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_reports_assignee_status" }));
        DefectReports.Indexes.CreateOne(new CreateIndexModel<DefectReport>(
            Builders<DefectReport>.IndexKeys.Ascending(x => x.Status).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_reports_status" }));
        // defectNo 唯一
        try
        {
            DefectReports.Indexes.CreateOne(new CreateIndexModel<DefectReport>(
                Builders<DefectReport>.IndexKeys.Ascending(x => x.DefectNo),
                new CreateIndexOptions<DefectReport>
                {
                    Name = "uniq_defect_reports_no",
                    Unique = true,
                    PartialFilterExpression = new BsonDocument("DefectNo", new BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // DefectMessages：按 defectId + seq 查询
        DefectMessages.Indexes.CreateOne(new CreateIndexModel<DefectMessage>(
            Builders<DefectMessage>.IndexKeys.Ascending(x => x.DefectId).Ascending(x => x.Seq),
            new CreateIndexOptions { Name = "idx_defect_messages_defect_seq" }));

        // DefectReports：按 projectId + status 查询
        DefectReports.Indexes.CreateOne(new CreateIndexModel<DefectReport>(
            Builders<DefectReport>.IndexKeys.Ascending(x => x.ProjectId).Ascending(x => x.Status).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_reports_project" }));
        // DefectReports：按 teamId + status 查询
        DefectReports.Indexes.CreateOne(new CreateIndexModel<DefectReport>(
            Builders<DefectReport>.IndexKeys.Ascending(x => x.TeamId).Ascending(x => x.Status).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_reports_team" }));

        // DefectProjects：按 key 唯一索引，按 ownerUserId 查询
        try
        {
            DefectProjects.Indexes.CreateOne(new CreateIndexModel<DefectProject>(
                Builders<DefectProject>.IndexKeys.Ascending(x => x.Key),
                new CreateIndexOptions
                {
                    Name = "uniq_defect_projects_key",
                    Unique = true
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        DefectProjects.Indexes.CreateOne(new CreateIndexModel<DefectProject>(
            Builders<DefectProject>.IndexKeys.Ascending(x => x.OwnerUserId),
            new CreateIndexOptions { Name = "idx_defect_projects_owner" }));

        // DefectWebhookConfigs：按 teamId + projectId 查询
        DefectWebhookConfigs.Indexes.CreateOne(new CreateIndexModel<DefectWebhookConfig>(
            Builders<DefectWebhookConfig>.IndexKeys.Ascending(x => x.TeamId).Ascending(x => x.ProjectId),
            new CreateIndexOptions { Name = "idx_defect_webhooks_team_project" }));

        // DefectShareLinks：Token 唯一索引
        DefectShareLinks.Indexes.CreateOne(new CreateIndexModel<DefectShareLink>(
            Builders<DefectShareLink>.IndexKeys.Ascending(x => x.Token),
            new CreateIndexOptions { Name = "uniq_defect_share_links_token", Unique = true }));
        DefectShareLinks.Indexes.CreateOne(new CreateIndexModel<DefectShareLink>(
            Builders<DefectShareLink>.IndexKeys.Ascending(x => x.CreatedBy).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_share_links_creator" }));

        // DefectFixReports：按分享链接和 Token 查询
        DefectFixReports.Indexes.CreateOne(new CreateIndexModel<DefectFixReport>(
            Builders<DefectFixReport>.IndexKeys.Ascending(x => x.ShareLinkId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_defect_fix_reports_share" }));
        DefectFixReports.Indexes.CreateOne(new CreateIndexModel<DefectFixReport>(
            Builders<DefectFixReport>.IndexKeys.Ascending(x => x.ShareToken),
            new CreateIndexOptions { Name = "idx_defect_fix_reports_token" }));

        // PR Review V2（pr-review）：按 UserId 查询，同一用户同仓库同 PR 去重
        // 索引由 DBA 手动创建（遵循 no-auto-index 规则），这里仅作定义参考：
        //   github_user_connections:  (UserId) unique
        //   pr_review_items:          (UserId, UpdatedAt desc)
        //   pr_review_items:          (UserId, Owner, Repo, Number) unique

        // ========== Channel Adapter 多通道适配器索引 ==========

        // ChannelWhitelists：按 channelType + identifierPattern 查询；按 isActive + priority 排序
        ChannelWhitelists.Indexes.CreateOne(new CreateIndexModel<ChannelWhitelist>(
            Builders<ChannelWhitelist>.IndexKeys.Ascending(x => x.ChannelType).Ascending(x => x.IdentifierPattern),
            new CreateIndexOptions { Name = "idx_channel_whitelist_type_pattern" }));
        ChannelWhitelists.Indexes.CreateOne(new CreateIndexModel<ChannelWhitelist>(
            Builders<ChannelWhitelist>.IndexKeys.Ascending(x => x.IsActive).Ascending(x => x.Priority),
            new CreateIndexOptions { Name = "idx_channel_whitelist_active_priority" }));
        ChannelWhitelists.Indexes.CreateOne(new CreateIndexModel<ChannelWhitelist>(
            Builders<ChannelWhitelist>.IndexKeys.Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_whitelist_created" }));

        // ChannelIdentityMappings：按 channelType + channelIdentifier 唯一
        try
        {
            ChannelIdentityMappings.Indexes.CreateOne(new CreateIndexModel<ChannelIdentityMapping>(
                Builders<ChannelIdentityMapping>.IndexKeys.Ascending(x => x.ChannelType).Ascending(x => x.ChannelIdentifier),
                new CreateIndexOptions
                {
                    Name = "uniq_channel_identity_type_identifier",
                    Unique = true
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        ChannelIdentityMappings.Indexes.CreateOne(new CreateIndexModel<ChannelIdentityMapping>(
            Builders<ChannelIdentityMapping>.IndexKeys.Ascending(x => x.UserId),
            new CreateIndexOptions { Name = "idx_channel_identity_user" }));

        // ChannelTasks：按 status + createdAt 查询；按 senderIdentifier + createdAt 查询
        ChannelTasks.Indexes.CreateOne(new CreateIndexModel<ChannelTask>(
            Builders<ChannelTask>.IndexKeys.Ascending(x => x.Status).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_tasks_status_created" }));
        ChannelTasks.Indexes.CreateOne(new CreateIndexModel<ChannelTask>(
            Builders<ChannelTask>.IndexKeys.Ascending(x => x.ChannelType).Ascending(x => x.SenderIdentifier).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_tasks_type_sender_created" }));
        ChannelTasks.Indexes.CreateOne(new CreateIndexModel<ChannelTask>(
            Builders<ChannelTask>.IndexKeys.Ascending(x => x.MappedUserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_tasks_user_created" }));
        // CreatedAt 普通索引（仅用于查询，不自动删除数据）
        ChannelTasks.Indexes.CreateOne(new CreateIndexModel<ChannelTask>(
            Builders<ChannelTask>.IndexKeys.Ascending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_tasks_created" }));

        // ChannelRequestLogs：按 channelType + createdAt 查询；按 mappedUserId + createdAt 查询
        ChannelRequestLogs.Indexes.CreateOne(new CreateIndexModel<ChannelRequestLog>(
            Builders<ChannelRequestLog>.IndexKeys.Ascending(x => x.ChannelType).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_request_logs_type_created" }));
        ChannelRequestLogs.Indexes.CreateOne(new CreateIndexModel<ChannelRequestLog>(
            Builders<ChannelRequestLog>.IndexKeys.Ascending(x => x.MappedUserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_channel_request_logs_user_created" }));
        ChannelRequestLogs.Indexes.CreateOne(new CreateIndexModel<ChannelRequestLog>(
            Builders<ChannelRequestLog>.IndexKeys.Ascending(x => x.TaskId),
            new CreateIndexOptions { Name = "idx_channel_request_logs_task" }));
        // EndedAt 普通索引（仅用于查询，不自动删除数据）
        ChannelRequestLogs.Indexes.CreateOne(new CreateIndexModel<ChannelRequestLog>(
            Builders<ChannelRequestLog>.IndexKeys.Ascending(x => x.EndedAt),
            new CreateIndexOptions { Name = "idx_channel_request_logs_ended" }));
        // ========== Apple Shortcuts 快捷指令索引 ==========

        // UserShortcuts：按 tokenHash 唯一索引（token 校验）；按 userId 查询
        try
        {
            UserShortcuts.Indexes.CreateOne(new CreateIndexModel<UserShortcut>(
                Builders<UserShortcut>.IndexKeys.Ascending(x => x.TokenHash),
                new CreateIndexOptions { Name = "uniq_user_shortcuts_token_hash", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        UserShortcuts.Indexes.CreateOne(new CreateIndexModel<UserShortcut>(
            Builders<UserShortcut>.IndexKeys.Ascending(x => x.UserId),
            new CreateIndexOptions { Name = "idx_user_shortcuts_user" }));

        // UserCollections：按 userId + createdAt 查询
        UserCollections.Indexes.CreateOne(new CreateIndexModel<UserCollection>(
            Builders<UserCollection>.IndexKeys.Ascending(x => x.UserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_user_collections_user_created" }));

        // ShortcutTemplates：按 isDefault + isActive 查询
        ShortcutTemplates.Indexes.CreateOne(new CreateIndexModel<ShortcutTemplate>(
            Builders<ShortcutTemplate>.IndexKeys.Ascending(x => x.IsDefault).Ascending(x => x.IsActive),
            new CreateIndexOptions { Name = "idx_shortcut_templates_default_active" }));

        // ToolboxRuns：按 userId + createdAt 查询；按 status + createdAt 查询
        ToolboxRuns.Indexes.CreateOne(new CreateIndexModel<ToolboxRun>(
            Builders<ToolboxRun>.IndexKeys.Ascending(x => x.UserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_toolbox_runs_user_created" }));
        ToolboxRuns.Indexes.CreateOne(new CreateIndexModel<ToolboxRun>(
            Builders<ToolboxRun>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_toolbox_runs_status_created" }));

        // ========== Webhook 通知投递日志索引 ==========

        // WebhookDeliveryLogs：按 appId + createdAt 查询
        WebhookDeliveryLogs.Indexes.CreateOne(new CreateIndexModel<WebhookDeliveryLog>(
            Builders<WebhookDeliveryLog>.IndexKeys.Ascending(x => x.AppId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_webhook_delivery_logs_app_created" }));
        // CreatedAt 普通索引（仅用于查询，不自动删除数据）
        WebhookDeliveryLogs.Indexes.CreateOne(new CreateIndexModel<WebhookDeliveryLog>(
            Builders<WebhookDeliveryLog>.IndexKeys.Ascending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_webhook_delivery_logs_created" }));

        // AutomationRules: 按事件类型 + 启用状态索引
        AutomationRules.Indexes.CreateOne(new CreateIndexModel<AutomationRule>(
            Builders<AutomationRule>.IndexKeys.Ascending(x => x.EventType).Ascending(x => x.Enabled),
            new CreateIndexOptions { Name = "idx_automation_rules_event_enabled" }));
        // AutomationRules: 按 HookId 唯一索引（传入 Webhook 查询）
        AutomationRules.Indexes.CreateOne(new CreateIndexModel<AutomationRule>(
            Builders<AutomationRule>.IndexKeys.Ascending(x => x.HookId),
            new CreateIndexOptions { Name = "idx_automation_rules_hook_id", Sparse = true }));
        // ToolboxItems：按 createdByUserId 查询
        ToolboxItems.Indexes.CreateOne(new CreateIndexModel<ToolboxItem>(
            Builders<ToolboxItem>.IndexKeys.Ascending(x => x.CreatedByUserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_toolbox_items_user_created" }));
        // ToolboxItems：市场公开列表
        ToolboxItems.Indexes.CreateOne(new CreateIndexModel<ToolboxItem>(
            Builders<ToolboxItem>.IndexKeys.Ascending(x => x.IsPublic).Descending(x => x.ForkCount),
            new CreateIndexOptions { Name = "idx_toolbox_items_public_forkcount" }));
        // ToolboxSessions：按 (userId, itemId, lastActiveAt) 查询
        ToolboxSessions.Indexes.CreateOne(new CreateIndexModel<ToolboxSession>(
            Builders<ToolboxSession>.IndexKeys.Ascending(x => x.UserId).Ascending(x => x.ItemId).Descending(x => x.LastActiveAt),
            new CreateIndexOptions { Name = "idx_toolbox_sessions_user_item_active" }));
        // ToolboxMessages：按 sessionId + createdAt 查询
        ToolboxMessages.Indexes.CreateOne(new CreateIndexModel<ToolboxMessage>(
            Builders<ToolboxMessage>.IndexKeys.Ascending(x => x.SessionId).Ascending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_toolbox_messages_session_created" }));

        // ========== Workflow Agent 工作流引擎索引 ==========

        // Workflows：按创建者 + 更新时间查询
        Workflows.Indexes.CreateOne(new CreateIndexModel<Workflow>(
            Builders<Workflow>.IndexKeys.Ascending(x => x.CreatedBy).Descending(x => x.UpdatedAt),
            new CreateIndexOptions { Name = "idx_workflows_creator_updated" }));
        Workflows.Indexes.CreateOne(new CreateIndexModel<Workflow>(
            Builders<Workflow>.IndexKeys.Ascending(x => x.IsPublic).Descending(x => x.ForkCount),
            new CreateIndexOptions { Name = "idx_workflows_public_forkcount" }));

        // WorkflowExecutions：按工作流ID + 创建时间；按状态 + 创建时间
        WorkflowExecutions.Indexes.CreateOne(new CreateIndexModel<WorkflowExecution>(
            Builders<WorkflowExecution>.IndexKeys.Ascending(x => x.WorkflowId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_workflow_executions_workflow_created" }));
        WorkflowExecutions.Indexes.CreateOne(new CreateIndexModel<WorkflowExecution>(
            Builders<WorkflowExecution>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_workflow_executions_status_created" }));
        WorkflowExecutions.Indexes.CreateOne(new CreateIndexModel<WorkflowExecution>(
            Builders<WorkflowExecution>.IndexKeys.Ascending(x => x.TriggeredBy).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_workflow_executions_trigger_created" }));

        // WorkflowSchedules：Worker 轮询（启用 + 下次执行时间）
        WorkflowSchedules.Indexes.CreateOne(new CreateIndexModel<WorkflowSchedule>(
            Builders<WorkflowSchedule>.IndexKeys.Ascending(x => x.IsEnabled).Ascending(x => x.NextRunAt),
            new CreateIndexOptions { Name = "idx_workflow_schedules_enabled_nextrun" }));
        WorkflowSchedules.Indexes.CreateOne(new CreateIndexModel<WorkflowSchedule>(
            Builders<WorkflowSchedule>.IndexKeys.Ascending(x => x.WorkflowId),
            new CreateIndexOptions { Name = "idx_workflow_schedules_workflow" }));

        // WorkflowSecrets：按工作流ID + Key 唯一
        try
        {
            WorkflowSecrets.Indexes.CreateOne(new CreateIndexModel<WorkflowSecret>(
                Builders<WorkflowSecret>.IndexKeys.Ascending(x => x.WorkflowId).Ascending(x => x.Key),
                new CreateIndexOptions { Name = "uniq_workflow_secrets_workflow_key", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // ShareLinks：按 Token 唯一
        try
        {
            ShareLinks.Indexes.CreateOne(new CreateIndexModel<ShareLink>(
                Builders<ShareLink>.IndexKeys.Ascending(x => x.Token),
                new CreateIndexOptions { Name = "uniq_share_links_token", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        ShareLinks.Indexes.CreateOne(new CreateIndexModel<ShareLink>(
            Builders<ShareLink>.IndexKeys.Ascending(x => x.CreatedBy).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_share_links_creator_created" }));
        ShareLinks.Indexes.CreateOne(new CreateIndexModel<ShareLink>(
            Builders<ShareLink>.IndexKeys.Ascending(x => x.ResourceType).Ascending(x => x.ResourceId),
            new CreateIndexOptions { Name = "idx_share_links_resource" }));

        // Skills：SkillKey 唯一索引
        try
        {
            Skills.Indexes.CreateOne(new CreateIndexModel<Skill>(
                Builders<Skill>.IndexKeys.Ascending(x => x.SkillKey),
                new CreateIndexOptions { Name = "uniq_skills_skill_key", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        // Skills：按可见性 + 角色 + 启用状态查询
        Skills.Indexes.CreateOne(new CreateIndexModel<Skill>(
            Builders<Skill>.IndexKeys.Ascending(x => x.Visibility).Ascending(x => x.IsEnabled).Ascending(x => x.Order),
            new CreateIndexOptions { Name = "idx_skills_visibility_enabled_order" }));
        // Skills：个人技能按用户查询
        Skills.Indexes.CreateOne(new CreateIndexModel<Skill>(
            Builders<Skill>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.UpdatedAt),
            new CreateIndexOptions { Name = "idx_skills_owner_updated" }));

        // ModelExchanges：按 ModelAlias 唯一索引
        try
        {
            ModelExchanges.Indexes.CreateOne(new CreateIndexModel<ModelExchange>(
                Builders<ModelExchange>.IndexKeys.Ascending(x => x.ModelAlias),
                new CreateIndexOptions
                {
                    Name = "uniq_exchange_model_alias",
                    Unique = true
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // ========== Tutorial Email 教程邮件索引 ==========

        // TutorialEmailSequences：按 sequenceKey 唯一
        try
        {
            TutorialEmailSequences.Indexes.CreateOne(new CreateIndexModel<TutorialEmailSequence>(
                Builders<TutorialEmailSequence>.IndexKeys.Ascending(x => x.SequenceKey),
                new CreateIndexOptions { Name = "uniq_tutorial_email_sequences_key", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // TutorialEmailTemplates：按 createdAt 排序
        TutorialEmailTemplates.Indexes.CreateOne(new CreateIndexModel<TutorialEmailTemplate>(
            Builders<TutorialEmailTemplate>.IndexKeys.Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_tutorial_email_templates_created" }));

        // TutorialEmailAssets：按 uploadedAt 排序；按 tags 多值索引
        TutorialEmailAssets.Indexes.CreateOne(new CreateIndexModel<TutorialEmailAsset>(
            Builders<TutorialEmailAsset>.IndexKeys.Descending(x => x.UploadedAt),
            new CreateIndexOptions { Name = "idx_tutorial_email_assets_uploaded" }));
        TutorialEmailAssets.Indexes.CreateOne(new CreateIndexModel<TutorialEmailAsset>(
            Builders<TutorialEmailAsset>.IndexKeys.Ascending(x => x.Tags),
            new CreateIndexOptions { Name = "idx_tutorial_email_assets_tags" }));

        // TutorialEmailEnrollments：按 status + nextSendAt（Worker 轮询）；按 userId + sequenceKey 唯一
        TutorialEmailEnrollments.Indexes.CreateOne(new CreateIndexModel<TutorialEmailEnrollment>(
            Builders<TutorialEmailEnrollment>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.NextSendAt),
            new CreateIndexOptions { Name = "idx_tutorial_email_enrollments_status_next" }));
        try
        {
            TutorialEmailEnrollments.Indexes.CreateOne(new CreateIndexModel<TutorialEmailEnrollment>(
                Builders<TutorialEmailEnrollment>.IndexKeys.Ascending(x => x.UserId).Ascending(x => x.SequenceKey),
                new CreateIndexOptions { Name = "uniq_tutorial_email_enrollments_user_seq", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // ========== Report Agent 周报管理索引 ==========

        // ReportTeams：按 LeaderUserId 查询
        ReportTeams.Indexes.CreateOne(new CreateIndexModel<ReportTeam>(
            Builders<ReportTeam>.IndexKeys.Ascending(x => x.LeaderUserId),
            new CreateIndexOptions { Name = "idx_report_teams_leader" }));

        // ReportTeamMembers：(TeamId, UserId) 唯一；按 UserId 查询
        try
        {
            ReportTeamMembers.Indexes.CreateOne(new CreateIndexModel<ReportTeamMember>(
                Builders<ReportTeamMember>.IndexKeys.Ascending(x => x.TeamId).Ascending(x => x.UserId),
                new CreateIndexOptions { Name = "uniq_report_team_members_team_user", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        ReportTeamMembers.Indexes.CreateOne(new CreateIndexModel<ReportTeamMember>(
            Builders<ReportTeamMember>.IndexKeys.Ascending(x => x.UserId),
            new CreateIndexOptions { Name = "idx_report_team_members_user" }));

        // ReportTemplates：按 IsDefault + CreatedAt 查询默认模板
        ReportTemplates.Indexes.CreateOne(new CreateIndexModel<ReportTemplate>(
            Builders<ReportTemplate>.IndexKeys.Descending(x => x.IsDefault).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_report_templates_default" }));

        // WeeklyReports：(UserId, TeamId, WeekYear, WeekNumber) 唯一，防止重复周报
        try
        {
            WeeklyReports.Indexes.CreateOne(new CreateIndexModel<WeeklyReport>(
                Builders<WeeklyReport>.IndexKeys
                    .Ascending(x => x.UserId)
                    .Ascending(x => x.TeamId)
                    .Ascending(x => x.WeekYear)
                    .Ascending(x => x.WeekNumber),
                new CreateIndexOptions { Name = "uniq_weekly_reports_user_team_week", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        // WeeklyReports：按 TeamId + Status + PeriodEnd 查询团队周报
        WeeklyReports.Indexes.CreateOne(new CreateIndexModel<WeeklyReport>(
            Builders<WeeklyReport>.IndexKeys.Ascending(x => x.TeamId).Ascending(x => x.Status).Descending(x => x.PeriodEnd),
            new CreateIndexOptions { Name = "idx_weekly_reports_team_status" }));
        // WeeklyReports：按 UserId + PeriodEnd 查询个人周报
        WeeklyReports.Indexes.CreateOne(new CreateIndexModel<WeeklyReport>(
            Builders<WeeklyReport>.IndexKeys.Ascending(x => x.UserId).Descending(x => x.PeriodEnd),
            new CreateIndexOptions { Name = "idx_weekly_reports_user_period" }));

        // ReportDailyLogs：(UserId, Date) 唯一，一天一条
        try
        {
            ReportDailyLogs.Indexes.CreateOne(new CreateIndexModel<ReportDailyLog>(
                Builders<ReportDailyLog>.IndexKeys.Ascending(x => x.UserId).Ascending(x => x.Date),
                new CreateIndexOptions { Unique = true, Name = "idx_daily_logs_user_date" }));
        }
        catch (MongoCommandException) { /* 索引已存在 */ }

        // ReportDataSources：按 TeamId 查询
        ReportDataSources.Indexes.CreateOne(new CreateIndexModel<ReportDataSource>(
            Builders<ReportDataSource>.IndexKeys.Ascending(x => x.TeamId),
            new CreateIndexOptions { Name = "idx_data_sources_team" }));

        // ReportCommits：(DataSourceId, CommitHash) 唯一，幂等同步
        try
        {
            ReportCommits.Indexes.CreateOne(new CreateIndexModel<ReportCommit>(
                Builders<ReportCommit>.IndexKeys.Ascending(x => x.DataSourceId).Ascending(x => x.CommitHash),
                new CreateIndexOptions { Unique = true, Name = "idx_commits_source_hash" }));
        }
        catch (MongoCommandException) { /* 索引已存在 */ }

        // ReportCommits：按 MappedUserId + CommittedAt 查询用户一周提交
        ReportCommits.Indexes.CreateOne(new CreateIndexModel<ReportCommit>(
            Builders<ReportCommit>.IndexKeys.Ascending(x => x.MappedUserId).Descending(x => x.CommittedAt),
            new CreateIndexOptions { Name = "idx_commits_user_date" }));

        // ReportComments：按 (ReportId, SectionIndex) 查询段落评论
        ReportComments.Indexes.CreateOne(new CreateIndexModel<ReportComment>(
            Builders<ReportComment>.IndexKeys.Ascending(x => x.ReportId).Ascending(x => x.SectionIndex),
            new CreateIndexOptions { Name = "idx_report_comments_report_section" }));
        // ReportComments：按 ParentCommentId 查询回复
        ReportComments.Indexes.CreateOne(new CreateIndexModel<ReportComment>(
            Builders<ReportComment>.IndexKeys.Ascending(x => x.ParentCommentId),
            new CreateIndexOptions { Name = "idx_report_comments_parent" }));

        // ReportLikes：(ReportId, UserId) 唯一，防重复点赞
        try
        {
            ReportLikes.Indexes.CreateOne(new CreateIndexModel<ReportLike>(
                Builders<ReportLike>.IndexKeys.Ascending(x => x.ReportId).Ascending(x => x.UserId),
                new CreateIndexOptions { Name = "uniq_report_likes_report_user", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        // ReportLikes：按 ReportId + CreatedAt 查询点赞用户
        ReportLikes.Indexes.CreateOne(new CreateIndexModel<ReportLike>(
            Builders<ReportLike>.IndexKeys.Ascending(x => x.ReportId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_report_likes_report_created" }));

        // ReportViewEvents：按 ReportId + ViewedAt 查询浏览轨迹
        ReportViewEvents.Indexes.CreateOne(new CreateIndexModel<ReportViewEvent>(
            Builders<ReportViewEvent>.IndexKeys.Ascending(x => x.ReportId).Descending(x => x.ViewedAt),
            new CreateIndexOptions { Name = "idx_report_views_report_viewed" }));
        // ReportViewEvents：按 ReportId + UserId + ViewedAt 统计单用户浏览次数
        ReportViewEvents.Indexes.CreateOne(new CreateIndexModel<ReportViewEvent>(
            Builders<ReportViewEvent>.IndexKeys
                .Ascending(x => x.ReportId)
                .Ascending(x => x.UserId)
                .Descending(x => x.ViewedAt),
            new CreateIndexOptions { Name = "idx_report_views_report_user_viewed" }));

        // ReportTeamSummaries：(TeamId, WeekYear, WeekNumber) 唯一
        try
        {
            ReportTeamSummaries.Indexes.CreateOne(new CreateIndexModel<TeamSummary>(
                Builders<TeamSummary>.IndexKeys.Ascending(x => x.TeamId).Ascending(x => x.WeekYear).Ascending(x => x.WeekNumber),
                new CreateIndexOptions { Unique = true, Name = "idx_team_summaries_team_week" }));
        }
        catch (MongoCommandException) { /* 索引已存在 */ }

        // PersonalSources：(UserId, SourceType) 组合查询；按 UserId 查询
        PersonalSources.Indexes.CreateOne(new CreateIndexModel<PersonalSource>(
            Builders<PersonalSource>.IndexKeys.Ascending(x => x.UserId).Ascending(x => x.SourceType),
            new CreateIndexOptions { Name = "idx_personal_sources_user_type" }));

        // Arena 竞技场索引
        try
        {
            ArenaGroups.Indexes.CreateOne(new CreateIndexModel<ArenaGroup>(
                Builders<ArenaGroup>.IndexKeys.Ascending(x => x.Key),
                new CreateIndexOptions { Name = "uniq_arena_groups_key", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        ArenaSlots.Indexes.CreateOne(new CreateIndexModel<ArenaSlot>(
            Builders<ArenaSlot>.IndexKeys.Ascending(x => x.Group).Ascending(x => x.SortOrder),
            new CreateIndexOptions { Name = "idx_arena_slots_group_sort" }));
        ArenaBattles.Indexes.CreateOne(new CreateIndexModel<ArenaBattle>(
            Builders<ArenaBattle>.IndexKeys.Ascending(x => x.UserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_arena_battles_user_created" }));

        // ========== Hosted Sites 网页托管索引 ==========

        // HostedSites：按用户 + 创建时间查询
        HostedSites.Indexes.CreateOne(new CreateIndexModel<HostedSite>(
            Builders<HostedSite>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_hosted_sites_owner_created" }));
        // HostedSites：按标签多值索引
        HostedSites.Indexes.CreateOne(new CreateIndexModel<HostedSite>(
            Builders<HostedSite>.IndexKeys.Ascending(x => x.Tags),
            new CreateIndexOptions { Name = "idx_hosted_sites_tags" }));
        // HostedSites：按来源类型查询
        HostedSites.Indexes.CreateOne(new CreateIndexModel<HostedSite>(
            Builders<HostedSite>.IndexKeys.Ascending(x => x.OwnerUserId).Ascending(x => x.SourceType),
            new CreateIndexOptions { Name = "idx_hosted_sites_owner_source" }));
        // HostedSites：按文件夹查询
        HostedSites.Indexes.CreateOne(new CreateIndexModel<HostedSite>(
            Builders<HostedSite>.IndexKeys.Ascending(x => x.OwnerUserId).Ascending(x => x.Folder),
            new CreateIndexOptions { Name = "idx_hosted_sites_owner_folder" }));

        // WebPageShareLinks：按 Token 唯一
        try
        {
            WebPageShareLinks.Indexes.CreateOne(new CreateIndexModel<WebPageShareLink>(
                Builders<WebPageShareLink>.IndexKeys.Ascending(x => x.Token),
                new CreateIndexOptions { Name = "uniq_web_page_share_links_token", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        // WebPageShareLinks：按创建者 + 时间
        WebPageShareLinks.Indexes.CreateOne(new CreateIndexModel<WebPageShareLink>(
            Builders<WebPageShareLink>.IndexKeys.Ascending(x => x.CreatedBy).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_web_page_share_links_creator_created" }));

        // ShareViewLogs：按分享所有者 + 时间（用于分享管理查看记录）
        ShareViewLogs.Indexes.CreateOne(new CreateIndexModel<ShareViewLog>(
            Builders<ShareViewLog>.IndexKeys.Ascending(x => x.ShareOwnerUserId).Descending(x => x.ViewedAt),
            new CreateIndexOptions { Name = "idx_share_view_logs_owner_viewed" }));
        // ShareViewLogs：按 Token + 时间
        ShareViewLogs.Indexes.CreateOne(new CreateIndexModel<ShareViewLog>(
            Builders<ShareViewLog>.IndexKeys.Ascending(x => x.ShareToken).Descending(x => x.ViewedAt),
            new CreateIndexOptions { Name = "idx_share_view_logs_token_viewed" }));

        // ========== Desktop 更新加速缓存索引 ==========

        // DesktopUpdateCaches：(Version, Target) 唯一
        try
        {
            DesktopUpdateCaches.Indexes.CreateOne(new CreateIndexModel<DesktopUpdateCache>(
                Builders<DesktopUpdateCache>.IndexKeys.Ascending(x => x.Version).Ascending(x => x.Target),
                new CreateIndexOptions { Name = "uniq_desktop_update_caches_version_target", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
        DesktopUpdateCaches.Indexes.CreateOne(new CreateIndexModel<DesktopUpdateCache>(
            Builders<DesktopUpdateCache>.IndexKeys.Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_desktop_update_caches_created" }));

        // ========== 作品投稿展示索引 ==========

        // Submissions：公开作品列表（按类型 + 时间排序）
        Submissions.Indexes.CreateOne(new CreateIndexModel<Submission>(
            Builders<Submission>.IndexKeys
                .Ascending(x => x.IsPublic)
                .Ascending(x => x.ContentType)
                .Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_submissions_public_type_created" }));

        // Submissions：按 OwnerUserId 查询
        Submissions.Indexes.CreateOne(new CreateIndexModel<Submission>(
            Builders<Submission>.IndexKeys.Ascending(x => x.OwnerUserId),
            new CreateIndexOptions { Name = "idx_submissions_owner" }));

        // Submissions：按 ImageAssetId 唯一（防重复投稿同一图片）
        try
        {
            Submissions.Indexes.CreateOne(new CreateIndexModel<Submission>(
                Builders<Submission>.IndexKeys.Ascending(x => x.ImageAssetId),
                new CreateIndexOptions<Submission>
                {
                    Name = "uniq_submissions_image_asset",
                    Unique = true,
                    PartialFilterExpression = new MongoDB.Bson.BsonDocument("ImageAssetId", new MongoDB.Bson.BsonDocument("$type", "string"))
                }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }

        // SubmissionLikes：(SubmissionId + UserId) 唯一
        try
        {
            SubmissionLikes.Indexes.CreateOne(new CreateIndexModel<SubmissionLike>(
                Builders<SubmissionLike>.IndexKeys.Ascending(x => x.SubmissionId).Ascending(x => x.UserId),
                new CreateIndexOptions { Name = "uniq_submission_likes_sid_uid", Unique = true }));
        }
        catch (MongoCommandException ex) when (IsIndexConflict(ex))
        {
            // ignore
        }
    }
}
