using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Infrastructure.Services;

public class ModelDomainService : IModelDomainService
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILlmRequestLogWriter _logWriter;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly ILogger<ClaudeClient> _claudeLogger;

    public ModelDomainService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILlmRequestLogWriter logWriter,
        ILLMRequestContextAccessor ctxAccessor,
        ILogger<ClaudeClient> claudeLogger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logWriter = logWriter;
        _ctxAccessor = ctxAccessor;
        _claudeLogger = claudeLogger;
    }

    public async Task<ILLMClient> GetClientAsync(ModelPurpose purpose, CancellationToken ct = default)
    {
        // 仅选启用模型；用途模型缺失时回退主模型
        var mainModel = await _db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefaultAsync(ct);
        var model = await FindPurposeModelAsync(purpose, ct) ?? mainModel;

        if (model == null)
        {
            // 极端情况：没有任何主模型，返回一个“空”的客户端不会更好；这里直接抛错由上层转 LLM_ERROR
            throw new InvalidOperationException("未配置可用模型");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        // 业务规则：不再使用“全局开关”，而是以“主模型是否启用 Prompt Cache”作为总开关；
        // 同时仍尊重当前模型的 enablePromptCache（不是所有模型都适合开启 cache）。
        var mainEnablePromptCache = mainModel == null ? false : (mainModel.EnablePromptCache ?? true);

        var (apiUrl, apiKey, platformType, platformId, platformName) = await ResolveApiConfigForModelAsync(model, jwtSecret, ct);
        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            throw new InvalidOperationException("模型 API 配置不完整");
        }

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        var apiUrlTrim = apiUrl.Trim();
        // 统一规则：BaseAddress 必须以 "/" 结尾，否则 Uri 合并会丢最后一段路径（例如 /api/v3 + v1/... 会变成 /api/v1/...）
        // 对于以 "#" 结尾的"完整 endpoint"，OpenAIClient 会使用绝对 URL，不依赖 BaseAddress。
        httpClient.BaseAddress = new Uri(apiUrlTrim.TrimEnd('#').TrimEnd('/') + "/");

        var enablePromptCache = mainEnablePromptCache && (model.EnablePromptCache ?? true);
        if (platformType == "anthropic" || apiUrl.Contains("anthropic.com"))
        {
            return new ClaudeClient(httpClient, apiKey, model.ModelName, 4096, 0.2, enablePromptCache, _claudeLogger, _logWriter, _ctxAccessor, platformId, platformName);
        }

        // 默认 OpenAI 兼容：按 baseURL 规则选择 chat/completions 的最终调用方式
        // - baseURL 以 "/" 结尾：请求 path = "chat/completions"
        // - baseURL 以 "#" 结尾：请求 endpoint = "{baseURL 去掉#}"（不拼接）
        // - 其他：请求 path = "v1/chat/completions"
        var chatEndpointOrPath = apiUrlTrim.EndsWith("#", StringComparison.Ordinal)
            ? apiUrlTrim.TrimEnd('#')
            : (apiUrlTrim.EndsWith("/", StringComparison.Ordinal) ? "chat/completions" : "v1/chat/completions");

        return new OpenAIClient(
            httpClient,
            apiKey,
            model.ModelName,
            1024,
            0.2,
            enablePromptCache,
            _logWriter,
            _ctxAccessor,
            chatEndpointOrPath,
            platformId,
            platformName);
    }

    public async Task<string> SuggestGroupNameAsync(string? fileName, string snippet, CancellationToken ct = default)
    {
        var safeSnippet = (snippet ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(safeSnippet))
        {
            return "未命名群组";
        }

        // 使用意图模型（不存在则回退主模型）
        var client = await GetClientAsync(ModelPurpose.Intent, ct);

        var requestId = Guid.NewGuid().ToString("N");
        using var _ = _ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[INTENT_GROUP_NAME]",
            RequestType: "intent",
            RequestPurpose: "groupName.suggest"));

        var systemPrompt =
            "你是PRD Agent的意图模型。你的任务：根据给定的文件名与PRD片段，生成一个适合“群组名称”的短标题。\n" +
            "要求：\n" +
            "- 只输出一个名称，不要解释\n" +
            "- 优先中文，1-20字\n" +
            "- 避免包含版本号、日期、纯数字、文件扩展名\n" +
            "- 如果片段包含明显标题，用它的语义进行概括";

        var userContent =
            $"文件名：{(string.IsNullOrWhiteSpace(fileName) ? "(无)" : fileName)}\n\n" +
            "PRD片段：\n" +
            safeSnippet;

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userContent }
        };

        var text = await CollectToTextAsync(client, systemPrompt, messages, ct);
        var name = NormalizeName(text);
        return string.IsNullOrWhiteSpace(name) ? "未命名群组" : name;
    }

    private async Task<LLMModel?> FindPurposeModelAsync(ModelPurpose purpose, CancellationToken ct)
    {
        var q = purpose switch
        {
            ModelPurpose.Intent => _db.LLMModels.Find(m => m.IsIntent && m.Enabled),
            ModelPurpose.Vision => _db.LLMModels.Find(m => m.IsVision && m.Enabled),
            ModelPurpose.ImageGen => _db.LLMModels.Find(m => m.IsImageGen && m.Enabled),
            _ => _db.LLMModels.Find(m => m.IsMain && m.Enabled)
        };
        return await q.FirstOrDefaultAsync(ct);
    }

    private async Task<(string? apiUrl, string? apiKey, string? platformType, string? platformId, string? platformName)> ResolveApiConfigForModelAsync(
        LLMModel model,
        string jwtSecret,
        CancellationToken ct)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted, jwtSecret);
        string? platformType = null;
        string? platformId = model.PlatformId;
        string? platformName = null;

        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync(ct);
            platformType = platform?.PlatformType?.ToLowerInvariant();
            platformName = platform?.Name;
            if (platform != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType, platformId, platformName);
    }

    private static async Task<string> CollectToTextAsync(
        ILLMClient client,
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken ct)
    {
        var sb = new StringBuilder();
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, ct).WithCancellation(ct))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException(chunk.ErrorMessage ?? "LLM_ERROR");
            }
        }
        return sb.ToString();
    }

    private static string NormalizeName(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(s)) return "";

        // 取第一行
        var line = s.Split('\n').Select(x => x.Trim()).FirstOrDefault(x => !string.IsNullOrEmpty(x)) ?? "";
        line = line.Trim().Trim('`').Trim('"', '“', '”', '\'', '‘', '’');

        // 移除常见前缀
        line = line.Replace("群组名称：", "", StringComparison.OrdinalIgnoreCase)
                   .Replace("群名：", "", StringComparison.OrdinalIgnoreCase)
                   .Trim();

        if (line.Length > 24) line = line[..24].Trim();
        return line;
    }

    private static string DecryptApiKey(string encryptedKey, string secretKey)
    {
        try
        {
            if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;
            var parts = encryptedKey.Split(':');
            if (parts.Length != 2) return "";

            var keyBytes = Encoding.UTF8.GetBytes(secretKey[..32]);
            var iv = Convert.FromBase64String(parts[0]);
            var encryptedBytes = Convert.FromBase64String(parts[1]);

            using var aes = Aes.Create();
            aes.Key = keyBytes;
            aes.IV = iv;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            return Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return "";
        }
    }
}


