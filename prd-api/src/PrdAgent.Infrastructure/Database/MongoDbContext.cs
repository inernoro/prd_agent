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
        
        // 创建索引
        CreateIndexes();
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
    /// <summary>
    /// Prompts 配置（集合名保持 promptstages 以兼容历史数据；语义已迁移为“提示词”）
    /// </summary>
    public IMongoCollection<PromptSettings> Prompts => _database.GetCollection<PromptSettings>("promptstages");
    /// <summary>
    /// promptstages 原始集合（用于兼容旧结构迁移，避免 POCO 映射丢字段）
    /// </summary>
    public IMongoCollection<BsonDocument> PromptsRaw => _database.GetCollection<BsonDocument>("promptstages");
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
    public IMongoCollection<LiteraryPrompt> LiteraryPrompts => _database.GetCollection<LiteraryPrompt>("literary_prompts");
    public IMongoCollection<OpenPlatformApp> OpenPlatformApps => _database.GetCollection<OpenPlatformApp>("openplatformapps");
    public IMongoCollection<OpenPlatformRequestLog> OpenPlatformRequestLogs => _database.GetCollection<OpenPlatformRequestLog>("openplatformrequestlogs");
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

    // Literary Agent 文学创作配置
    public IMongoCollection<LiteraryAgentConfig> LiteraryAgentConfigs => _database.GetCollection<LiteraryAgentConfig>("literary_agent_configs");
    public IMongoCollection<ReferenceImageConfig> ReferenceImageConfigs => _database.GetCollection<ReferenceImageConfig>("reference_image_configs");

    // Defect Agent 缺陷管理
    public IMongoCollection<DefectTemplate> DefectTemplates => _database.GetCollection<DefectTemplate>("defect_templates");
    public IMongoCollection<DefectReport> DefectReports => _database.GetCollection<DefectReport>("defect_reports");
    public IMongoCollection<DefectMessage> DefectMessages => _database.GetCollection<DefectMessage>("defect_messages");
    public IMongoCollection<DefectFolder> DefectFolders => _database.GetCollection<DefectFolder>("defect_folders");

    // AI Toolbox 百宝箱
    public IMongoCollection<ToolboxRun> ToolboxRuns => _database.GetCollection<ToolboxRun>("toolbox_runs");

    private void CreateIndexes()
    {
        static bool IsIndexConflict(MongoCommandException ex)
            => ex.CodeName is "IndexOptionsConflict" or "IndexKeySpecsConflict" or "IndexAlreadyExists";

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

        // TTL（默认保留 7 天）：基于 EndedAt
        LlmRequestLogs.Indexes.CreateOne(new CreateIndexModel<LlmRequestLog>(
            Builders<LlmRequestLog>.IndexKeys.Ascending(l => l.EndedAt),
            new CreateIndexOptions { ExpireAfter = TimeSpan.FromDays(7) }));

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

        // TTL（默认保留 7 天）：基于 EndedAt
        ApiRequestLogs.Indexes.CreateOne(new CreateIndexModel<ApiRequestLog>(
            Builders<ApiRequestLog>.IndexKeys.Ascending(x => x.EndedAt),
            new CreateIndexOptions { ExpireAfter = TimeSpan.FromDays(7) }));

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
        // TTL（默认保留 30 天）：基于 EndedAt
        OpenPlatformRequestLogs.Indexes.CreateOne(new CreateIndexModel<OpenPlatformRequestLog>(
            Builders<OpenPlatformRequestLog>.IndexKeys.Ascending(x => x.EndedAt),
            new CreateIndexOptions { ExpireAfter = TimeSpan.FromDays(30) }));

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

        // ToolboxRuns：按 userId + createdAt 查询；按 status + createdAt 查询
        ToolboxRuns.Indexes.CreateOne(new CreateIndexModel<ToolboxRun>(
            Builders<ToolboxRun>.IndexKeys.Ascending(x => x.UserId).Descending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_toolbox_runs_user_created" }));
        ToolboxRuns.Indexes.CreateOne(new CreateIndexModel<ToolboxRun>(
            Builders<ToolboxRun>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.CreatedAt),
            new CreateIndexOptions { Name = "idx_toolbox_runs_status_created" }));
    }
}
