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
    public IMongoCollection<Message> Messages => _database.GetCollection<Message>("messages");
    public IMongoCollection<ContentGap> ContentGaps => _database.GetCollection<ContentGap>("contentgaps");
    public IMongoCollection<Attachment> Attachments => _database.GetCollection<Attachment>("attachments");
    public IMongoCollection<LLMConfig> LLMConfigs => _database.GetCollection<LLMConfig>("llmconfigs");
    public IMongoCollection<InviteCode> InviteCodes => _database.GetCollection<InviteCode>("invitecodes");
    public IMongoCollection<LLMPlatform> LLMPlatforms => _database.GetCollection<LLMPlatform>("llmplatforms");
    public IMongoCollection<LLMModel> LLMModels => _database.GetCollection<LLMModel>("llmmodels");

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
        
        // InviteCodes: Code 已标记为 [BsonId]，MongoDB _id 字段天生唯一，无需额外索引
        
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
    }
}
