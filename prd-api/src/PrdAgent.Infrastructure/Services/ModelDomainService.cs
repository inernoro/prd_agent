using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
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

    public Task<ILLMClient> GetClientAsync(ModelPurpose purpose, CancellationToken ct = default)
    {
        // S3 直连收口：过去这里直接 new ClaudeClient/OpenAIClient 绕开网关池调度，
        // 现改为经 ILlmGateway.CreateClient 走统一路由。行为保持：网关的 ModelResolver 在未配置
        // 专属/默认池时命中 legacy 直连兜底（chat→IsMain / intent→IsIntent / vision→IsVision /
        // generation→IsImageGen），与旧「按用途取模型、缺失回退主模型」语义一致；协议/密钥/URL 解析
        // 也统一在网关内完成，不再重复计算。maxTokens/temperature 走网关默认，与旧值（4096/0.2）对齐。
        var (appCallerCode, modelType) = purpose switch
        {
            ModelPurpose.Intent => (AppCallerRegistry.Core.IntentClient, ModelTypes.Intent),
            ModelPurpose.Vision => (AppCallerRegistry.Core.VisionClient, ModelTypes.Vision),
            // ImageGen 走生图链路（raw），此处按对话客户端场景不适用；统一回退主客户端（chat）以保持可用。
            ModelPurpose.ImageGen => (AppCallerRegistry.Core.MainClient, ModelTypes.Chat),
            _ => (AppCallerRegistry.Core.MainClient, ModelTypes.Chat),
        };

        var client = _gateway.CreateClient(appCallerCode, modelType, maxTokens: DefaultMaxTokens, temperature: 0.2);
        return Task.FromResult(client);
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
            AppCallerCode: appCallerCode));

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
            AppCallerCode: appCallerCode));

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
    // S3 直连收口后，原 FindPurposeModelAsync / ResolveApiConfigForModelAsync（直连选模型 + 解析 API 配置）
    // 已由网关 ModelResolver 内部统一承担，此处不再重复实现。GetClientAsync 经 _gateway.CreateClient 路由。

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

