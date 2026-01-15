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
            RegisterGroupMessageCounter();
            RegisterSession();
            RegisterContentGap();
            RegisterAttachment();
            RegisterLLMConfig();
            RegisterAppSettings();
            RegisterPromptSettings();
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
            RegisterArticleIllustrationWorkflow();
            RegisterImageMasterWorkspace();
            RegisterImageMasterViewport();
            RegisterImageGenRun();
            RegisterImageGenRunItem();
            RegisterImageGenRunEvent();
            RegisterAdminPromptOverride();
            RegisterAdminIdempotencyRecord();
            RegisterAdminNotification();
            RegisterSystemPromptSettings();
            RegisterDesktopAssetSkin();
            RegisterDesktopAssetKey();
            RegisterOpenPlatformApp();
            RegisterOpenPlatformRequestLog();
            RegisterSystemRole();
            RegisterUserPreferences();

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

    private static void RegisterSystemRole()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(SystemRole))) return;

        BsonClassMap.RegisterClassMap<SystemRole>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
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

    private static void RegisterGroupMessageCounter()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(GroupMessageCounter))) return;

        BsonClassMap.RegisterClassMap<GroupMessageCounter>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.GroupId)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
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
            // 兼容逐步演进：避免新增字段导致反序列化失败
            cm.SetIgnoreExtraElements(true);
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

    private static void RegisterArticleIllustrationWorkflow()
    {
        if (!BsonClassMap.IsClassMapRegistered(typeof(ArticleIllustrationWorkflow)))
        {
            BsonClassMap.RegisterClassMap<ArticleIllustrationWorkflow>(cm =>
            {
                cm.AutoMap();
                cm.MapMember(x => x.Version).SetElementName("version");
                cm.MapMember(x => x.Phase).SetElementName("phase");
                cm.MapMember(x => x.Markers).SetElementName("markers");
                cm.MapMember(x => x.ExpectedImageCount).SetElementName("expectedImageCount");
                cm.MapMember(x => x.DoneImageCount).SetElementName("doneImageCount");
                cm.MapMember(x => x.AssetIdByMarkerIndex).SetElementName("assetIdByMarkerIndex");
                cm.MapMember(x => x.UpdatedAt).SetElementName("updatedAt");
                cm.SetIgnoreExtraElements(true);
            });
        }

        if (!BsonClassMap.IsClassMapRegistered(typeof(ArticleIllustrationMarker)))
        {
            BsonClassMap.RegisterClassMap<ArticleIllustrationMarker>(cm =>
            {
                cm.AutoMap();
                cm.MapMember(x => x.Index).SetElementName("index");
                cm.MapMember(x => x.Text).SetElementName("text");
                cm.MapMember(x => x.DraftText).SetElementName("draftText");
                cm.MapMember(x => x.Status).SetElementName("status");
                cm.MapMember(x => x.RunId).SetElementName("runId");
                cm.MapMember(x => x.AssetId).SetElementName("assetId");
                cm.MapMember(x => x.Url).SetElementName("url");
                cm.MapMember(x => x.PlanItem).SetElementName("planItem");
                cm.MapMember(x => x.ErrorMessage).SetElementName("errorMessage");
                cm.MapMember(x => x.UpdatedAt).SetElementName("updatedAt");
                cm.SetIgnoreExtraElements(true);
            });
        }

        if (!BsonClassMap.IsClassMapRegistered(typeof(ArticleIllustrationPlanItem)))
        {
            BsonClassMap.RegisterClassMap<ArticleIllustrationPlanItem>(cm =>
            {
                cm.AutoMap();
                cm.MapMember(x => x.Prompt).SetElementName("prompt");
                cm.MapMember(x => x.Count).SetElementName("count");
                cm.MapMember(x => x.Size).SetElementName("size");
                cm.SetIgnoreExtraElements(true);
            });
        }
    }

    private static void RegisterImageMasterWorkspace()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageMasterWorkspace))) return;
        BsonClassMap.RegisterClassMap<ImageMasterWorkspace>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            // 注意：ImageMasterWorkspace 历史写入字段名存在大小写差异。
            // 这里显式绑定为 camelCase，兼容已写入的数据（如 viewportByUserId）。
            cm.MapMember(x => x.ViewportByUserId).SetElementName("viewportByUserId");
            cm.MapMember(x => x.ArticleWorkflow).SetElementName("articleWorkflow");
            cm.MapMember(x => x.ArticleWorkflowHistory).SetElementName("articleWorkflowHistory");
            // 兼容历史字段/逐步演进：避免出现“新增字段导致反序列化崩溃”
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterImageMasterViewport()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageMasterViewport))) return;
        BsonClassMap.RegisterClassMap<ImageMasterViewport>(cm =>
        {
            cm.AutoMap();
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

    private static void RegisterAdminNotification()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(AdminNotification))) return;

        BsonClassMap.RegisterClassMap<AdminNotification>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
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

    private static void RegisterPromptSettings()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(PromptSettings))) return;

        BsonClassMap.RegisterClassMap<PromptSettings>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(s => s.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            // 强制字段名使用 camelCase，保证 raw 解析（BsonDocument）与旧数据兼容
            cm.MapMember(s => s.Prompts).SetElementName("prompts");
            cm.MapMember(s => s.UpdatedAt).SetElementName("updatedAt");
            cm.SetIgnoreExtraElements(true);
        });

        // nested types：PromptEntry/RolePrompt 需要忽略旧结构字段（pm/dev/qa/step 等）
        if (!BsonClassMap.IsClassMapRegistered(typeof(PromptEntry)))
        {
            BsonClassMap.RegisterClassMap<PromptEntry>(cm =>
            {
                cm.AutoMap();
                cm.MapMember(x => x.PromptKey).SetElementName("promptKey");
                cm.MapMember(x => x.Role).SetElementName("role");
                cm.MapMember(x => x.Order).SetElementName("order");
                cm.MapMember(x => x.Title).SetElementName("title");
                cm.MapMember(x => x.PromptTemplate).SetElementName("promptTemplate");
                cm.SetIgnoreExtraElements(true);
            });
        }
        if (!BsonClassMap.IsClassMapRegistered(typeof(RolePrompt)))
        {
            BsonClassMap.RegisterClassMap<RolePrompt>(cm =>
            {
                cm.AutoMap();
                cm.SetIgnoreExtraElements(true);
            });
        }
    }

    private static void RegisterAdminIdempotencyRecord()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(AdminIdempotencyRecord))) return;
        BsonClassMap.RegisterClassMap<AdminIdempotencyRecord>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.MapMember(x => x.OwnerAdminId).SetElementName("ownerAdminId");
            cm.MapMember(x => x.Scope).SetElementName("scope");
            cm.MapMember(x => x.IdempotencyKey).SetElementName("idempotencyKey");
            cm.MapMember(x => x.PayloadJson).SetElementName("payloadJson");
            cm.MapMember(x => x.CreatedAt).SetElementName("createdAt");
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterSystemPromptSettings()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(SystemPromptSettings))) return;
        BsonClassMap.RegisterClassMap<SystemPromptSettings>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                // 单例：固定为 "global"；保留 Guid 生成器以兼容潜在历史写入，不影响正常逻辑
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });

        if (!BsonClassMap.IsClassMapRegistered(typeof(SystemPromptEntry)))
        {
            BsonClassMap.RegisterClassMap<SystemPromptEntry>(cm =>
            {
                cm.AutoMap();
                cm.MapMember(x => x.Role).SetElementName("role");
                cm.MapMember(x => x.SystemPrompt).SetElementName("systemPrompt");
                cm.SetIgnoreExtraElements(true);
            });
        }
    }

    private static void RegisterDesktopAssetSkin()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(DesktopAssetSkin))) return;
        BsonClassMap.RegisterClassMap<DesktopAssetSkin>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.MapMember(x => x.Name).SetElementName("name");
            cm.MapMember(x => x.Enabled).SetElementName("enabled");
            cm.MapMember(x => x.CreatedByAdminId).SetElementName("createdByAdminId");
            cm.MapMember(x => x.CreatedAt).SetElementName("createdAt");
            cm.MapMember(x => x.UpdatedAt).SetElementName("updatedAt");
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterDesktopAssetKey()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(DesktopAssetKey))) return;
        BsonClassMap.RegisterClassMap<DesktopAssetKey>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.MapMember(x => x.Key).SetElementName("key");
            cm.MapMember(x => x.Kind).SetElementName("kind");
            cm.MapMember(x => x.Description).SetElementName("description");
            cm.MapMember(x => x.CreatedByAdminId).SetElementName("createdByAdminId");
            cm.MapMember(x => x.CreatedAt).SetElementName("createdAt");
            cm.MapMember(x => x.UpdatedAt).SetElementName("updatedAt");
            cm.SetIgnoreExtraElements(true);
        });
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

    private static void RegisterImageGenRun()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageGenRun))) return;
        BsonClassMap.RegisterClassMap<ImageGenRun>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterImageGenRunItem()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageGenRunItem))) return;
        BsonClassMap.RegisterClassMap<ImageGenRunItem>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterImageGenRunEvent()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(ImageGenRunEvent))) return;
        BsonClassMap.RegisterClassMap<ImageGenRunEvent>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterOpenPlatformApp()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(OpenPlatformApp))) return;
        BsonClassMap.RegisterClassMap<OpenPlatformApp>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true); // 忽略旧字段如 ConversationMode
        });
    }

    private static void RegisterOpenPlatformRequestLog()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(OpenPlatformRequestLog))) return;
        BsonClassMap.RegisterClassMap<OpenPlatformRequestLog>(cm =>
        {
            cm.AutoMap();
            cm.MapIdMember(x => x.Id)
                .SetSerializer(new StringOrObjectIdSerializer())
                .SetIdGenerator(GuidStringIdGenerator.Instance);
            cm.SetIgnoreExtraElements(true);
        });
    }

    private static void RegisterUserPreferences()
    {
        if (BsonClassMap.IsClassMapRegistered(typeof(UserPreferences))) return;
        BsonClassMap.RegisterClassMap<UserPreferences>(cm =>
        {
            cm.AutoMap();
            // UserId 作为主键（_id），每个用户一条记录
            cm.MapIdMember(x => x.UserId)
                .SetSerializer(new StringOrObjectIdSerializer());
            cm.SetIgnoreExtraElements(true);
        });
    }
}
