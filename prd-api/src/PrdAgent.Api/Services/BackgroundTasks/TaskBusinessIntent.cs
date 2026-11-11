using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.BackgroundTasks;

/// <summary>提交意图与参数指纹的唯一构造处；不从提示词推断业务相同，不包含实例与版本。</summary>
public sealed record TaskBusinessIntent(string Key, string Fingerprint, string Scope)
{
    // 阶段1已存在的交互入口兼容快照。新增业务默认要求 Idempotency-Key，不能随策略注册自动放宽。
    private static readonly HashSet<string> LegacyInteractiveOperations = new[]
    {
        "PrdAgent.Api.Controllers.Api.ModelLabController|RunStream",
        "PrdAgent.Api.Controllers.Api.PlatformsController|ReclassifyModels",
        "PrdAgent.Api.Controllers.Api.LlmGatewayOpsCanaryController|RunAsrCanary",
        "PrdAgent.Api.Controllers.MessagesController|SendMessage ResendMessage",
        "PrdAgent.Api.Controllers.ChatRunsController|CreateRun",
        "PrdAgent.Api.Controllers.IntentController|SuggestGroupName",
        "PrdAgent.Api.Controllers.GroupsController|Create",
        "PrdAgent.Api.Controllers.GapsController|GenerateSummaryReport",
        "PrdAgent.Api.Controllers.PrdAgentSkillsController|Execute GenerateFromMessage GenerateFromConversation",
        "PrdAgent.Api.Controllers.Api.ImageGenController|StoryboardScript Plan ClarifyPrompt Generate Compose BatchStream CreateRun",
        "PrdAgent.Api.Controllers.Api.ImageMasterController|GenerateWorkspaceTitle CreateWorkspaceImageGenRun AddMessage AddWorkspaceMessage DescribeAsset",
        "PrdAgent.Api.Controllers.Api.ImageMasterController|GenerateArticleMarkers",
        "PrdAgent.Api.Controllers.Api.ImageMasterController|DrawingBoardChat",
        "PrdAgent.Api.Controllers.Api.ProfileController|CreateAvatarGenerationRun",
        "PrdAgent.Api.Controllers.Api.VisualOpenApiController|Generate",
        "PrdAgent.Api.Controllers.Api.LiteraryPromptsController|Optimize",
        "PrdAgent.Api.Controllers.Api.LiteraryAgentImageGenController|CreateRun",
        "PrdAgent.Api.Controllers.Api.LiteraryOpenApiController|WriteContent UpdateIllustrationPrompt",
        "PrdAgent.Api.Controllers.Api.LiteraryImageOpenApiController|Generate",
        "PrdAgent.Api.Controllers.Api.VideoAgentController|VideoGenDirect CreateRun RegenerateScene RenderScene RenderScenes CreateV2dRun",
        "PrdAgent.Api.Controllers.Api.TranscriptAgentController|UploadItem CreateCopywriteRun",
        "PrdAgent.Api.Controllers.Api.DocumentStoreController|CreativePublishEntry SelectionRewrite GenerateSubtitle TranscribeEntry RestyleTranscribeRun Reprocess SendReprocessChat StartRecordingUpload CompleteRecordingUpload RetryRecordingArchive LiveTranscription StartAutoLink",
        "PrdAgent.Api.Controllers.Api.ShortVideoMaterialController|CreateRun",
        "PrdAgent.Api.Controllers.Api.DesignArtifactsController|CreateRun",
        "PrdAgent.Api.Controllers.Api.HostedSiteEditsController|CreateRun",
        "PrdAgent.Api.Controllers.Api.WebPageAskController|RegenerateAskQuestions AskStream AskStreamByShare",
        "PrdAgent.Api.Controllers.Api.WeeklyPosterController|Autopilot AutopilotStream GeneratePageImage GenerateImagesRun",
        "PrdAgent.Api.Controllers.Api.ReportAgentController|GenerateReport GenerateTeamSummary ImportReportFromMarkdown PolishDailyLogItem RunTeamWorkflow",
        "PrdAgent.Api.Controllers.Api.ReportAgentController|CreateReport",
        "PrdAgent.Api.Controllers.Api.DefectAgentController|CreateDefect UpdateDefect SubmitDefect SendMessage CreateBatchShareWithScoring AiComment PolishDefect PolishDefectStream AnalyzeImage StartAutomationRun StartNextAutomationWorkflow",
        "PrdAgent.Api.Controllers.Api.DefectAgentController|StreamScores",
        "PrdAgent.Api.Controllers.Api.ReviewAgentController|StreamReviewResult",
        "PrdAgent.Api.Controllers.Api.PrReviewController|StreamSummary",
        "PrdAgent.Api.Controllers.Api.PrReviewController|StreamAlignment",
        "PrdAgent.Api.Controllers.Api.ReviewAssessmentController|CreateAssessment RerunAssessment",
        "PrdAgent.Api.Controllers.Api.ProductAgentController|SummarizeItem RelationAnalysis AssistantAsk AiFillRequirement GenerateConsult RestyleConsult",
        "PrdAgent.Api.Controllers.Api.TeamActivityController|InsightBriefStream EndpointDiagnoseStream",
        "PrdAgent.Api.Controllers.Api.ChangelogController|AiSummary",
        "PrdAgent.Api.Controllers.AiNewsController|Commentary",
        "PrdAgent.Api.Controllers.Api.TutorialEmailController|GenerateTemplate",
        "PrdAgent.Api.Controllers.Api.EmailAgentController|DraftStream PolishStream",
        "PrdAgent.Api.Controllers.Api.FrontEndAgentController|AssistStream",
        "PrdAgent.Api.Controllers.Api.MdToPptController|Convert Outline OutlineStream ConfirmOutline Patch Prewarm Publish",
        "PrdAgent.Api.Controllers.Api.MdToPptController|CreateTemplate",
        "PrdAgent.Api.Controllers.Api.SpeechAgentController|GenerateMindmap GenerateNodeImage GenerateNodeNotes GenerateNotesBatch RewriteNode CreateFromDocument",
        "PrdAgent.Api.Controllers.Api.PmAgentController|Decompose GoalDecompose AssistantAsk GenerateBriefing GenerateClosureReport GenerateHealthDiagnosis SuggestMilestones RefineBriefing RestyleBriefing",
        "PrdAgent.Api.Controllers.Api.SkillAgentController|SendMessage TestSkill AutoTest ExportSkillZip",
        "PrdAgent.Api.Controllers.Api.MarketplaceSkillsController|DraftDescription",
        "PrdAgent.Api.Controllers.Api.MarketplaceSkillsController|Upload",
        "PrdAgent.Api.Controllers.Api.EmergenceController|ExploreNode EmergeTree",
        "PrdAgent.Api.Controllers.Api.PaAgentController|Chat ReviewRun",
        "PrdAgent.Api.Controllers.Api.BookshelfController|StreamDigest",
        "PrdAgent.Api.Controllers.Api.TaskTreeController|ExtractNode",
        "PrdAgent.Api.Controllers.Api.ActiveTasksImportController|SplitStream",
        "PrdAgent.Api.Controllers.Api.ActiveTaskSuggestionsController|AbsorbStream",
        "PrdAgent.Api.Controllers.Api.CcasAgentController|GeneratePrdStream RevisePrdStream GenerateEquipment QaStream SqlAiStream ParseFlowStream",
        "PrdAgent.Api.Controllers.Api.ShituAgentController|QaStream",
        "PrdAgent.Api.Controllers.Api.ProjectRouteAgentController|AnalyzePlanStream",
        "PrdAgent.Api.Controllers.Api.ChannelTraceAgentController|ImportKnowledge AskKnowledge ImportCases DiagnoseAsk CompareDiff",
        "PrdAgent.Api.Controllers.Api.ChatAgentController|SendMessage",
        "PrdAgent.Api.Controllers.Api.InfraAgentSessionsController|SendMessage Start",
        "PrdAgent.Api.Controllers.Api.InfraAgentRuntimeProfilesController|Test",
        "PrdAgent.Api.Controllers.Api.ExchangeController|TryModel TestExchange TestExchangeWithAudio TestStreamAsrSse",
        "PrdAgent.Api.Controllers.Api.StreamAsrTestController|TestStreamAsr TestStreamAsrSse",
        "PrdAgent.Api.Controllers.OpenApiController|ChatCompletions ImageGenerations",
        "PrdAgent.Api.Controllers.OpenPlatform.OpenPlatformChatController|ChatCompletionsPostV1 ChatCompletionsPost ChatCompletionsGetV1 ChatCompletionsGet",
        "PrdAgent.Api.Controllers.Api.AiToolboxController|Chat Analyze ExecuteRun RunItem TriggerWorkflow DirectChat CapabilityChat",
        "PrdAgent.Api.Controllers.Api.WorkflowAgentController|TestRunCapsule ExecuteWorkflow ResumeFromNode ContinueExecution ReplayNode AiFillParameters ChatCreateWorkflow AnalyzeExecution",
        "PrdAgent.Api.Controllers.Api.AgentUniverseController|Invoke",
        "PrdAgent.Api.Controllers.Api.ArenaController|CreateRun CreateBattle",
        "PrdAgent.Api.Controllers.McpGatewayController|Handle",
        "PrdAgent.Api.Controllers.ShortcutsController|Collect",
    }.SelectMany(line => { var parts = line.Split('|'); return parts[1].Split(' ').Select(action => parts[0] + "." + action); }).ToHashSet(StringComparer.Ordinal);

    public static async Task<bool> IsMcpToolCallAsync(HttpContext http, CancellationToken ct)
    {
        http.Request.EnableBuffering();
        http.Request.Body.Position = 0;
        try
        {
            using var body = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: ct);
            var root = body.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("method", out var method)
                || method.ValueKind != JsonValueKind.String || method.GetString() != "tools/call") return false;
            // 只豁免服务端登记的纯 GET 工具；未知、动态和写工具仍须有限任务许可。
            var name = root.TryGetProperty("params", out var p) && p.ValueKind == JsonValueKind.Object
                && p.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
            var tool = McpBuiltinTools.All.FirstOrDefault(t => t.Name == name);
            return tool is null || !string.Equals(tool.Method, "GET", StringComparison.OrdinalIgnoreCase);
        }
        catch (JsonException) { return false; } // 协议错误仍由原 MCP 端点返回，不授予付费权。
        finally { http.Request.Body.Position = 0; }
    }

    public static async Task<TaskBusinessIntent> ResolveAsync(HttpContext http, string operation,
        string origin, bool verifiedVisitor, CancellationToken ct)
    {
        var key = http.Request.Headers["Idempotency-Key"].ToString().Trim();
        var scope = operation + ":" + (http.Request.Path.Value ?? "").ToLowerInvariant();
        var parameters = new StringBuilder(http.Request.Method.ToUpperInvariant());
        foreach (var item in http.Request.Query.OrderBy(x => x.Key, StringComparer.Ordinal))
            parameters.Append(JsonSerializer.Serialize(new { item.Key, Values = item.Value.ToArray() }));

        if (http.Request.HasFormContentType)
        {
            var form = await http.Request.ReadFormAsync(ct);
            foreach (var field in form.OrderBy(x => x.Key, StringComparer.Ordinal))
                parameters.Append(JsonSerializer.Serialize(new { field.Key, Values = field.Value.ToArray() }));
            foreach (var file in form.Files.OrderBy(x => x.Name, StringComparer.Ordinal).ThenBy(x => x.FileName, StringComparer.Ordinal))
            {
                await using var stream = file.OpenReadStream();
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, ct));
                parameters.Append(JsonSerializer.Serialize(new { file.Name, file.FileName, file.ContentType, file.Length, Hash = hash }));
            }
            if (key.Length == 0) key = form["clientRequestId"].ToString().Trim();
        }
        else if (http.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true)
        {
            http.Request.EnableBuffering();
            http.Request.Body.Position = 0;
            try
            {
                using var body = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: ct);
                if (body.RootElement.ValueKind == JsonValueKind.Object)
                {
                    var root = body.RootElement;
                    if (key.Length == 0 && root.TryGetProperty("clientRequestId", out var client) && client.ValueKind == JsonValueKind.String)
                        key = client.GetString()?.Trim() ?? "";
                    if (operation == "PrdAgent.Api.Controllers.McpGatewayController.Handle"
                        && root.TryGetProperty("method", out var method) && method.ValueKind == JsonValueKind.String && method.GetString() == "tools/call")
                    {
                        if (key.Length == 0 && root.TryGetProperty("params", out var p) && p.ValueKind == JsonValueKind.Object
                            && p.TryGetProperty("arguments", out var a) && a.ValueKind == JsonValueKind.Object
                            && a.TryGetProperty("clientRequestId", out var request) && request.ValueKind == JsonValueKind.String)
                            key = request.GetString()?.Trim() ?? "";
                        if (key.Length == 0 && root.TryGetProperty("id", out var rpcId)
                            && rpcId.ValueKind == JsonValueKind.String && Guid.TryParse(rpcId.GetString(), out _))
                            key = "mcp:" + rpcId.GetString();
                    }
                }
                // JSON-RPC id 是传输关联标识，不属于付费操作参数；重试可使用新的 id。
                if (operation == "PrdAgent.Api.Controllers.McpGatewayController.Handle"
                    && body.RootElement.ValueKind == JsonValueKind.Object)
                    parameters.Append(CanonicalMcpRequest(body.RootElement));
                else parameters.Append(Canonical(body.RootElement));
            }
            catch (JsonException)
            {
                throw new TaskExecutionAdmissionException("TASK_REQUEST_INVALID", "任务请求格式不完整，未启动执行；请检查内容后重新提交。", 400);
            }
            finally { http.Request.Body.Position = 0; }
        }
        else if (http.Request.ContentLength is > 0)
        {
            http.Request.EnableBuffering();
            try { parameters.Append(Convert.ToHexString(await SHA256.HashDataAsync(http.Request.Body, ct))); }
            finally { http.Request.Body.Position = 0; }
        }
        if (key.Length == 0)
        {
            if (!verifiedVisitor && (origin == TaskExecutionOrigins.Agent || !LegacyInteractiveOperations.Contains(operation)))
                throw new TaskExecutionAdmissionException("TASK_INTENT_REQUIRED", origin == TaskExecutionOrigins.Agent
                    ? "自动化调用缺少稳定的操作标识，未启动任务；请为同一次提交及重试提供相同的 Idempotency-Key。"
                    : "本次操作尚未建立提交标识，未启动任务；请联系管理员完善提交入口后重试。", 400);
            // 旧的正常页面和已验证分享操作仍可明确发起新请求；不按文本相同吞掉用户操作。
            key = "explicit-request:" + Guid.NewGuid().ToString("N");
        }
        if (key.Length > 256 || key.Any(char.IsControl))
            throw new TaskExecutionAdmissionException("TASK_INTENT_INVALID", "操作标识格式不正确，未启动任务；请使用256字以内的稳定标识。", 400);
        return new(key, TaskExecutionCoordinator.Fingerprint(parameters.ToString()), scope);
    }

    // 真实 SDK 报文已观测的有限传输上下文；不得扩成忽略任意 _meta 或业务 arguments。
    private static readonly HashSet<string> McpTransportMetadataFields = new(StringComparer.Ordinal)
    {
        "callId", "progressToken", "x-codex-turn-metadata", "threadId", "sessionId", "windowId", "itemId"
    };

    private static string CanonicalMcpRequest(JsonElement root)
        => "{" + string.Join(",", root.EnumerateObject().Where(x => x.Name != "id")
            .OrderBy(x => x.Name, StringComparer.Ordinal).Select(x => JsonSerializer.Serialize(x.Name) + ":"
                + (x.Name == "params" && x.Value.ValueKind == JsonValueKind.Object
                    ? CanonicalMcpParameters(x.Value) : Canonical(x.Value)))) + "}";

    private static string CanonicalMcpParameters(JsonElement parameters)
    {
        var fields = new List<string>();
        foreach (var field in parameters.EnumerateObject().OrderBy(x => x.Name, StringComparer.Ordinal))
        {
            if (field.Name == "_meta" && field.Value.ValueKind == JsonValueKind.Object)
            {
                // 已观测的 SDK 调用、进度及会话追踪上下文不是业务提交参数。
                // 仅限此协议路径；其它元数据及 arguments 中同名业务字段仍参与指纹。
                var retained = field.Value.EnumerateObject().Where(x => !McpTransportMetadataFields.Contains(x.Name))
                    .OrderBy(x => x.Name, StringComparer.Ordinal).ToArray();
                if (retained.Length == 0) continue;
                fields.Add(JsonSerializer.Serialize(field.Name) + ":{" + string.Join(",", retained
                    .Select(x => JsonSerializer.Serialize(x.Name) + ":" + Canonical(x.Value))) + "}");
            }
            else fields.Add(JsonSerializer.Serialize(field.Name) + ":" + Canonical(field.Value));
        }
        return "{" + string.Join(",", fields) + "}";
    }

    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", value.EnumerateObject().OrderBy(x => x.Name, StringComparer.Ordinal)
            .Select(x => JsonSerializer.Serialize(x.Name) + ":" + Canonical(x.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", value.EnumerateArray().Select(Canonical)) + "]",
        _ => value.GetRawText()
    };
}

public sealed class TaskAdmissionRequestState
{
    public const string ItemKey = "platform.task.admission.request";
    public TaskExecutionIdentity? Identity { get; set; }
    public List<PrdAgent.Core.Interfaces.TaskExecutionLease> Leases { get; } = new();
    public static TaskAdmissionRequestState Get(HttpContext http)
    {
        if (http.Items[ItemKey] is TaskAdmissionRequestState state) return state;
        var created = new TaskAdmissionRequestState(); http.Items[ItemKey] = created; return created;
    }
}
