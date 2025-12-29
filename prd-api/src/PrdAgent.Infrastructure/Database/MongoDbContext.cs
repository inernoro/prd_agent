using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// MongoDB数据库上下文
/// </summary>
public class MongoDbContext
{
    private readonly IMongoDatabase _database;

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
    public IMongoCollection<Message> Messages => _database.GetCollection<Message>("messages");
    public IMongoCollection<ContentGap> ContentGaps => _database.GetCollection<ContentGap>("contentgaps");
    public IMongoCollection<Attachment> Attachments => _database.GetCollection<Attachment>("attachments");
    public IMongoCollection<LLMConfig> LLMConfigs => _database.GetCollection<LLMConfig>("llmconfigs");
    public IMongoCollection<InviteCode> InviteCodes => _database.GetCollection<InviteCode>("invitecodes");
    public IMongoCollection<LLMPlatform> LLMPlatforms => _database.GetCollection<LLMPlatform>("llmplatforms");
    public IMongoCollection<LLMModel> LLMModels => _database.GetCollection<LLMModel>("llmmodels");
    public IMongoCollection<AppSettings> AppSettings => _database.GetCollection<AppSettings>("appsettings");
    public IMongoCollection<PromptStageSettings> PromptStages => _database.GetCollection<PromptStageSettings>("promptstages");
    /// <summary>
    /// promptstages 原始集合（用于兼容旧结构迁移，避免 POCO 映射丢字段）
    /// </summary>
    public IMongoCollection<BsonDocument> PromptStagesRaw => _database.GetCollection<BsonDocument>("promptstages");
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
    public IMongoCollection<ImageGenSizeCaps> ImageGenSizeCaps => _database.GetCollection<ImageGenSizeCaps>("image_gen_size_caps");
    public IMongoCollection<ImageGenRun> ImageGenRuns => _database.GetCollection<ImageGenRun>("image_gen_runs");
    public IMongoCollection<ImageGenRunItem> ImageGenRunItems => _database.GetCollection<ImageGenRunItem>("image_gen_run_items");
    public IMongoCollection<ImageGenRunEvent> ImageGenRunEvents => _database.GetCollection<ImageGenRunEvent>("image_gen_run_events");
    public IMongoCollection<UploadArtifact> UploadArtifacts => _database.GetCollection<UploadArtifact>("upload_artifacts");
    public IMongoCollection<AdminPromptOverride> AdminPromptOverrides => _database.GetCollection<AdminPromptOverride>("admin_prompt_overrides");

    private void CreateIndexes()
    {
        // Users索引
        Users.Indexes.CreateOne(new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.Username),
            new CreateIndexOptions { Unique = true }));

        // Groups索引
        Groups.Indexes.CreateOne(new CreateIndexModel<Group>(
            Builders<Group>.IndexKeys.Ascending(g => g.InviteCode),
            new CreateIndexOptions { Unique = true }));

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
        GroupMembers.Indexes.CreateOne(new CreateIndexModel<GroupMember>(
            Builders<GroupMember>.IndexKeys
                .Ascending(m => m.GroupId)
                .Ascending(m => m.UserId),
            new CreateIndexOptions { Unique = true }));

        // Messages索引
        Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
            Builders<Message>.IndexKeys.Ascending(m => m.GroupId)));
        Messages.Indexes.CreateOne(new CreateIndexModel<Message>(
            Builders<Message>.IndexKeys.Ascending(m => m.SessionId)));

        // ContentGaps索引
        ContentGaps.Indexes.CreateOne(new CreateIndexModel<ContentGap>(
            Builders<ContentGap>.IndexKeys.Ascending(g => g.GroupId)));
        
        // InviteCodes: 禁止用业务字段 Code 当 _id；统一使用 string Id(Guid) 作为 _id，因此需要对 Code 建唯一索引
        InviteCodes.Indexes.CreateOne(new CreateIndexModel<InviteCode>(
            Builders<InviteCode>.IndexKeys.Ascending(x => x.Code),
            new CreateIndexOptions { Unique = true }));
        
        // LLMPlatforms索引
        LLMPlatforms.Indexes.CreateOne(new CreateIndexModel<LLMPlatform>(
            Builders<LLMPlatform>.IndexKeys.Ascending(p => p.Name),
            new CreateIndexOptions { Unique = true }));
        
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
        ModelLabModelSets.Indexes.CreateOne(new CreateIndexModel<ModelLabModelSet>(
            Builders<ModelLabModelSet>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.Name),
            new CreateIndexOptions { Unique = true }));
        ModelLabModelSets.Indexes.CreateOne(new CreateIndexModel<ModelLabModelSet>(
            Builders<ModelLabModelSet>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.UpdatedAt)));

        // ModelLabGroups 索引（同一 Admin 下名称唯一）
        ModelLabGroups.Indexes.CreateOne(new CreateIndexModel<ModelLabGroup>(
            Builders<ModelLabGroup>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.Name),
            new CreateIndexOptions { Unique = true }));
        ModelLabGroups.Indexes.CreateOne(new CreateIndexModel<ModelLabGroup>(
            Builders<ModelLabGroup>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.UpdatedAt)));

        // ImageMasterSessions：按 owner + updatedAt
        ImageMasterSessions.Indexes.CreateOne(new CreateIndexModel<ImageMasterSession>(
            Builders<ImageMasterSession>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.UpdatedAt)));

        // ImageMasterMessages：按 session + createdAt
        ImageMasterMessages.Indexes.CreateOne(new CreateIndexModel<ImageMasterMessage>(
            Builders<ImageMasterMessage>.IndexKeys.Ascending(x => x.SessionId).Ascending(x => x.CreatedAt)));

        // ImageAssets：按 owner + createdAt；按 owner + sha256 去重
        ImageAssets.Indexes.CreateOne(new CreateIndexModel<ImageAsset>(
            Builders<ImageAsset>.IndexKeys.Ascending(x => x.OwnerUserId).Descending(x => x.CreatedAt)));
        ImageAssets.Indexes.CreateOne(new CreateIndexModel<ImageAsset>(
            Builders<ImageAsset>.IndexKeys.Ascending(x => x.OwnerUserId).Ascending(x => x.Sha256),
            new CreateIndexOptions { Unique = true }));

        // ImageGenSizeCaps：为兼容更多 Mongo 版本，拆成两个 unique partial index，避免 partial filter 中出现 $not/$ne null
        // 1) modelId 唯一：仅对存在 ModelId 字段的文档生效（upsert 插入时未设置 ModelId 的字段将不存在）
        ImageGenSizeCaps.Indexes.CreateOne(new CreateIndexModel<ImageGenSizeCaps>(
            Builders<ImageGenSizeCaps>.IndexKeys.Ascending(x => x.ModelId),
            new CreateIndexOptions<ImageGenSizeCaps>
            {
                Name = "uniq_image_gen_size_caps_modelId",
                Unique = true,
                PartialFilterExpression = new BsonDocument("ModelId", new BsonDocument("$exists", true))
            }));

        // 2) platformId + modelId 唯一（字段名：ModelName）：仅对存在 PlatformId & ModelName 字段的文档生效
        ImageGenSizeCaps.Indexes.CreateOne(new CreateIndexModel<ImageGenSizeCaps>(
            Builders<ImageGenSizeCaps>.IndexKeys
                .Ascending(x => x.PlatformId)
                .Ascending(x => x.ModelName),
            new CreateIndexOptions<ImageGenSizeCaps>
            {
                Name = "uniq_image_gen_size_caps_platformId_modelName",
                Unique = true,
                PartialFilterExpression = new BsonDocument
                {
                    { "PlatformId", new BsonDocument("$exists", true) },
                    { "ModelName", new BsonDocument("$exists", true) }
                }
            }));

        // ImageGenRuns：按 owner + createdAt；worker 取队列时按 status + createdAt
        ImageGenRuns.Indexes.CreateOne(new CreateIndexModel<ImageGenRun>(
            Builders<ImageGenRun>.IndexKeys.Ascending(x => x.OwnerAdminId).Descending(x => x.CreatedAt)));
        ImageGenRuns.Indexes.CreateOne(new CreateIndexModel<ImageGenRun>(
            Builders<ImageGenRun>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.CreatedAt)));
        // 幂等键：同一 admin 下唯一（只对存在 IdempotencyKey 的文档生效）
        ImageGenRuns.Indexes.CreateOne(new CreateIndexModel<ImageGenRun>(
            Builders<ImageGenRun>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.IdempotencyKey),
            new CreateIndexOptions<ImageGenRun>
            {
                Name = "uniq_image_gen_runs_owner_idem",
                Unique = true,
                // 仅对字符串类型生效：避免 null 字段也命中 partial index，导致同一 admin 只能创建 1 条 run
                PartialFilterExpression = new BsonDocument("IdempotencyKey", new BsonDocument("$type", "string"))
            }));

        // ImageGenRunItems：按 runId + (itemIndex,imageIndex) 唯一；按 owner + runId 查询
        ImageGenRunItems.Indexes.CreateOne(new CreateIndexModel<ImageGenRunItem>(
            Builders<ImageGenRunItem>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.RunId)));
        ImageGenRunItems.Indexes.CreateOne(new CreateIndexModel<ImageGenRunItem>(
            Builders<ImageGenRunItem>.IndexKeys.Ascending(x => x.RunId).Ascending(x => x.ItemIndex).Ascending(x => x.ImageIndex),
            new CreateIndexOptions<ImageGenRunItem> { Name = "uniq_image_gen_run_items_run_pos", Unique = true }));

        // ImageGenRunEvents：按 runId + seq；用于 SSE afterSeq 续传
        ImageGenRunEvents.Indexes.CreateOne(new CreateIndexModel<ImageGenRunEvent>(
            Builders<ImageGenRunEvent>.IndexKeys.Ascending(x => x.OwnerAdminId).Ascending(x => x.RunId)));
        ImageGenRunEvents.Indexes.CreateOne(new CreateIndexModel<ImageGenRunEvent>(
            Builders<ImageGenRunEvent>.IndexKeys.Ascending(x => x.RunId).Ascending(x => x.Seq),
            new CreateIndexOptions<ImageGenRunEvent> { Name = "uniq_image_gen_run_events_run_seq", Unique = true }));

        // UploadArtifacts：按 requestId + createdAt；按 requestId + kind；按 sha256（非唯一，仅便于排查）
        UploadArtifacts.Indexes.CreateOne(new CreateIndexModel<UploadArtifact>(
            Builders<UploadArtifact>.IndexKeys.Ascending(x => x.RequestId).Descending(x => x.CreatedAt)));
        UploadArtifacts.Indexes.CreateOne(new CreateIndexModel<UploadArtifact>(
            Builders<UploadArtifact>.IndexKeys.Ascending(x => x.RequestId).Ascending(x => x.Kind).Descending(x => x.CreatedAt)));
        UploadArtifacts.Indexes.CreateOne(new CreateIndexModel<UploadArtifact>(
            Builders<UploadArtifact>.IndexKeys.Ascending(x => x.Sha256).Descending(x => x.CreatedAt)));

        // AdminPromptOverrides：同一管理员 + key 唯一（用于覆盖 system prompt）
        AdminPromptOverrides.Indexes.CreateOne(new CreateIndexModel<AdminPromptOverride>(
            Builders<AdminPromptOverride>.IndexKeys
                .Ascending(x => x.OwnerAdminId)
                .Ascending(x => x.Key),
            new CreateIndexOptions<AdminPromptOverride>
            {
                Name = "uniq_admin_prompt_overrides_owner_key",
                Unique = true
            }));
    }
}
