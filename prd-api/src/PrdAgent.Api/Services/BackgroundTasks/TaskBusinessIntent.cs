using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.LlmGateway;
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
        try
        {
            using var body = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: ct);
            return body.RootElement.ValueKind == JsonValueKind.Object && body.RootElement.TryGetProperty("method", out var method)
                && method.ValueKind == JsonValueKind.String && method.GetString() == "tools/call";
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
                parameters.Append(Canonical(body.RootElement));
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
