using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using KnowledgeBaseStore = PrdAgent.Core.Models.DocumentStore;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

/// <summary>
/// 通用对话用得上、而现有工具集里没有的两把：出图与存笔记。
///
/// 两把都只做转发：出图转给平台已有的出图流水线，存笔记转给已有的文档空间。
/// 没有任何自研的生成逻辑或存储逻辑。
/// </summary>
internal static class ChatToolSupport
{
    public static string? Str(JsonElement input, string name)
    {
        if (input.ValueKind != JsonValueKind.Object) return null;
        if (!input.TryGetProperty(name, out var v)) return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }
}

/// <summary>
/// 对话里出图。把请求转成平台已有的出图任务，等它跑完，把图的地址交回给模型。
/// 出的图落进用户自己的素材库，与视觉创作页产出的图同一个地方。
/// </summary>
public sealed class ChatGenerateImageTool : IAgentTool
{
    private readonly MongoDbContext _db;

    /// <summary>等出图结果的上限。超过就如实说超时，不假装还在跑。</summary>
    private static readonly TimeSpan WaitLimit = TimeSpan.FromMinutes(4);

    public ChatGenerateImageTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "chat_generate_image",
        Description = "根据描述生成一张图片，生成结果会自动存进用户的素材库。"
                      + "用户说「画一张」「生成图片」「做张海报」这类需求时用它。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["prompt"],
          "properties": {
            "prompt": { "type": "string", "description": "画面描述。写具体：主体、风格、配色、构图。" },
            "size": { "type": "string", "description": "可选。像 1024x1024（方）、1536x1024（横）、1024x1536（竖）。默认 1024x1024。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var userId = await KnowledgeBaseReadonlyToolSupport.ResolveUserIdAsync(_db, context, ct);
        if (userId == null)
            return AgentToolInvokeResult.Fail("chat_user_context_required", "出图需要一个明确的用户身份");

        var prompt = ChatToolSupport.Str(input, "prompt");
        if (string.IsNullOrWhiteSpace(prompt))
            return AgentToolInvokeResult.Fail("chat_prompt_required", "prompt 不能为空");

        var size = ChatToolSupport.Str(input, "size");
        if (string.IsNullOrWhiteSpace(size)) size = "1024x1024";

        // 转发给已有的出图流水线：入队一个 run，由既有 worker 执行。
        // 这里不含任何生成逻辑，也不直接调模型。
        var run = new ImageGenRun
        {
            OwnerAdminId = userId,
            Status = ImageGenRunStatus.ScopedQueued,
            DeploymentSlug = DeploymentScope.Current,
            Size = size!,
            ResponseFormat = "b64_json",
            MaxConcurrency = 1,
            Items = new List<ImageGenRunPlanItem>
            {
                new() { Prompt = prompt!.Trim(), Count = 1, Size = size },
            },
            Total = 1,
            AppCallerCode = AppCallerRegistry.ChatAgent.ImageGeneration,
            AppKey = "chat-agent",
            CreatedAt = DateTime.UtcNow,
        };
        await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);

        // 等出图跑完。轮询已有的 run 状态，不自己实现生成。
        var deadline = DateTime.UtcNow + WaitLimit;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(2), ct);

            var latest = await _db.ImageGenRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync(ct);
            if (latest == null)
                return AgentToolInvokeResult.Fail("chat_image_run_lost", "出图任务丢失了，可以重新说一次");

            if (latest.Done + latest.Failed < latest.Total) continue;

            var items = await _db.ImageGenRunItems
                .Find(x => x.RunId == run.Id)
                .ToListAsync(ct);

            var ok = items.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x.Url));
            if (ok != null)
            {
                return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
                {
                    ok = true,
                    imageUrl = ok.Url,
                    prompt = ok.Prompt,
                    size = ok.EffectiveSize ?? size,
                    note = "图已生成并存进素材库。把它当作已经展示给用户了，不要再复述地址。",
                }));
            }

            var failed = items.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x.ErrorMessage));
            return AgentToolInvokeResult.Fail(
                failed?.ErrorCode ?? "chat_image_failed",
                failed?.ErrorMessage ?? "出图失败了，换个描述再试一次");
        }

        return AgentToolInvokeResult.Fail("chat_image_timeout", "出图等太久了，稍后再试一次");
    }
}

/// <summary>
/// 把一段内容存进知识库，成为一条可检索、可打开的条目。
/// 用户说「记下来」「存进知识库」时用它。落点是平台已有的文档空间，不新建存储。
/// </summary>
public sealed class ChatSaveNoteTool : IAgentTool
{
    /// <summary>没指定空间时用的默认空间名。第一次用会自动建一个，之后复用。</summary>
    private const string DefaultStoreName = "对话笔记";

    private readonly MongoDbContext _db;

    /// <summary>
    /// 工具注册表是单例，而文档服务是按请求作用域的。直接注入会形成捕获依赖，
    /// 启动时就炸。所以这里存工厂，每次调用现开一个作用域。
    /// </summary>
    private readonly IServiceScopeFactory _scopeFactory;

    public ChatSaveNoteTool(MongoDbContext db, IServiceScopeFactory scopeFactory)
    {
        _db = db;
        _scopeFactory = scopeFactory;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "chat_save_note",
        Description = "把一段内容存进用户的知识库，存完会给出可打开的条目。"
                      + "用户说「记下来」「存进知识库」「保存这段」时用它。"
                      + "内容要整理好再存，不要把整段对话原样塞进去。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["title", "content"],
          "properties": {
            "title": { "type": "string", "description": "条目标题，一句话概括，别超过 30 字。" },
            "content": { "type": "string", "description": "条目正文，Markdown。整理成条理清楚的内容再存。" },
            "storeId": { "type": "string", "description": "可选。存进指定的知识库空间；不给就存进默认的对话笔记空间。" },
            "tags": { "type": "array", "items": { "type": "string" }, "description": "可选。几个标签，方便以后检索。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var userId = await KnowledgeBaseReadonlyToolSupport.ResolveUserIdAsync(_db, context, ct);
        if (userId == null)
            return AgentToolInvokeResult.Fail("chat_user_context_required", "写知识库需要一个明确的用户身份");

        var title = ChatToolSupport.Str(input, "title")?.Trim();
        var content = ChatToolSupport.Str(input, "content");
        if (string.IsNullOrWhiteSpace(title))
            return AgentToolInvokeResult.Fail("chat_title_required", "title 不能为空");
        if (string.IsNullOrWhiteSpace(content))
            return AgentToolInvokeResult.Fail("chat_content_required", "content 不能为空");

        var store = await ResolveStoreAsync(userId, ChatToolSupport.Str(input, "storeId"), ct);
        if (store == null)
            return AgentToolInvokeResult.Fail("chat_store_not_found", "指定的知识库空间不存在或你没有权限");

        // 正文走已有的文档服务，保证与手工新建的条目读法一致（知识库读工具按 DocumentId 取正文）。
        using var scope = _scopeFactory.CreateScope();
        var documents = scope.ServiceProvider.GetRequiredService<IDocumentService>();
        var parsed = await documents.ParseAsync(content!);
        parsed.Title = title!;
        await documents.SaveAsync(parsed);

        var tags = ReadTags(input);
        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            DocumentId = parsed.Id,
            Title = title!,
            Summary = content!.Length > 200 ? content[..200].Trim() : content.Trim(),
            SourceType = DocumentSourceType.Import,
            ContentType = "text/markdown",
            FileSize = System.Text.Encoding.UTF8.GetByteCount(content),
            Tags = tags,
            ContentIndex = content.Length > 2000 ? content[..2000].Trim() : content.Trim(),
            CreatedBy = userId,
            UpdatedBy = userId,
            LastChangedAt = DateTime.UtcNow,
        };
        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<KnowledgeBaseStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            ok = true,
            entryId = entry.Id,
            storeId = store.Id,
            storeName = store.Name,
            title = entry.Title,
            // 前端据此渲染「打开这篇」按钮；模型不需要把地址念出来。
            openPath = $"/document-store?store={store.Id}&entry={entry.Id}",
            note = "已存好。前端会给用户一个可点开的入口，不用在回复里重复地址。",
        }));
    }

    /// <summary>指定了空间就用指定的（且必须有权限）；没指定就找默认笔记空间，没有就建一个。</summary>
    private async Task<KnowledgeBaseStore?> ResolveStoreAsync(string userId, string? storeId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(storeId))
            return await KnowledgeBaseReadonlyToolSupport.FindAccessibleStoreAsync(_db, storeId!, userId, ct);

        var existing = await _db.DocumentStores
            .Find(Builders<KnowledgeBaseStore>.Filter.Eq(x => x.OwnerId, userId)
                  & Builders<KnowledgeBaseStore>.Filter.Eq(x => x.Name, DefaultStoreName))
            .FirstOrDefaultAsync(ct);
        if (existing != null) return existing;

        var created = new KnowledgeBaseStore
        {
            Name = DefaultStoreName,
            Description = "对话里说「记下来」时自动存进这里",
            OwnerId = userId,
            IsPublic = false,
            DocumentCount = 0,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
        await _db.DocumentStores.InsertOneAsync(created, cancellationToken: ct);
        return created;
    }

    private static List<string> ReadTags(JsonElement input)
    {
        var tags = new List<string>();
        if (input.ValueKind != JsonValueKind.Object) return tags;
        if (!input.TryGetProperty("tags", out var arr) || arr.ValueKind != JsonValueKind.Array) return tags;
        foreach (var t in arr.EnumerateArray())
        {
            if (t.ValueKind != JsonValueKind.String) continue;
            var v = t.GetString()?.Trim();
            if (!string.IsNullOrWhiteSpace(v)) tags.Add(v!);
        }
        return tags;
    }
}
