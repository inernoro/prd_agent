using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.BackgroundTasks;

public enum TaskAdmissionTiming
{
    Middleware,
    AuthenticatedPaidBranch,
}

public sealed record TaskAdmissionPolicy(string Operation, IReadOnlyList<string> AppCallers,
    int InteractiveMaxCalls = 128, bool AllowDelegatedSubjects = false, int AgentMaxCalls = 16,
    TaskAdmissionTiming Timing = TaskAdmissionTiming.Middleware);

/// <summary>
/// 集中登记已批准的付费操作。新增 action 不自动继承控制器的执行权；调用方范围在签发时冻结。
/// 业务可以新增普通 CRUD，但忘记登记任务时统一出口会拒绝付费。
/// </summary>
public static class TaskAdmissionPolicies
{
    private static readonly IReadOnlyDictionary<string, TaskAdmissionPolicy> Policies = Build();
    public static IReadOnlyCollection<string> Operations => Policies.Keys.ToArray();
    public static TaskAdmissionPolicy? Find(string controllerType, string action)
        => Policies.GetValueOrDefault($"{controllerType}.{action}");

    private static IReadOnlyDictionary<string, TaskAdmissionPolicy> Build()
    {
        var result = new Dictionary<string, TaskAdmissionPolicy>(StringComparer.Ordinal);
        // 多能力工具与工作流只可用平台注册的有限能力，不接受未注册 caller 或任意字符串。
        var all = AppCallerRegistrationService.GetAllDefinitions().Select(x => x.AppCode).Distinct().ToArray();
        Add("ModelLabController", "RunStream", new[] { "prd-agent-web.model-lab." });
        Register("LlmGatewayOpsCanaryController", "RunAsrCanary",
            new[] { AppCallerRegistry.TranscriptAgent.Transcribe.Audio }, false, 1, 1);
        Add("MessagesController", "SendMessage ResendMessage", new[] { "prd-agent-desktop.", "prd-agent.guide", "prd-agent.skill-gen" }, root: true);
        Add("ChatRunsController", "CreateRun", new[] { "prd-agent-desktop.", "prd-agent.guide", "prd-agent.skill-gen" }, root: true);
        Register("IntentController", "SuggestGroupName",
            new[] { AppCallerRegistry.Desktop.GroupName.SuggestIntent }, true, 128);
        Register("GroupsController", "Create",
            new[] { AppCallerRegistry.Desktop.GroupName.SuggestIntent }, true, 1, 1,
            timing: TaskAdmissionTiming.AuthenticatedPaidBranch);
        Add("GapsController", "GenerateSummaryReport", new[] { "prd-agent-desktop.gap." }, root: true);
        Add("PrdAgentSkillsController", "Execute GenerateFromMessage GenerateFromConversation", new[] { "prd-agent." }, root: true);
        Add("ImageGenController", "StoryboardScript Plan ClarifyPrompt Generate Compose BatchStream CreateRun", new[] { "visual-agent." });
        Add("ImageMasterController", "GenerateWorkspaceTitle CreateWorkspaceImageGenRun AddMessage AddWorkspaceMessage DescribeAsset", new[] { "visual-agent." });
        Register("ImageMasterController", "GenerateArticleMarkers",
            new[] { AppCallerRegistry.LiteraryAgent.Content.Chat }, false, 128);
        Register("ImageMasterController", "DrawingBoardChat",
            new[] { AppCallerRegistry.VisualAgent.DrawingBoard.Chat }, false, 128);
        Add("ProfileController", "CreateAvatarGenerationRun", new[] { "visual-agent." });
        Add("VisualOpenApiController", "Generate", new[] { "visual-agent.", "open-api." });
        Add("LiteraryPromptsController", "Optimize", new[] { "literary-agent." });
        Add("LiteraryAgentImageGenController", "CreateRun", new[] { "literary-agent.", "visual-agent." });
        Add("LiteraryOpenApiController", "WriteContent UpdateIllustrationPrompt", new[] { "literary-agent.", "visual-agent." });
        Add("LiteraryImageOpenApiController", "Generate", new[] { "literary-agent.", "visual-agent." });
        Add("VideoAgentController", "VideoGenDirect CreateRun RegenerateScene RenderScene RenderScenes CreateV2dRun", new[] { "video-agent.", "visual-agent.", "workflow-agent." });
        Add("TranscriptAgentController", "UploadItem CreateCopywriteRun", new[] { "transcript-agent." });
        Add("DocumentStoreController", "CreativePublishEntry SelectionRewrite GenerateSubtitle TranscribeEntry RestyleTranscribeRun Reprocess SendReprocessChat StartRecordingUpload CompleteRecordingUpload RetryRecordingArchive LiveTranscription StartAutoLink", new[] { "document-store.", "transcript-agent.", "prd-agent-web.web-hosting.", "md-to-ppt-agent." });
        Add("ShortVideoMaterialController", "CreateRun", new[] { "video-agent.", "workflow-agent.", "transcript-agent.", "document-store." });
        Add("DesignArtifactsController", "CreateRun", new[] { "prd-agent-web.web-hosting.", "md-to-ppt-agent." }, maxCalls: 256);
        Add("HostedSiteEditsController", "CreateRun", new[] { "prd-agent-web.web-hosting.", "md-to-ppt-agent." }, maxCalls: 256);
        Add("WebPageAskController", "RegenerateAskQuestions AskStream AskStreamByShare", new[] { "prd-agent-web.web-hosting." });
        Add("WeeklyPosterController", "Autopilot AutopilotStream GeneratePageImage GenerateImagesRun", new[] { "report-agent.", "visual-agent." });
        Add("ReportAgentController", "GenerateReport GenerateTeamSummary ImportReportFromMarkdown PolishDailyLogItem RunTeamWorkflow", new[] { "report-agent.", "workflow-agent." });
        Add("ReportAgentController", "CreateReport", new[] { "report-agent.", "workflow-agent." },
            timing: TaskAdmissionTiming.AuthenticatedPaidBranch);
        Add("DefectAgentController", "CreateDefect UpdateDefect SubmitDefect SendMessage CreateBatchShareWithScoring AiComment PolishDefect PolishDefectStream AnalyzeImage StartAutomationRun StartNextAutomationWorkflow", new[] { "defect-agent.", "workflow-agent.", "visual-agent." });
        Register("DefectAgentController", "StreamScores",
            new[] { AppCallerRegistry.DefectAgent.Scoring.Chat }, false, 128,
            timing: TaskAdmissionTiming.AuthenticatedPaidBranch);
        Register("ReviewAgentController", "StreamReviewResult",
            new[] { AppCallerRegistry.ReviewAgent.Review.Chat }, false, 128,
            timing: TaskAdmissionTiming.AuthenticatedPaidBranch);
        Register("PrReviewController", "StreamSummary",
            new[] { AppCallerRegistry.PrReview.Summary.Chat }, false, 128);
        Register("PrReviewController", "StreamAlignment",
            new[] { AppCallerRegistry.PrReview.Alignment.Chat }, false, 128);
        Add("ReviewAssessmentController", "CreateAssessment RerunAssessment", new[] { "review-agent." });
        Add("ProductAgentController", "SummarizeItem RelationAnalysis AssistantAsk AiFillRequirement GenerateConsult RestyleConsult", new[] { "product-agent." });
        Add("TeamActivityController", "InsightBriefStream EndpointDiagnoseStream", new[] { "prd-admin.team-activity." });
        Add("ChangelogController", "AiSummary", new[] { "prd-admin.changelog." });
        Add("AiNewsController", "Commentary", new[] { "prd-admin.ai-news." }, root: true);
        Add("TutorialEmailController", "GenerateTemplate", new[] { "tutorial-email." });
        Add("EmailAgentController", "DraftStream PolishStream", new[] { "email-agent." });
        Add("FrontEndAgentController", "AssistStream", new[] { "front-end-agent." });
        Add("MdToPptController", "Convert Outline OutlineStream ConfirmOutline Patch Prewarm Publish", new[] { "md-to-ppt-agent.", "prd-agent-web.web-hosting." }, maxCalls: 256);
        Register("MdToPptController", "CreateTemplate",
            new[] { AppCallerRegistry.MdToPptAgent.Template.Extract }, false, 128);
        Add("SpeechAgentController", "GenerateMindmap GenerateNodeImage GenerateNodeNotes GenerateNotesBatch RewriteNode CreateFromDocument", new[] { "speech-agent.", "document-store." });
        Add("PmAgentController", "Decompose GoalDecompose AssistantAsk GenerateBriefing GenerateClosureReport GenerateHealthDiagnosis SuggestMilestones RefineBriefing RestyleBriefing", new[] { "pm-agent." });
        Add("SkillAgentController", "SendMessage TestSkill AutoTest ExportSkillZip", new[] { "skill-agent.", "prd-agent." });
        Add("MarketplaceSkillsController", "DraftDescription", new[] { "marketplace-skill." });
        Register("MarketplaceSkillsController", "Upload",
            new[] { AppCallerRegistry.MarketplaceSkill.Summary }, false, 128,
            timing: TaskAdmissionTiming.AuthenticatedPaidBranch);
        Add("EmergenceController", "ExploreNode EmergeTree", new[] { "emergence-explorer." });
        Add("PaAgentController", "Chat ReviewRun", new[] { "pa-agent." });
        Add("BookshelfController", "StreamDigest", new[] { "prd-agent.bookshelf." });
        Add("TaskTreeController", "ExtractNode", new[] { "task-tree-agent." });
        Add("ActiveTasksImportController", "SplitStream", new[] { "active-tasks." });
        Add("ActiveTaskSuggestionsController", "AbsorbStream", new[] { "active-tasks." });
        Add("CcasAgentController", "GeneratePrdStream RevisePrdStream GenerateEquipment QaStream SqlAiStream ParseFlowStream", new[] { "ccas-agent." });
        Add("ShituAgentController", "QaStream", new[] { "shitu-agent." });
        Add("ProjectRouteAgentController", "AnalyzePlanStream", new[] { "project-route-agent." });
        Add("ChannelTraceAgentController", "ImportKnowledge AskKnowledge ImportCases DiagnoseAsk CompareDiff", new[] { "channel-trace-agent." });
        Add("ChatAgentController", "SendMessage", new[] { "chat-agent.", "visual-agent." });
        Add("InfraAgentSessionsController", "SendMessage Start", new[] { "infra-agent.", "chat-agent." });
        Add("InfraAgentRuntimeProfilesController", "Test", new[] { "infra-agent." });
        Add("ExchangeController", "TryModel TestExchange TestExchangeWithAudio TestStreamAsrSse", new[] { "prd-agent-web.lab::", "document-store.subtitle", "self-test." });
        Add("StreamAsrTestController", "TestStreamAsr TestStreamAsrSse", new[] { "document-store.subtitle", "self-test." });
        Add("OpenApiController", "ChatCompletions ImageGenerations", new[] { "open-api.", "open-platform-agent.", "visual-agent." }, root: true);
        Add("OpenPlatform.OpenPlatformChatController", "ChatCompletionsPostV1 ChatCompletionsPost ChatCompletionsGetV1 ChatCompletionsGet", new[] { "open-platform-agent." }, root: true);
        AddAll("AiToolboxController", "Chat Analyze ExecuteRun RunItem TriggerWorkflow DirectChat CapabilityChat");
        AddAll("WorkflowAgentController", "TestRunCapsule ExecuteWorkflow ResumeFromNode ContinueExecution ReplayNode AiFillParameters ChatCreateWorkflow AnalyzeExecution");
        AddAll("AgentUniverseController", "Invoke");
        AddAll("ArenaController", "CreateRun CreateBattle");
        AddAll("McpGatewayController", "Handle", root: true);
        AddAll("ShortcutsController", "Collect", root: true);
        // 名称校对与新增登记由接线回归验证；未登记的新 action 永远不会因所属控制器而获权。
        return result;

        void Add(string controller, string actions, string[] prefixes, bool root = false, int maxCalls = 128,
            TaskAdmissionTiming timing = TaskAdmissionTiming.Middleware)
        {
            var callers = all.Where(code => prefixes.Any(prefix => code.StartsWith(prefix, StringComparison.Ordinal))).ToArray();
            Register(controller, actions, callers, root, maxCalls, timing: timing);
        }
        void AddAll(string controller, string actions, bool root = false) => Register(controller, actions, all, root, 128);
        void Register(string controller, string actions, string[] callers, bool root, int maxCalls, int agentMaxCalls = 16,
            TaskAdmissionTiming timing = TaskAdmissionTiming.Middleware)
        {
            var type = $"PrdAgent.Api.Controllers.{(root ? "" : "Api.")}{controller}";
            foreach (var action in actions.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                var key = $"{type}.{action}";
                // 继续已存在的工作流可由其管理者代办。其它操作不默认获得委托主体权限。
                var delegated = controller == "WorkflowAgentController"
                    && action is "ContinueExecution" or "ResumeFromNode" or "ReplayNode";
                result.Add(key, new(key, callers, maxCalls, delegated, agentMaxCalls, timing));
            }
        }
    }
}
