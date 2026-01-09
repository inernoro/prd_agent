using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace PrdAgent.Api.Controllers.OpenPlatform;

/// <summary>
/// 开放平台：OpenAI 兼容接口（基于群组上下文）
/// - baseUrl 推荐配置为：https://{host}/api/v1/open-platform
/// - 能力路径沿用 OpenAI：/v1/chat/completions（stream=true -> SSE）
/// </summary>
[ApiController]
[Route("api/v1/open-platform/v1")]
[AllowAnonymous]
public sealed class OpenPlatformOpenAIController : ControllerBase
{
    // 兼容“桩接口”：提供最小 images 能力（不落库、不写 COS，仅用于对外联调）
    private static readonly ConcurrentDictionary<string, (byte[] bytes, DateTimeOffset expireAt)> _imgStore = new();
    private static readonly TimeSpan ImgTtl = TimeSpan.FromMinutes(30);

    private readonly IOpenPlatformApiKeyRepository _keyRepo;
    private readonly IGroupService _groupService;
    private readonly IDocumentService _documentService;
    private readonly ISessionService _sessionService;
    private readonly IChatService _chatService;

    public OpenPlatformOpenAIController(
        IOpenPlatformApiKeyRepository keyRepo,
        IGroupService groupService,
        IDocumentService documentService,
        ISessionService sessionService,
        IChatService chatService)
    {
        _keyRepo = keyRepo;
        _groupService = groupService;
        _documentService = documentService;
        _sessionService = sessionService;
        _chatService = chatService;
    }

    [HttpGet("models")]
    public IActionResult ListModels()
    {
        // 最小实现：给第三方/SDK 一个可用模型 id（model 字段按 OpenAI 习惯要求必填）
        var payload = new
        {
            data = new object[]
            {
                new { id = "prd-agent", @object = "model", created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), owned_by = "prd-agent" }
            }
        };
        return Ok(payload);
    }

    /// <summary>
    /// 兼容 OpenAI Images：GET /assets/{id}.png
    /// </summary>
    [HttpGet("~/api/v1/open-platform/assets/{id}.png")]
    public IActionResult GetAsset(string id)
    {
        var key = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key)) return NotFound();
        if (!_imgStore.TryGetValue(key, out var v)) return NotFound();
        if (v.expireAt <= DateTimeOffset.UtcNow)
        {
            _imgStore.TryRemove(key, out _);
            return NotFound();
        }
        return File(v.bytes, "image/png");
    }

    [HttpPost("chat/completions")]
    public async Task ChatCompletions([FromBody] OpenAIChatRequest request, CancellationToken ct)
    {
        var auth = await TryAuthAsync(Request, ct);
        if (!auth.ok)
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status401Unauthorized, code: ErrorCodes.OPEN_PLATFORM_KEY_INVALID, message: auth.message ?? "未授权", ct);
            return;
        }

        var groupId = ResolveGroupId(Request);
        if (string.IsNullOrWhiteSpace(groupId))
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status400BadRequest, code: ErrorCodes.INVALID_FORMAT, message: "缺少群组标识：请在请求头中传 X-Group-Id", ct);
            return;
        }

        if (!auth.key!.AllowedGroupIds.Contains(groupId, StringComparer.Ordinal))
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status403Forbidden, code: ErrorCodes.PERMISSION_DENIED, message: "该 Key 未授权此群组", ct);
            return;
        }

        // 额外校验：Key 所属用户仍需是群组成员（防止“退出群后 Key 仍可访问历史”）
        var stillMember = await _groupService.IsMemberAsync(groupId, auth.key.OwnerUserId);
        if (!stillMember)
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status403Forbidden, code: ErrorCodes.PERMISSION_DENIED, message: "Key 所属用户已不在该群组", ct);
            return;
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status404NotFound, code: ErrorCodes.GROUP_NOT_FOUND, message: "群组不存在", ct);
            return;
        }

        if (string.IsNullOrWhiteSpace(group.PrdDocumentId))
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status404NotFound, code: ErrorCodes.DOCUMENT_NOT_FOUND, message: "群组未绑定 PRD", ct);
            return;
        }

        // PRD 原文过期（缓存被清）时，拒绝对外服务，避免模型“无资料胡答”
        var prd = await _documentService.GetByIdAsync(group.PrdDocumentId);
        if (prd == null)
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status404NotFound, code: ErrorCodes.DOCUMENT_NOT_FOUND, message: "PRD 文档不存在或已过期", ct);
            return;
        }

        var userText = ExtractUserText(request);
        if (string.IsNullOrWhiteSpace(userText))
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status400BadRequest, code: ErrorCodes.CONTENT_EMPTY, message: "messages 为空", ct);
            return;
        }

        var role = ResolveViewRole(Request);

        // 每次请求创建一个 session（群组上下文会按 groupId 复用，不依赖 sessionId）
        var session = await _sessionService.CreateAsync(group.PrdDocumentId, groupId);
        session = await _sessionService.SwitchRoleAsync(session.SessionId, role);

        var model = string.IsNullOrWhiteSpace(request?.Model) ? "prd-agent" : request!.Model.Trim();
        var stream = request?.Stream ?? false;

        if (!stream)
        {
            var answer = new StringBuilder();
            TokenUsage? usage = null;

            await foreach (var ev in _chatService.SendMessageAsync(
                               sessionId: session.SessionId,
                               content: userText,
                               resendOfMessageId: null,
                               promptKey: null,
                               userId: auth.key.OwnerUserId,
                               attachmentIds: null,
                               cancellationToken: ct))
            {
                if (ev.Type is "blockDelta" or "delta")
                {
                    if (!string.IsNullOrEmpty(ev.Content)) answer.Append(ev.Content);
                }
                else if (ev.Type == "done")
                {
                    usage = ev.TokenUsage;
                    break;
                }
                else if (ev.Type == "error")
                {
                    await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status502BadGateway, code: ev.ErrorCode ?? ErrorCodes.LLM_ERROR, message: ev.ErrorMessage ?? "LLM 调用失败", ct);
                    return;
                }
            }

            var id = "chatcmpl_" + Guid.NewGuid().ToString("N");
            var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var answerText = answer.ToString();

            var payload = new
            {
                id,
                @object = "chat.completion",
                created,
                model,
                choices = new[]
                {
                    new
                    {
                        index = 0,
                        message = new { role = "assistant", content = answerText },
                        finish_reason = "stop"
                    }
                },
                usage = usage == null ? null : new
                {
                    prompt_tokens = usage.Input,
                    completion_tokens = usage.Output,
                    total_tokens = usage.Input + usage.Output
                }
            };

            Response.ContentType = "application/json; charset=utf-8";
            await Response.WriteAsync(JsonSerializer.Serialize(payload), ct);
            return;
        }

        Response.StatusCode = 200;
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";
        Response.ContentType = "text/event-stream; charset=utf-8";

        var sid = "chatcmpl_" + Guid.NewGuid().ToString("N");
        var created2 = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        // 先发 role
        await WriteSseAsync(new
        {
            id = sid,
            @object = "chat.completion.chunk",
            created = created2,
            model,
            choices = new[] { new { index = 0, delta = new { role = "assistant" }, finish_reason = (string?)null } }
        }, ct);

        await foreach (var ev in _chatService.SendMessageAsync(
                           sessionId: session.SessionId,
                           content: userText,
                           resendOfMessageId: null,
                           promptKey: null,
                           userId: auth.key.OwnerUserId,
                           attachmentIds: null,
                           cancellationToken: ct))
        {
            if (ev.Type is "blockDelta" or "delta")
            {
                if (string.IsNullOrEmpty(ev.Content)) continue;
                await WriteSseAsync(new
                {
                    id = sid,
                    @object = "chat.completion.chunk",
                    created = created2,
                    model,
                    choices = new[] { new { index = 0, delta = new { content = ev.Content }, finish_reason = (string?)null } }
                }, ct);
                continue;
            }

            if (ev.Type == "done")
            {
                await WriteSseAsync(new
                {
                    id = sid,
                    @object = "chat.completion.chunk",
                    created = created2,
                    model,
                    choices = new[] { new { index = 0, delta = new { }, finish_reason = "stop" } }
                }, ct);
                await Response.WriteAsync("data: [DONE]\n\n", ct);
                await Response.Body.FlushAsync(ct);
                return;
            }

            if (ev.Type == "error")
            {
                // OpenAI streaming：遇到 error 也发一条 error，再 DONE
                await WriteSseAsync(new
                {
                    error = new
                    {
                        message = ev.ErrorMessage ?? "LLM 调用失败",
                        type = "api_error",
                        code = ev.ErrorCode ?? ErrorCodes.LLM_ERROR
                    }
                }, ct);
                await Response.WriteAsync("data: [DONE]\n\n", ct);
                await Response.Body.FlushAsync(ct);
                return;
            }
        }
    }

    /// <summary>
    /// OpenAI 兼容：图片生成（用于联调；与 stub 行为一致：返回 url）
    /// </summary>
    [HttpPost("images/generations")]
    public async Task<IActionResult> ImageGenerations([FromBody] OpenAIImageGenRequest request, CancellationToken ct)
    {
        var auth = await TryAuthAsync(Request, ct);
        if (!auth.ok)
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status401Unauthorized, code: ErrorCodes.OPEN_PLATFORM_KEY_INVALID, message: auth.message ?? "未授权", ct);
            return new EmptyResult();
        }

        var size = NormalizeSize(request?.Size);
        var (w, h) = ParseSizeOrDefault(size, 1024, 1024);
        var n = Math.Clamp(request?.N ?? 1, 1, 10);

        var data = new List<object>(n);
        for (var i = 0; i < n; i++)
        {
            var bytes = RenderSolidPng(w, h);
            var id = PutImage(bytes);
            data.Add(new { url = BuildAssetUrl(id) });
        }

        var payload = new { created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), data };
        return Ok(payload);
    }

    /// <summary>
    /// OpenAI 兼容：图片编辑（multipart）。最小实现：忽略输入图，返回随机图 url。
    /// </summary>
    [HttpPost("images/edits")]
    [RequestSizeLimit(12 * 1024 * 1024)]
    public async Task<IActionResult> ImageEdits(CancellationToken ct)
    {
        var auth = await TryAuthAsync(Request, ct);
        if (!auth.ok)
        {
            await WriteOpenAiErrorAsync(statusCode: StatusCodes.Status401Unauthorized, code: ErrorCodes.OPEN_PLATFORM_KEY_INVALID, message: auth.message ?? "未授权", ct);
            return new EmptyResult();
        }

        if (!Request.HasFormContentType)
        {
            return BadRequest(new { error = new { message = "multipart/form-data required" } });
        }

        var form = await Request.ReadFormAsync(ct);
        var sizeRaw = form["size"].ToString();
        var size = NormalizeSize(sizeRaw);
        var (w, h) = ParseSizeOrDefault(size, 1024, 1024);
        var nRaw = form["n"].ToString();
        var n = int.TryParse(nRaw, out var nn) ? nn : 1;
        n = Math.Clamp(n, 1, 10);

        // 兼容：要求带 image 字段，但最小实现不读取其内容（避免复杂处理）
        var file = form.Files.GetFile("image") ?? form.Files.FirstOrDefault();
        if (file == null || file.Length <= 0)
        {
            return BadRequest(new { error = new { message = "image is required" } });
        }

        var data = new List<object>(n);
        for (var i = 0; i < n; i++)
        {
            var bytes = RenderSolidPng(w, h);
            var id = PutImage(bytes);
            data.Add(new { url = BuildAssetUrl(id) });
        }

        var payload = new { created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), data };
        return Ok(payload);
    }

    private static string? ResolveGroupId(HttpRequest req)
    {
        var h = (req.Headers["X-Group-Id"].FirstOrDefault() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(h)) return h;
        h = (req.Headers["X-Prd-Group-Id"].FirstOrDefault() ?? string.Empty).Trim();
        return string.IsNullOrWhiteSpace(h) ? null : h;
    }

    private static UserRole ResolveViewRole(HttpRequest req)
    {
        var raw = (req.Headers["X-View-Role"].FirstOrDefault() ?? req.Headers["X-Prd-Role"].FirstOrDefault() ?? string.Empty).Trim();
        var s = raw.ToUpperInvariant();
        return s switch
        {
            "PM" => UserRole.PM,
            "QA" => UserRole.QA,
            "DEV" => UserRole.DEV,
            "ADMIN" => UserRole.ADMIN,
            _ => UserRole.DEV
        };
    }

    private async Task<(bool ok, OpenPlatformApiKey? key, string? message)> TryAuthAsync(HttpRequest req, CancellationToken ct)
    {
        var token = ExtractBearerToken(req);
        if (string.IsNullOrWhiteSpace(token))
            return (false, null, "缺少 Authorization: Bearer {apiKey}");

        var parsed = ParseApiKey(token);
        if (parsed == null)
            return (false, null, "apiKey 格式不正确");

        var (keyId, secret) = parsed.Value;
        var key = await _keyRepo.GetByIdAsync(keyId);
        if (key == null || key.IsRevoked)
            return (false, null, "apiKey 无效");

        if (!VerifySecret(key, secret))
            return (false, null, "apiKey 无效");

        // best-effort：更新 lastUsedAt（不阻断主流程）
        try
        {
            key.LastUsedAt = DateTime.UtcNow;
            await _keyRepo.ReplaceAsync(key);
        }
        catch
        {
            // ignore
        }

        return (true, key, null);
    }

    private static string? ExtractBearerToken(HttpRequest req)
    {
        var auth = (req.Headers.Authorization.FirstOrDefault() ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(auth)) return null;
        if (!auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        var t = auth["Bearer ".Length..].Trim();
        return string.IsNullOrWhiteSpace(t) ? null : t;
    }

    private static (string keyId, string secret)? ParseApiKey(string apiKey)
    {
        // 期望格式：sk_prd_{keyId}_{secret}
        var s = (apiKey ?? string.Empty).Trim();
        if (!s.StartsWith("sk_prd_", StringComparison.Ordinal)) return null;
        var parts = s.Split('_', 4, StringSplitOptions.None);
        if (parts.Length != 4) return null;
        if (parts[0] != "sk" || parts[1] != "prd") return null;
        var keyId = (parts[2] ?? string.Empty).Trim();
        var secret = (parts[3] ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(keyId) || string.IsNullOrWhiteSpace(secret)) return null;
        if (keyId.Length < 8) return null;
        return (keyId, secret);
    }

    private static bool VerifySecret(OpenPlatformApiKey key, string secret)
    {
        try
        {
            var salt = Convert.FromBase64String(key.SaltBase64);
            var expected = Convert.FromBase64String(key.SecretHashBase64);
            var actual = SHA256.HashData(Concat(salt, Encoding.UTF8.GetBytes(secret)));
            return CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        catch
        {
            return false;
        }
    }

    private static byte[] Concat(byte[] a, byte[] b)
    {
        var all = new byte[a.Length + b.Length];
        Buffer.BlockCopy(a, 0, all, 0, a.Length);
        Buffer.BlockCopy(b, 0, all, a.Length, b.Length);
        return all;
    }

    private static string ExtractUserText(OpenAIChatRequest? req)
    {
        if (req?.Messages == null) return string.Empty;
        for (var i = req.Messages.Count - 1; i >= 0; i--)
        {
            var m = req.Messages[i];
            if (!string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase)) continue;
            if (m.Content.ValueKind == JsonValueKind.String) return m.Content.GetString() ?? string.Empty;
            if (m.Content.ValueKind == JsonValueKind.Array)
            {
                foreach (var part in m.Content.EnumerateArray())
                {
                    if (part.ValueKind != JsonValueKind.Object) continue;
                    if (part.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "text")
                    {
                        if (part.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String)
                            return tx.GetString() ?? string.Empty;
                    }
                }
            }
        }
        return string.Empty;
    }

    private async Task WriteSseAsync(object obj, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(obj);
        await Response.WriteAsync("data: " + json + "\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private async Task WriteOpenAiErrorAsync(int statusCode, string code, string message, CancellationToken ct)
    {
        Response.StatusCode = statusCode;
        Response.ContentType = "application/json; charset=utf-8";
        var payload = new
        {
            error = new
            {
                message,
                type = "invalid_request_error",
                code
            }
        };
        await Response.WriteAsync(JsonSerializer.Serialize(payload), ct);
    }

    private string BuildAssetUrl(string id)
    {
        var host = $"{Request.Scheme}://{Request.Host}";
        return $"{host}/api/v1/open-platform/assets/{id}.png";
    }

    private static string PutImage(byte[] bytes)
    {
        var id = Guid.NewGuid().ToString("N");
        _imgStore[id] = (bytes, DateTimeOffset.UtcNow.Add(ImgTtl));
        if (_imgStore.Count > 256)
        {
            foreach (var kv in _imgStore)
            {
                if (kv.Value.expireAt <= DateTimeOffset.UtcNow) _imgStore.TryRemove(kv.Key, out _);
            }
        }
        return id;
    }

    private static string NormalizeSize(string? s)
    {
        var raw = (s ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)) return "1024x1024";
        raw = raw.Replace("*", "x", StringComparison.OrdinalIgnoreCase).Replace("×", "x");
        return raw;
    }

    private static (int w, int h) ParseSizeOrDefault(string? s, int defW, int defH)
    {
        var raw = (s ?? string.Empty).Trim();
        var idx = raw.IndexOf('x', StringComparison.OrdinalIgnoreCase);
        if (idx <= 0) return (defW, defH);
        var ws = raw[..idx];
        var hs = raw[(idx + 1)..];
        var w = int.TryParse(ws, out var ww) ? ww : defW;
        var h = int.TryParse(hs, out var hh) ? hh : defH;
        w = Math.Clamp(w, 64, 2048);
        h = Math.Clamp(h, 64, 2048);
        return (w, h);
    }

    private static byte[] RenderSolidPng(int w, int h)
    {
        // 最小图：随机色背景（避免“全黑/全白”导致客户端误以为透明/裁切）
        var r = (byte)Random.Shared.Next(30, 230);
        var g = (byte)Random.Shared.Next(30, 230);
        var b = (byte)Random.Shared.Next(30, 230);
        using var img = new Image<Rgba32>(w, h);
        img.Mutate(ctx => ctx.BackgroundColor(new Rgba32(r, g, b, 255)));
        using var ms = new MemoryStream();
        img.SaveAsPng(ms);
        return ms.ToArray();
    }
}

public sealed class OpenAIChatRequest
{
    public string? Model { get; set; }
    public bool? Stream { get; set; }
    public List<OpenAIChatMessage> Messages { get; set; } = new();
}

public sealed class OpenAIChatMessage
{
    public string Role { get; set; } = "user";
    public JsonElement Content { get; set; }
}

public sealed class OpenAIImageGenRequest
{
    public string? Model { get; set; }
    public string? Prompt { get; set; }
    public int? N { get; set; }
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; }
}

