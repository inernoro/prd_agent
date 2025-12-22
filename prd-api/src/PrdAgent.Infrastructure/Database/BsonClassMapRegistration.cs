using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Serializers;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// BSON 类映射注册（替代注解方式，更 AOT 友好）
/// </summary>
public static class BsonClassMapRegistration
{
    private static bool _registered;
    private static readonly object _lock = new();

    /// <summary>
    /// 注册所有 BSON 类映射
    /// </summary>
    public static void Register()
    {
        lock (_lock)
        {
            if (_registered) return;

            RegisterUser();
            RegisterGroup();
            RegisterGroupMember();
            RegisterMessage();
            RegisterSession();
            RegisterContentGap();
            RegisterAttachment();
            RegisterLLMConfig();
            RegisterAppSettings();
            RegisterLlmRequestLog();
            RegisterInviteCode();
            RegisterParsedPrd();
            RegisterPrdComment();
            RegisterModelLabExperiment();
            RegisterModelLabRun();
            RegisterModelLabRunItem();
            RegisterModelLabModelSet();
            RegisterModelLabGroup();

            _registered = true;
        }
    }

    private static void RegisterUser()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(User))) return;
        
        BsonClassMap.RegisterClassMap<User>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(u => u.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterGroup()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(Group))) return;
        
        BsonClassMap.RegisterClassMap<Group>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(g => g.GroupId)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterGroupMember()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(GroupMember))) return;
        
        BsonClassMap.RegisterClassMap<GroupMember>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(m => m.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterMessage()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(Message))) return;
        
        BsonClassMap.RegisterClassMap<Message>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(m => m.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterSession()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(Session))) return;
        
        BsonClassMap.RegisterClassMap<Session>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(s => s.SessionId)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterContentGap()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ContentGap))) return;
        
        BsonClassMap.RegisterClassMap<ContentGap>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(g => g.GapId)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterAttachment()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(Attachment))) return;
        
        BsonClassMap.RegisterClassMap<Attachment>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(a => a.AttachmentId)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterLLMConfig()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(LLMConfig))) return;
        
        BsonClassMap.RegisterClassMap<LLMConfig>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(c => c.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterInviteCode()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(InviteCode))) return;
        
        BsonClassMap.RegisterClassMap<InviteCode>(cm =>
        {
            cm.AutoMap();
            // 统一：_id 映射到 Id（string Guid）；业务字段 Code 用唯一索引约束
            cm.MapIdMember(i => i.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterAppSettings()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(AppSettings))) return;

        BsonClassMap.RegisterClassMap<AppSettings>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(s => s.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterLlmRequestLog()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(LlmRequestLog))) return;

        BsonClassMap.RegisterClassMap<LlmRequestLog>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(l => l.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterParsedPrd()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ParsedPrd))) return;

        BsonClassMap.RegisterClassMap<ParsedPrd>(cm =>
        {
            cm.AutoMap();
            // 以内容 hash 作为主键；不使用 ObjectId 生成器
            cm.MapIdMember(d => d.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String));
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterPrdComment()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(PrdComment))) return;

        BsonClassMap.RegisterClassMap<PrdComment>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterModelLabExperiment()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ModelLabExperiment))) return;

        BsonClassMap.RegisterClassMap<ModelLabExperiment>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterModelLabRun()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ModelLabRun))) return;

        BsonClassMap.RegisterClassMap<ModelLabRun>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterModelLabRunItem()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ModelLabRunItem))) return;

        BsonClassMap.RegisterClassMap<ModelLabRunItem>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterModelLabModelSet()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ModelLabModelSet))) return;

        BsonClassMap.RegisterClassMap<ModelLabModelSet>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterModelLabGroup()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ModelLabGroup))) return;

        BsonClassMap.RegisterClassMap<ModelLabGroup>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringSerializer(MongoDB.Bson.BsonType.String))
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }
}
