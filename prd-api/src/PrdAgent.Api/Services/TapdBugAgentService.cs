using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

public class TapdBugAgentService
{
    public const string AppKey = "tapd-bug-agent";
    public const string DefaultModule = "附近门店组件精准筛选";
    public const string DefaultOwner = "黄卫杰;";
    public const string DefaultVersionReport = "附近门店组件精准筛选";

    private static readonly HashSet<string> SeverityValues = new(StringComparer.OrdinalIgnoreCase)
    {
        "fatal", "serious", "normal", "minor"
    };

    private static readonly HashSet<string> PriorityValues = new(StringComparer.OrdinalIgnoreCase)
    {
        "urgent", "high", "medium", "low"
    };

    private static readonly HashSet<string> BugTypeValues = new(StringComparer.Ordinal)
    {
        "逻辑错误", "不符方案", "功能遗漏", "历史缺陷", "产品缺陷"
    };

    private readonly ILlmGateway _gateway;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<TapdBugAgentService> _logger;

    public TapdBugAgentService(
        ILlmGateway gateway,
        IHttpClientFactory httpClientFactory,
        ILogger<TapdBugAgentService> logger)
    {
        _gateway = gateway;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<TapdBugDraft> StreamPreviewAsync(
        TapdBugPreviewRequest request,
        Func<string, object, Task> writeEvent,
        CancellationToken ct)
    {
        var naturalText = request.NaturalText?.Trim() ?? string.Empty;
        var userDraft = NormalizeDraft(request.Overrides, naturalText);
        if (naturalText.Length == 0 && HasMinimumDraft(userDraft))
        {
            await writeEvent("stage", new { stage = "validated", message = "已按表单内容生成缺陷草稿" });
            await writeEvent("draft", userDraft);
            return userDraft;
        }

        await writeEvent("stage", new { stage = "analyzing", message = "正在分析缺陷描述" });

        var gReq = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.TapdBugAgent.Extract.Chat,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = BuildUserPrompt(naturalText, userDraft) },
                },
                ["temperature"] = 0.2,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 90,
            IncludeThinking = true,
        };

        var buffer = new StringBuilder();
        string? llmError = null;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gReq, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    await writeEvent("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName ?? chunk.Resolution.ActualPlatformId
                    });
                    continue;
                }

                if (chunk.Type == GatewayChunkType.Error)
                {
                    llmError = chunk.Error ?? "LLM 调用失败";
                    break;
                }

                if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrWhiteSpace(chunk.Content))
                {
                    await writeEvent("thinking", new { text = chunk.Content });
                    continue;
                }

                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    buffer.Append(chunk.Content);
                    await writeEvent("typing", new { text = chunk.Content });
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[tapd-bug-agent] preview LLM stream failed");
            llmError = "LLM 调用异常: " + ex.Message;
        }

        TapdBugDraft draft;
        if (llmError != null)
        {
            await writeEvent("stage", new { stage = "fallback", message = "模型整理失败，已使用规则兜底生成草稿" });
            draft = BuildFallbackDraft(naturalText, userDraft);
        }
        else
        {
            await writeEvent("stage", new { stage = "normalizing", message = "正在校验缺陷字段" });
            draft = MergeDrafts(userDraft, ParseDraftFromLlm(buffer.ToString()));
        }

        draft = NormalizeDraft(draft, naturalText);
        await writeEvent("draft", draft);
        await writeEvent("stage", new
        {
            stage = draft.MissingFields.Count == 0 ? "ready" : "needs_input",
            message = draft.MissingFields.Count == 0 ? "草稿已生成，请确认后提交" : "仍有关键信息缺失，请补充后再提交"
        });
        return draft;
    }

    public async Task<TapdBugSubmitResult> SubmitAsync(TapdBugSubmitRequest request)
    {
        if (!request.Confirmed)
        {
            throw new InvalidOperationException("提交前必须先确认缺陷摘要");
        }

        if (string.IsNullOrWhiteSpace(request.Cookie))
            throw new ArgumentException("请填写 TAPD Cookie");
        if (string.IsNullOrWhiteSpace(request.WorkspaceId))
            throw new ArgumentException("请填写 TAPD 工作空间 ID");
        if (request.Draft == null)
            throw new ArgumentException("缺陷草稿不能为空");

        var draft = NormalizeDraft(request.Draft, null);
        if (draft.MissingFields.Count > 0)
            throw new ArgumentException("缺陷信息不完整: " + string.Join("、", draft.MissingFields));

        var cookie = request.Cookie.Trim();

        var addBugToken = FirstNonEmpty(request.AddBugToken) ?? "null";
        var dscToken = FirstNonEmpty(request.DscToken, ExtractCookieValue(cookie, "dsc-token")) ?? string.Empty;

        var workspaceId = request.WorkspaceId.Trim();
        var descriptionHtml = BuildDescriptionHtml(
            draft.Preconditions,
            draft.Steps,
            draft.ActualResult,
            draft.ExpectedResult);

        using var form = new MultipartFormDataContent();
        AddForm(form, "data[add_bug_token]", addBugToken);
        AddForm(form, "data[Bug][title]", draft.Title);
        AddForm(form, "data[Bug][issue_id]", "");
        AddForm(form, "bug_id", "");
        AddForm(form, "data[Bug][is_new_status]", "0");
        AddForm(form, "data[Bug][is_replicate]", "0");
        AddForm(form, "data[Bug][create_link]", "0");
        AddForm(form, "data[Bug][is_jenkins]", "0");
        AddForm(form, "data[Bug][template_id]", "");
        AddForm(form, "data[Bug][description]", descriptionHtml);
        AddForm(form, "data[is_editor_or_markdown]", "1");
        AddForm(form, "data[BugStoryRelation][BugStoryRelation_relative_id]", "");
        AddForm(form, "data[Bug][version_report]", draft.VersionReport);
        AddForm(form, "data[Bug][severity]", draft.Severity);
        AddForm(form, "data[Bug][priority]", draft.Priority);
        AddForm(form, "data[Bug][custom_field_two]", "");
        AddForm(form, "data[Bug][current_owner]", draft.CurrentOwner);
        AddForm(form, "data[Bug][custom_field_one]", draft.CurrentOwner);
        AddForm(form, "data[Bug][custom_field_three]", "");
        AddForm(form, "data[Bug][bugtype]", draft.BugType);
        AddForm(form, "data[nce]", "true");
        AddForm(form, "data[Attachment][file1]", "");
        AddForm(form, "data[hidden_top_side]", "false");
        AddForm(form, "data[hidden_left_side]", "false");
        AddForm(form, "data[submit]", "提交&查看");
        AddForm(form, "data[template_id]", "1168401106001000017");
        AddForm(form, "data[draft_id]", "0");
        AddForm(form, "data[return_url]", BuildReturnUrl(workspaceId));
        AddForm(form, "data[secret_config]", "");
        AddForm(form, "dsc_token", dscToken);

        var submitUrl = $"https://www.tapd.cn/{Uri.EscapeDataString(workspaceId)}/bugtrace/bugs/submit_from_add/0/security?return_url={Uri.EscapeDataString(BuildReturnUrl(workspaceId))}";
        using var httpReq = new HttpRequestMessage(HttpMethod.Post, submitUrl)
        {
            Content = form
        };
        httpReq.Headers.TryAddWithoutValidation("Cookie", cookie.Trim());
        httpReq.Headers.TryAddWithoutValidation("Origin", "https://www.tapd.cn");
        httpReq.Headers.TryAddWithoutValidation("Referer", $"https://www.tapd.cn/{workspaceId}/bugtrace/bugs/add");
        httpReq.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36");
        httpReq.Headers.TryAddWithoutValidation("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

        var client = _httpClientFactory.CreateClient("TapdBugAgent");
        using var resp = await client.SendAsync(httpReq, HttpCompletionOption.ResponseHeadersRead, CancellationToken.None);
        var location = resp.Headers.Location?.ToString() ?? string.Empty;
        if ((int)resp.StatusCode is >= 300 and < 400 && !string.IsNullOrWhiteSpace(location))
        {
            var bugUrl = NormalizeTapdLocation(location);
            var bugId = ExtractBugId(bugUrl);
            return new TapdBugSubmitResult(true, bugId, bugUrl, draft.Title, (int)resp.StatusCode, null);
        }

        var body = await resp.Content.ReadAsStringAsync(CancellationToken.None);
        var excerpt = body.Length > 500 ? body[..500] : body;
        _logger.LogWarning("[tapd-bug-agent] TAPD submit failed status={Status} body={Body}", (int)resp.StatusCode, excerpt);
        return new TapdBugSubmitResult(false, null, null, draft.Title, (int)resp.StatusCode, $"TAPD 返回 HTTP {(int)resp.StatusCode}");
    }

    public static string BuildDescriptionHtml(
        IReadOnlyList<string> preconditions,
        IReadOnlyList<string> steps,
        IReadOnlyList<string> actualResult,
        IReadOnlyList<string> expectedResult)
    {
        return $"""
            <h3>前置条件</h3>
            {ToOrderedList(preconditions)}
            <h3>复现步骤</h3>
            {ToOrderedList(steps)}
            <h3>实际结果</h3>
            {ToOrderedList(actualResult)}
            <h3>预期结果</h3>
            {ToOrderedList(expectedResult)}
            <p><br></p>
            """.Trim();
    }

    public static TapdBugDraft NormalizeDraft(TapdBugDraft? draft, string? naturalText)
    {
        draft ??= new TapdBugDraft();
        var normalized = draft with
        {
            Title = NormalizeTitle(draft.Title, naturalText),
            Module = FirstNonEmpty(draft.Module, DefaultModule)!,
            Severity = NormalizeSeverity(draft.Severity),
            Priority = NormalizePriority(draft.Priority),
            BugType = NormalizeBugType(draft.BugType),
            CurrentOwner = FirstNonEmpty(draft.CurrentOwner, DefaultOwner)!,
            VersionReport = FirstNonEmpty(draft.VersionReport, DefaultVersionReport)!,
            Preconditions = NormalizeLines(draft.Preconditions),
            Steps = NormalizeLines(draft.Steps),
            ActualResult = NormalizeLines(draft.ActualResult),
            ExpectedResult = NormalizeLines(draft.ExpectedResult),
            MissingFields = new List<string>()
        };

        normalized = AutoFillRequiredFields(normalized, naturalText);

        var missing = new List<string>();
        if (string.IsNullOrWhiteSpace(normalized.Title)) missing.Add("标题");
        if (normalized.Preconditions.Count == 0) missing.Add("前置条件");
        if (normalized.Steps.Count == 0) missing.Add("复现步骤");
        if (normalized.ActualResult.Count == 0) missing.Add("实际结果");
        if (normalized.ExpectedResult.Count == 0) missing.Add("预期结果");
        return normalized with { MissingFields = missing };
    }

    public static TapdBugDraft ParseDraftFromLlm(string raw)
    {
        var s = raw.Trim();
        if (s.StartsWith("```", StringComparison.Ordinal))
        {
            var nl = s.IndexOf('\n');
            if (nl >= 0) s = s[(nl + 1)..];
            if (s.EndsWith("```", StringComparison.Ordinal)) s = s[..^3];
        }

        var start = s.IndexOf('{');
        var end = s.LastIndexOf('}');
        if (start >= 0 && end > start) s = s[start..(end + 1)];

        try
        {
            using var doc = JsonDocument.Parse(s);
            var root = doc.RootElement;
            return new TapdBugDraft
            {
                Title = GetString(root, "title") ?? string.Empty,
                Module = GetString(root, "module") ?? string.Empty,
                Severity = GetString(root, "severity") ?? string.Empty,
                Priority = GetString(root, "priority") ?? string.Empty,
                BugType = GetString(root, "bugType") ?? string.Empty,
                CurrentOwner = GetString(root, "currentOwner") ?? string.Empty,
                VersionReport = GetString(root, "versionReport") ?? string.Empty,
                Preconditions = GetStringList(root, "preconditions"),
                Steps = GetStringList(root, "steps"),
                ActualResult = GetStringList(root, "actualResult"),
                ExpectedResult = GetStringList(root, "expectedResult"),
                MissingFields = GetStringList(root, "missingFields"),
            };
        }
        catch
        {
            return new TapdBugDraft();
        }
    }

    private static TapdBugDraft MergeDrafts(TapdBugDraft baseDraft, TapdBugDraft parsed)
    {
        return parsed with
        {
            Title = FirstNonEmpty(parsed.Title, baseDraft.Title) ?? "",
            Module = FirstNonEmpty(parsed.Module, baseDraft.Module) ?? "",
            Severity = FirstNonEmpty(parsed.Severity, baseDraft.Severity) ?? "",
            Priority = FirstNonEmpty(parsed.Priority, baseDraft.Priority) ?? "",
            BugType = FirstNonEmpty(parsed.BugType, baseDraft.BugType) ?? "",
            CurrentOwner = FirstNonEmpty(parsed.CurrentOwner, baseDraft.CurrentOwner) ?? "",
            VersionReport = FirstNonEmpty(parsed.VersionReport, baseDraft.VersionReport) ?? "",
            Preconditions = parsed.Preconditions.Count > 0 ? parsed.Preconditions : baseDraft.Preconditions,
            Steps = parsed.Steps.Count > 0 ? parsed.Steps : baseDraft.Steps,
            ActualResult = parsed.ActualResult.Count > 0 ? parsed.ActualResult : baseDraft.ActualResult,
            ExpectedResult = parsed.ExpectedResult.Count > 0 ? parsed.ExpectedResult : baseDraft.ExpectedResult,
        };
    }

    private static TapdBugDraft BuildFallbackDraft(string naturalText, TapdBugDraft baseDraft)
    {
        return baseDraft with
        {
            Title = FirstNonEmpty(baseDraft.Title, naturalText) ?? "",
            ActualResult = baseDraft.ActualResult.Count > 0 ? baseDraft.ActualResult : NormalizeLines(new[] { naturalText }),
        };
    }

    private static string BuildSystemPrompt()
    {
        return """
            你是 TAPD 缺陷自动提报智能体，负责把用户口语化缺陷描述整理为标准缺陷草稿。
            严格规则：
            1. 只能输出严格 JSON，不要输出 Markdown、解释、代码围栏。
            2. 必须尽量基于用户原话合理补齐四要素。信息不足时使用“进入出现该问题的页面/执行描述中的操作/观察异常结果/不应出现异常错误”等可核对表述，不要让四要素为空。
            3. 标题格式为“场景 + 问题现象”，不超过 30 个中文字符。
            4. 四要素必须拆成数组：preconditions、steps、actualResult、expectedResult。
            5. 默认 module/versionReport 为“附近门店组件精准筛选”，currentOwner 为“黄卫杰;”。
            6. severity 只能是 fatal/serious/normal/minor，默认 serious；priority 只能是 urgent/high/medium/low，默认 high。
            7. bugType 只能是 逻辑错误/不符方案/功能遗漏/历史缺陷/产品缺陷，默认 逻辑错误。
            返回 JSON 字段：
            title, module, severity, priority, bugType, currentOwner, versionReport,
            preconditions, steps, actualResult, expectedResult, missingFields
            """;
    }

    private static string BuildUserPrompt(string naturalText, TapdBugDraft draft)
    {
        var draftJson = JsonSerializer.Serialize(draft, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
        return $"""
            用户原始描述：
            {naturalText}

            用户已填写或上次生成的草稿：
            {draftJson}
            """;
    }

    private static string ToOrderedList(IReadOnlyList<string> lines)
    {
        var items = NormalizeLines(lines)
            .Select(line => $"<li>{WebUtility.HtmlEncode(line)}</li>");
        return "<ol>" + string.Concat(items) + "</ol>";
    }

    private static TapdBugDraft AutoFillRequiredFields(TapdBugDraft draft, string? naturalText)
    {
        var source = FirstNonEmpty(naturalText, draft.Title) ?? string.Empty;
        if (string.IsNullOrWhiteSpace(source))
            return draft;

        var title = FirstNonEmpty(draft.Title, source) ?? string.Empty;
        return draft with
        {
            Preconditions = draft.Preconditions.Count > 0
                ? draft.Preconditions
                : BuildInferredPreconditions(),
            Steps = draft.Steps.Count > 0
                ? draft.Steps
                : BuildInferredSteps(source, title),
            ActualResult = draft.ActualResult.Count > 0
                ? draft.ActualResult
                : BuildInferredActualResult(source),
            ExpectedResult = draft.ExpectedResult.Count > 0
                ? draft.ExpectedResult
                : BuildInferredExpectedResult(source),
        };
    }

    private static List<string> BuildInferredPreconditions()
    {
        return new List<string>
        {
            "已登录系统并进入出现该问题的功能页面",
            "当前账号具备执行该操作的权限"
        };
    }

    private static List<string> BuildInferredSteps(string source, string title)
    {
        var steps = new List<string> { "进入出现该问题的功能页面" };
        var action = InferActionStep(source, title);
        if (!string.IsNullOrWhiteSpace(action)) steps.Add(action);
        steps.Add("观察页面提示或接口返回结果");
        return steps;
    }

    private static string InferActionStep(string source, string title)
    {
        var text = source + " " + title;
        if (text.Contains("汉字", StringComparison.Ordinal))
            return "在相关输入框中输入汉字内容并提交或保存";
        if (text.Contains("筛选", StringComparison.Ordinal))
            return "按描述选择筛选条件并确认筛选";
        if (text.Contains("点击", StringComparison.Ordinal))
            return "按描述点击对应按钮或入口";
        if (text.Contains("上传", StringComparison.Ordinal))
            return "按描述上传对应文件或素材";
        if (text.Contains("保存", StringComparison.Ordinal))
            return "按描述填写内容后点击保存";
        return "按用户描述执行对应操作";
    }

    private static List<string> BuildInferredActualResult(string source)
    {
        var trimmed = source.Trim();
        return new List<string>
        {
            trimmed.Length > 0 ? trimmed : "执行操作后出现异常现象"
        };
    }

    private static List<string> BuildInferredExpectedResult(string source)
    {
        if (source.Contains("502", StringComparison.Ordinal))
        {
            return new List<string>
            {
                "系统应正常处理该输入或给出明确的业务校验提示",
                "页面不应出现 502 错误"
            };
        }

        if (source.Contains("筛选", StringComparison.Ordinal))
        {
            return new List<string>
            {
                "系统应按照所选条件正确过滤并展示匹配结果"
            };
        }

        return new List<string>
        {
            "系统应按业务规则正常完成该操作，并给出清晰结果反馈"
        };
    }

    private static List<string> NormalizeLines(IEnumerable<string>? lines)
    {
        return (lines ?? Array.Empty<string>())
            .SelectMany(line => (line ?? string.Empty).Split('\n', StringSplitOptions.RemoveEmptyEntries))
            .Select(line => line.Trim())
            .Select(line => System.Text.RegularExpressions.Regex.Replace(line, @"^\s*\d+[\.、)]\s*", ""))
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Distinct()
            .Take(20)
            .ToList();
    }

    private static string NormalizeTitle(string? title, string? naturalText)
    {
        var value = FirstNonEmpty(title, naturalText) ?? string.Empty;
        value = value.Replace('\n', ' ').Replace('\r', ' ').Trim();
        value = System.Text.RegularExpressions.Regex.Replace(value, @"\s+", " ");
        return value.Length > 30 ? value[..30] : value;
    }

    private static string NormalizeSeverity(string? value)
    {
        value = value?.Trim() switch
        {
            "致命" => "fatal",
            "主要" => "serious",
            "普通" => "normal",
            "提示" => "minor",
            var x => x
        };
        return value != null && SeverityValues.Contains(value) ? value : "serious";
    }

    private static string NormalizePriority(string? value)
    {
        value = value?.Trim() switch
        {
            "紧急" => "urgent",
            "高" => "high",
            "中" => "medium",
            "低" => "low",
            var x => x
        };
        return value != null && PriorityValues.Contains(value) ? value : "high";
    }

    private static string NormalizeBugType(string? value)
    {
        value = value?.Trim();
        return value != null && BugTypeValues.Contains(value) ? value : "逻辑错误";
    }

    private static bool HasMinimumDraft(TapdBugDraft draft)
    {
        return !string.IsNullOrWhiteSpace(draft.Title)
            && draft.Preconditions.Count > 0
            && draft.Steps.Count > 0
            && draft.ActualResult.Count > 0
            && draft.ExpectedResult.Count > 0;
    }

    private static string? GetString(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static List<string> GetStringList(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var value)) return new List<string>();
        if (value.ValueKind == JsonValueKind.String) return NormalizeLines(new[] { value.GetString() ?? "" });
        if (value.ValueKind != JsonValueKind.Array) return new List<string>();
        return NormalizeLines(value.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => x.GetString() ?? ""));
    }

    private static void AddForm(MultipartFormDataContent form, string name, string? value)
    {
        form.Add(new StringContent(value ?? string.Empty, Encoding.UTF8), name);
    }

    private static string BuildReturnUrl(string workspaceId)
    {
        return $"https://www.tapd.cn/tapd_fe/{Uri.EscapeDataString(workspaceId)}/bug/list";
    }

    private static string NormalizeTapdLocation(string location)
    {
        if (Uri.TryCreate(location, UriKind.Absolute, out var absolute))
            return absolute.ToString();
        if (location.StartsWith("/", StringComparison.Ordinal))
            return "https://www.tapd.cn" + location;
        return "https://www.tapd.cn/" + location.TrimStart('/');
    }

    private static string? ExtractBugId(string url)
    {
        var match = System.Text.RegularExpressions.Regex.Match(url, @"/(?:view|detail)/(\d+)");
        return match.Success ? match.Groups[1].Value : null;
    }

    private static string? ExtractCookieValue(string cookie, string key)
    {
        foreach (var segment in cookie.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var idx = segment.IndexOf('=');
            if (idx <= 0) continue;
            if (string.Equals(segment[..idx].Trim(), key, StringComparison.OrdinalIgnoreCase))
                return segment[(idx + 1)..].Trim();
        }
        return null;
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        return values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();
    }
}

public sealed record TapdBugPreviewRequest
{
    public string? NaturalText { get; init; }
    public TapdBugDraft? Overrides { get; init; }
}

public sealed record TapdBugSubmitRequest
{
    public string? Cookie { get; init; }
    public string? WorkspaceId { get; init; }
    public string? AddBugToken { get; init; }
    public string? DscToken { get; init; }
    public bool Confirmed { get; init; }
    public TapdBugDraft? Draft { get; init; }
}

public sealed record TapdBugDraft
{
    public string Title { get; init; } = string.Empty;
    public string Module { get; init; } = TapdBugAgentService.DefaultModule;
    public string Severity { get; init; } = "serious";
    public string Priority { get; init; } = "high";
    public string BugType { get; init; } = "逻辑错误";
    public string CurrentOwner { get; init; } = TapdBugAgentService.DefaultOwner;
    public string VersionReport { get; init; } = TapdBugAgentService.DefaultVersionReport;
    public List<string> Preconditions { get; init; } = new();
    public List<string> Steps { get; init; } = new();
    public List<string> ActualResult { get; init; } = new();
    public List<string> ExpectedResult { get; init; } = new();
    public List<string> MissingFields { get; init; } = new();
}

public sealed record TapdBugSubmitResult(
    bool Success,
    string? BugId,
    string? BugUrl,
    string Title,
    int StatusCode,
    string? Error);
