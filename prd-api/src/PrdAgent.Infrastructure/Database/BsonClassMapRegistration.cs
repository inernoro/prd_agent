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
            RegisterPromptStageSettings();
            RegisterLlmRequestLog();
            RegisterApiRequestLog();
            RegisterInviteCode();
            RegisterParsedPrd();
            RegisterPrdComment();
            RegisterModelLabExperiment();
            RegisterModelLabRun();
            RegisterModelLabRunItem();
            RegisterModelLabModelSet();
            RegisterModelLabGroup();
            RegisterImageMasterSession();
            RegisterImageMasterMessage();
            RegisterImageAsset();
            RegisterAdminPromptOverride();

            _registered = true;
        }
    }

    private static void RegisterUser()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(User))) return;
        
        BsonClassMap.RegisterClassMap<User>(cm =>
        {
            cm.AutoMap();
            // 统一：业务侧使用 UserId 作为主键；历史数据 users 集合往往只有 _id，没有 userId 字段。
            // 若不将 _id 映射到 UserId，则会触发 User.UserId 的默认值（Guid.NewGuid），导致每次登录 userId 不稳定，
            // 进而导致 OwnerAdminId/JWT sub 漂移（看起来像“一个用户却有多个 ownerId”）。
            cm.MapIdMember(u => u.UserId)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            // 避免同时序列化 User.Id -> "id" 字段（它只用于旧模型兼容，不应落库）
            try
            {
                var idProp = typeof(User).GetProperty(nameof(User.Id));
                if (idProp != null) cm.UnmapMember(idProp);
            }
            catch
            {
                // ignore：不同版本 driver API 兼容性差异；即便无法 Unmap，也不影响主键映射与查询正确性
            }
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterImageMasterSession()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageMasterSession))) return;
        BsonClassMap.RegisterClassMap<ImageMasterSession>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterImageMasterMessage()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageMasterMessage))) return;
        BsonClassMap.RegisterClassMap<ImageMasterMessage>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterImageAsset()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageAsset))) return;
        BsonClassMap.RegisterClassMap<ImageAsset>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterContentGap()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ContentGap))) return;
        
        BsonClassMap.RegisterClassMap<ContentGap>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(g => g.GapId)
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
        });
    }

    private static void RegisterAdminPromptOverride()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(AdminPromptOverride))) return;

        BsonClassMap.RegisterClassMap<AdminPromptOverride>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterPromptStageSettings()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(PromptStageSettings))) return;

        BsonClassMap.RegisterClassMap<PromptStageSettings>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(s => s.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });

        // nested types：PromptStageEntry/RoleStagePrompt 需要忽略旧结构字段（pm/dev/qa/step 等）
        if (!BsonClassMap.IsClassMapRegistered(typeof(PromptStageEntry)))
        {
            BsonClassMap.RegisterClassMap<PromptStageEntry>(cm =>
            {
                cm.AutoMap();
                cm.SetIgnoreExtraElements(true);
            });
        }
        if (!BsonClassMap.IsClassMapRegistered(typeof(RoleStagePrompt)))
        {
            BsonClassMap.RegisterClassMap<RoleStagePrompt>(cm =>
            {
                cm.AutoMap();
                cm.SetIgnoreExtraElements(true);
            });
        }
    }

    private static void RegisterLlmRequestLog()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(LlmRequestLog))) return;

        BsonClassMap.RegisterClassMap<LlmRequestLog>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(l => l.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterApiRequestLog()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ApiRequestLog))) return;

        BsonClassMap.RegisterClassMap<ApiRequestLog>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(l => l.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
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
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }
}
