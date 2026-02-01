using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using AppCallerRegistry = PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Infrastructure.Services;

public class ModelDomainService : IModelDomainService
{
    private const int DefaultMaxTokens = 4096;
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILlmRequestLogWriter _logWriter;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<ClaudeClient> _claudeLogger;

    public ModelDomainService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILlmRequestLogWriter logWriter,
        ILLMRequestContextAccessor ctxAccessor,
        ILlmGateway gateway,
        ILogger<ClaudeClient> claudeLogger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logWriter = logWriter;
        _ctxAccessor = ctxAccessor;
        _gateway = gateway;
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
        var maxTokens = model.MaxTokens.HasValue && model.MaxTokens.Value > 0 ? model.MaxTokens.Value : DefaultMaxTokens;
        if (platformType == "anthropic" || apiUrl.Contains("anthropic.com"))
        {
            return new ClaudeClient(httpClient, apiKey, model.ModelName, maxTokens, 0.2, enablePromptCache, _claudeLogger, _logWriter, _ctxAccessor, platformId, platformName);
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
            maxTokens,
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

        // 本地启发式兜底：从显式标题/产品名称/文件名中提取
        // 目的：即使模型偶发不遵循“只输出名称”，也能返回稳定可用的群组名
        var fallbackName = GroupNameHeuristics.Suggest(fileName, safeSnippet, maxLen: 20);

        // 使用意图模型（不存在则回退主模型）
        var appCallerCode = AppCallerRegistry.Desktop.GroupName.SuggestIntent;
        var llmClient = _gateway.CreateClient(appCallerCode, "intent");

        var requestId = Guid.NewGuid().ToString("N");
        using var _ = _ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            // 展示给管理后台/日志的 system（脱敏版）：不要再用占位符，避免误导排障
            SystemPromptRedacted: "意图：根据文件名与PRD片段输出群组名称（只输出名称，不追问）",
            RequestType: "intent",
            RequestPurpose: appCallerCode));

        var systemPrompt =
            "你是PRD Agent的意图模型。\n" +
            "任务：根据给定的文件名与PRD片段，生成一个适合“群组名称”的短标题。\n" +
            "强制要求（必须遵守）：\n" +
            "- 只输出一个名称（单行），不要解释、不要提问、不要给选项\n" +
            "- 如果信息不完整，也必须给出“最佳猜测”的名称；不要要求补充全文\n" +
            "- 优先中文（允许混合英文），2-20字\n" +
            "- 避免版本号/日期/纯数字/文件扩展名/引号/前缀（如“群组名称：”）\n" +
            "- 优先从标题、产品名称/项目名称提取；其次概括主题\n" +
            "输出格式：仅名称本身，不含任何标点前后缀";

        var userContent =
            $"文件名：{(string.IsNullOrWhiteSpace(fileName) ? "(无)" : fileName)}\n\n" +
            "PRD片段：\n" +
            safeSnippet;

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userContent }
        };

        // 该意图属于"短文本提取"，禁用 prompt cache 可显著降低"错误复用/误命中"带来的离谱输出风险
        var text = await CollectToTextAsync(llmClient, systemPrompt, messages, enablePromptCache: false, ct);
        var name = NormalizeName(text);
        if (string.IsNullOrWhiteSpace(name) || !LooksLikeAName(name))
        {
            return fallbackName;
        }
        return name;
    }

    public async Task<string> SuggestWorkspaceTitleAsync(string prompt, CancellationToken ct = default)
    {
        var safePrompt = (prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(safePrompt))
        {
            return "未命名";
        }

        // 截取前 200 字作为输入，避免过长
        if (safePrompt.Length > 200)
            safePrompt = safePrompt[..200];

        var appCallerCode = AppCallerRegistry.VisualAgent.Workspace.Title;
        var llmClient = _gateway.CreateClient(appCallerCode, "intent");

        var requestId = Guid.NewGuid().ToString("N");
        using var _ = _ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "意图：根据用户图像生成提示词生成工作区标题（5-20字）",
            RequestType: "intent",
            RequestPurpose: appCallerCode));

        var systemPrompt =
            "你是视觉创作工作区的命名助手。\n" +
            "任务：根据用户的图像生成提示词，生成一个简短的工作区标题。\n" +
            "强制要求：\n" +
            "- 只输出一个标题（单行），不要解释、不要提问\n" +
            "- 5-20个字，优先中文（允许混合英文）\n" +
            "- 概括用户意图的核心主题（如 科技感海报、水彩风景插画）\n" +
            "- 避免使用引号、前缀（如 标题:）、标点符号\n" +
            "输出格式：仅标题本身";

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = $"用户提示词：{safePrompt}" }
        };

        var text = await CollectToTextAsync(llmClient, systemPrompt, messages, enablePromptCache: false, ct);
        var title = NormalizeName(text);
        if (string.IsNullOrWhiteSpace(title) || !LooksLikeAName(title) || title.Length > 20)
        {
            // 启发式兜底：截取提示词前 15 字
            title = safePrompt.Length > 15 ? safePrompt[..15] + "…" : safePrompt;
        }
        return title;
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
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(model.ApiKeyEncrypted, jwtSecret);
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
                apiKey ??= ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType, platformId, platformName);
    }

    private static async Task<string> CollectToTextAsync(
        ILLMClient client,
        string systemPrompt,
        List<LLMMessage> messages,
        bool enablePromptCache,
        CancellationToken ct)
    {
        var sb = new StringBuilder();
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, enablePromptCache, ct).WithCancellation(ct))
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

    private static bool LooksLikeAName(string name)
    {
        var s = (name ?? string.Empty).Trim();
        if (s.Length < 2 || s.Length > 50) return false;

        // 常见“非群名”泛词/占位词：即使模型输出了，也应判为无效并回退启发式
        var badExact = new[]
        {
            "新建群组", "未命名群组", "未命名文档",
            "产品需求文档", "需求文档", "产品文档", "文档",
            "目录", "版本历史", "更新记录", "概述", "背景"
        };
        if (badExact.Any(x => string.Equals(s, x, StringComparison.OrdinalIgnoreCase))) return false;

        // 追问/说明式内容直接判为无效
        var bad = new[]
        {
            "需要你提供", "请提供", "请告诉", "你想", "我可以", "方式A", "方式B", "目前只有片段", "不清楚", "无法", "不知道"
        };
        if (bad.Any(x => s.Contains(x, StringComparison.OrdinalIgnoreCase))) return false;
        if (s.Contains("http", StringComparison.OrdinalIgnoreCase)) return false;
        if (Regex.IsMatch(s, @"^[\d\W_]+$")) return false;
        return true;
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

        if (line.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            line = line[..^3].Trim();
        }

        if (line.Length > 20) line = line[..20].Trim();
        return line;
    }

}


