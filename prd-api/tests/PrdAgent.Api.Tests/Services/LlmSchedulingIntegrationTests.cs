using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.Integration)]
public class LlmSchedulingIntegrationTests
{
    private readonly ITestOutputHelper _output;

    public LlmSchedulingIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public async Task Scheduling_EndToEnd_AllLlmEntryPoints_LogExpectedResolution()
    {
        var env = EnvConfig.Load();
        using var httpAdmin = new HttpClient { BaseAddress = new Uri(env.ApiBaseUrl), Timeout = TimeSpan.FromSeconds(5) };
        using var httpUser = new HttpClient { BaseAddress = new Uri(env.ApiBaseUrl), Timeout = TimeSpan.FromSeconds(5) };

        // 检测服务器是否可用，不可用则跳过测试
        if (!await IsServerAvailableAsync(httpAdmin, env.ApiBaseUrl))
        {
            _output.WriteLine($"[SKIP] 服务器不可用 ({env.ApiBaseUrl})，跳过集成测试");
            return;
        }

        if (string.IsNullOrWhiteSpace(env.AdminToken))
        {
            var token = await TryLoginRootAsync(httpAdmin, env.RootUsername, env.RootPassword);
            token.ShouldNotBeNull("无法使用 ROOT 账号登录，请确认 ROOT_ACCESS_USERNAME/ROOT_ACCESS_PASSWORD 或提供 PRD_TEST_ADMIN_TOKEN");
            env = env with { AdminToken = token! };
        }

        httpAdmin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", env.AdminToken);
        var pmUser = await EnsurePmUserTokenAsync(httpAdmin);
        httpUser.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", pmUser.Token);

        // 1) 确保 appCaller 存在（用于 prd-agent-web.prompts.optimize::chat）
        var appCallerCode = "prd-agent-web.prompts.optimize::chat";
        var appCaller = await EnsureAppCallerAsync(httpAdmin, appCallerCode);
        var appCallerId = appCaller.Id;
        var originalGroupIds = appCaller.ChatModelGroupIds.ToList();

        var createdGroupIds = new List<string>();
        var results = new List<CaseResult>();

        var logTimeout = TimeSpan.FromSeconds(5);

        try
        {
            var chatModel = await ResolveModelAsync(httpAdmin, preferImageGen: false);
            var imageGenModel = await ResolveModelAsync(httpAdmin, preferImageGen: true);

            var platformId = env.PlatformId ?? chatModel.PlatformId ?? string.Empty;
            var modelId = env.ModelId ?? chatModel.ModelName ?? string.Empty;
            if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelId))
            {
                throw new InvalidOperationException("无法解析 chat 模型 platformId/modelId");
            }

            // 0) 基础数据：上传文档 -> sessionId/headingId
            var doc = await UploadDocumentAsync(httpUser, $"IT PRD {DateTime.UtcNow:HHmmss}");
            var sessionId = doc.SessionId;
            var documentId = doc.DocumentId;
            var headingId = doc.FirstHeadingId;

            // 0.1) 创建群组（会触发群名建议）
            var group = await CreateGroupAsync(httpUser, documentId);
            var groupId = group.GroupId;

            // 0.3) ImageMaster workspace（用于文学创作 markers）
            var workspaceId = await CreateWorkspaceAsync(httpAdmin, "article-illustration");

            // A) 专属模型池
            var dedicatedGroupId = await CreateModelGroupAsync(
                httpAdmin,
                name: $"IT Dedicated Chat {DateTime.UtcNow:HHmmss}",
                code: $"it-dedicated-chat-{Guid.NewGuid():N}".Substring(0, 24),
                modelType: ModelTypes.Chat,
                isDefault: false,
                platformId,
                modelId);
            createdGroupIds.Add(dedicatedGroupId);

            await UpdateBindingsAsync(httpAdmin, appCallerId, ModelTypes.Chat, new List<string> { dedicatedGroupId });

            var startDedicated = DateTime.UtcNow;
            var dedicatedError = await TryCallAsync(() => CallPromptOptimizeAsync(httpAdmin, $"dedicated-{Guid.NewGuid():N}"));
            var (dedicatedLog, dedicatedLogError) = await TryWaitLogAsync(httpAdmin, appCallerCode, startDedicated, logTimeout);
            if (dedicatedLog != null)
            {
                dedicatedLog.ModelResolutionType.ShouldBe(ModelResolutionType.DedicatedPool.ToString());
                dedicatedLog.ModelGroupId.ShouldBe(dedicatedGroupId);
                results.Add(CaseResult.FromLog("admin.prompts.optimize / 专属池", dedicatedLog, "DedicatedPool", dedicatedError));
            }
            else
            {
                results.Add(new CaseResult("admin.prompts.optimize / 专属池", appCallerCode, "DedicatedPool", "MISSING_LOG", null, null, dedicatedError ?? dedicatedLogError));
            }

            // B) 默认模型池（若不存在则创建）
            var defaultGroupId = await EnsureDefaultGroupAsync(httpAdmin, ModelTypes.Chat, platformId, modelId);
            if (defaultGroupId.StartsWith("it-", StringComparison.Ordinal))
            {
                createdGroupIds.Add(defaultGroupId);
            }

            await UpdateBindingsAsync(httpAdmin, appCallerId, ModelTypes.Chat, new List<string>());

            var startDefault = DateTime.UtcNow;
            var defaultError = await TryCallAsync(() => CallPromptOptimizeAsync(httpAdmin, $"default-{Guid.NewGuid():N}"));
            var (defaultLog, defaultLogError) = await TryWaitLogAsync(httpAdmin, appCallerCode, startDefault, logTimeout);
            if (defaultLog != null)
            {
                defaultLog.ModelResolutionType.ShouldBe(ModelResolutionType.DefaultPool.ToString());
                defaultLog.ModelGroupId.ShouldBe(defaultGroupId);
                results.Add(CaseResult.FromLog("admin.prompts.optimize / 默认池", defaultLog, "DefaultPool", defaultError));
            }
            else
            {
                results.Add(new CaseResult("admin.prompts.optimize / 默认池", appCallerCode, "DefaultPool", "MISSING_LOG", null, null, defaultError ?? defaultLogError));
            }

            // C) 直连（显式传 platformId + modelId）
            var startDirect = DateTime.UtcNow;
            if (string.IsNullOrWhiteSpace(imageGenModel.PlatformId) || string.IsNullOrWhiteSpace(imageGenModel.ModelName))
            {
                throw new InvalidOperationException("无法解析 imageGen 模型 platformId/modelId");
            }
            var directError = await TryCallAsync(() => CallImageGenGenerateAsync(httpAdmin, imageGenModel.PlatformId!, imageGenModel.ModelName, $"direct-{Guid.NewGuid():N}"));
            var (directLog, directLogError) = await TryWaitLogAsync(httpAdmin, "visual-agent.image-gen.generate::generation", startDirect, logTimeout);
            if (directLog != null)
            {
                directLog.ModelResolutionType.ShouldBeOneOf(
                    ModelResolutionType.DirectModel.ToString(),
                    ModelResolutionType.Legacy.ToString());
                results.Add(CaseResult.FromLog("image-gen.generate / 直连", directLog, "DirectModel|Legacy", directError));
            }
            else
            {
                results.Add(new CaseResult("image-gen.generate / 直连", "visual-agent.image-gen.generate::generation", "DirectModel|Legacy", "MISSING_LOG", null, null, directError ?? directLogError));
            }

            // D) image-gen.plan（意图模型）
            var startPlan = DateTime.UtcNow;
            var planError = await TryCallAsync(() => CallImageGenPlanAsync(httpAdmin, $"plan-{Guid.NewGuid():N}"));
            var (planLog, planLogError) = await TryWaitLogAsync(httpAdmin, "visual-agent.image-gen.plan::intent", startPlan, logTimeout);
            if (planLog != null)
            {
                planLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("image-gen.plan", planLog, "Any", planError));
            }
            else
            {
                results.Add(new CaseResult("image-gen.plan", "visual-agent.image-gen.plan::intent", "Any", "MISSING_LOG", null, null, planError ?? planLogError));
            }

            // E) image-gen.batch-generate
            var startBatch = DateTime.UtcNow;
            var batchError = await TryCallAsync(() => CallImageGenBatchAsync(httpAdmin, imageGenModel.PlatformId!, imageGenModel.ModelName, $"batch-{Guid.NewGuid():N}"));
            var (batchLog, batchLogError) = await TryWaitLogAsync(httpAdmin, "visual-agent.image-gen.batch-generate::generation", startBatch, logTimeout);
            if (batchLog != null)
            {
                batchLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("image-gen.batch-generate", batchLog, "Any", batchError));
            }
            else
            {
                results.Add(new CaseResult("image-gen.batch-generate", "visual-agent.image-gen.batch-generate::generation", "Any", "MISSING_LOG", null, null, batchError ?? batchLogError));
            }

            // F) open-platform proxy
            var openPlatformKey = await CreateOpenPlatformAppAsync(httpAdmin, pmUser.UserId, groupId);
            var startOpen = DateTime.UtcNow;
            var openError = await TryCallAsync(() => CallOpenPlatformChatAsync(httpAdmin, openPlatformKey, $"open-{Guid.NewGuid():N}", groupId));
            var (openLog, openLogError) = await TryWaitLogAsync(httpAdmin, "open-platform-agent.proxy::chat", startOpen, logTimeout);
            if (openLog != null)
            {
                openLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("open-platform proxy", openLog, "Any", openError));
            }
            else
            {
                results.Add(new CaseResult("open-platform proxy", "open-platform-agent.proxy::chat", "Any", "MISSING_LOG", null, null, openError ?? openLogError));
            }

            // G) platforms reclassify（需要平台）
            if (!string.IsNullOrWhiteSpace(platformId))
            {
                var startReclassify = DateTime.UtcNow;
                var reclassifyError = await TryCallAsync(() => CallPlatformsReclassifyAsync(httpAdmin, platformId));
            var (reclassifyLog, reclassifyLogError) = await TryWaitLogAsync(httpAdmin, "prd-agent-web.platforms.reclassify::chat", startReclassify, logTimeout);
                if (reclassifyLog != null)
                {
                    reclassifyLog.ModelResolutionType.ShouldNotBeNull();
                    results.Add(CaseResult.FromLog("platforms.reclassify", reclassifyLog, "Any", reclassifyError));
                }
                else
                {
                results.Add(new CaseResult("platforms.reclassify", "prd-agent-web.platforms.reclassify::chat", "Any", "MISSING_LOG", null, null, reclassifyError ?? reclassifyLogError));
                }
            }

            // H) preview-ask
            var startPreview = DateTime.UtcNow;
            var previewError = await TryCallAsync(() => CallPreviewAskAsync(httpUser, sessionId, headingId));
            var (previewLog, previewLogError) = await TryWaitLogAsync(httpAdmin, "prd-agent-desktop.preview-ask.section::chat", startPreview, logTimeout);
            if (previewLog != null)
            {
                previewLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("preview-ask", previewLog, "Any", previewError));
            }
            else
            {
                results.Add(new CaseResult("preview-ask", "prd-agent-desktop.preview-ask.section::chat", "Any", "MISSING_LOG", null, null, previewError ?? previewLogError));
            }

            // I) chat run（桌面端聊天）
            var startChat = DateTime.UtcNow;
            var chatError = await TryCallAsync(() => CallChatRunAsync(httpUser, sessionId, $"chat-{Guid.NewGuid():N}"));
            var (chatLog, chatLogError) = await TryWaitLogAsync(httpAdmin, "prd-agent-desktop.chat.sendmessage::chat", startChat, logTimeout);
            if (chatLog != null)
            {
                chatLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("chat.run", chatLog, "Any", chatError));
            }
            else
            {
                results.Add(new CaseResult("chat.run", "prd-agent-desktop.chat.sendmessage::chat", "Any", "MISSING_LOG", null, null, chatError ?? chatLogError));
            }

            // J) gaps summary（需要 gap）
            var startGap = DateTime.UtcNow;
            string? gapError = null;
            bool gapTriggered;
            try
            {
                gapTriggered = await CallGapsSummaryAsync(httpUser, groupId);
            }
            catch (Exception ex)
            {
                gapError = ex.Message;
                gapTriggered = false;
            }
            if (gapTriggered)
            {
                var (gapLog, gapLogError) = await TryWaitLogAsync(httpAdmin, "prd-agent-desktop.gap.summarization::chat", startGap, logTimeout);
                if (gapLog != null)
                {
                    gapLog.ModelResolutionType.ShouldNotBeNull();
                    results.Add(CaseResult.FromLog("gaps.summary", gapLog, "Any", gapError));
                }
                else
                {
                    results.Add(new CaseResult("gaps.summary", "prd-agent-desktop.gap.summarization::chat", "Any", "MISSING_LOG", null, null, gapError ?? gapLogError));
                }
            }
            else
            {
                results.Add(new CaseResult("gaps.summary", "prd-agent-desktop.gap.summarization::chat", "Any", "SKIPPED", null, null, gapError ?? "no gaps"));
            }

            // K) image-master markers（文学创作）
            var startMarkers = DateTime.UtcNow;
            var markersError = await TryCallAsync(() => CallArticleMarkersAsync(httpAdmin, workspaceId, "这是测试文章内容。", "请插入配图标记。"));
            var (markersLog, markersLogError) = await TryWaitLogAsync(httpAdmin, "literary-agent.content::chat", startMarkers, logTimeout);
            if (markersLog != null)
            {
                markersLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("literary markers", markersLog, "Any", markersError));
            }
            else
            {
                results.Add(new CaseResult("literary markers", "literary-agent.content::chat", "Any", "MISSING_LOG", null, null, markersError ?? markersLogError));
            }

            // L) image-master generate title（工作区标题）
            var startTitle = DateTime.UtcNow;
            var titleError = await TryCallAsync(() => CallWorkspaceTitleAsync(httpAdmin, workspaceId, "城市夜景，赛博朋克风格"));
            var (titleLog, titleLogError) = await TryWaitLogAsync(httpAdmin, "visual-agent.workspace-title::intent", startTitle, logTimeout);
            if (titleLog != null)
            {
                titleLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("workspace title", titleLog, "Any", titleError));
            }
            else
            {
                results.Add(new CaseResult("workspace title", "visual-agent.workspace-title::intent", "Any", "MISSING_LOG", null, null, titleError ?? titleLogError));
            }

            // M) group name suggest（由创建群触发）
            var startSuggest = group.CreatedAt;
            var (suggestLog, suggestLogError) = await TryWaitLogAsync(httpAdmin, "prd-agent-desktop.group-name.suggest::intent", startSuggest, logTimeout);
            if (suggestLog != null)
            {
                suggestLog.ModelResolutionType.ShouldNotBeNull();
                results.Add(CaseResult.FromLog("group name suggest", suggestLog, "Any"));
            }
            else
            {
                results.Add(new CaseResult("group name suggest", "prd-agent-desktop.group-name.suggest::intent", "Any", "MISSING_LOG", null, null, suggestLogError));
            }
        }
        finally
        {
            // 恢复绑定
            await UpdateBindingsAsync(httpAdmin, appCallerId, ModelTypes.Chat, originalGroupIds);

            // 清理测试模型池（仅限本测试创建的）
            if (env.ShouldCleanup)
            {
                foreach (var gid in createdGroupIds.Distinct())
                {
                    await TryDeleteModelGroupAsync(httpAdmin, gid);
                }
            }
        }

        PrintResults(results);
    }

    private static async Task CallPromptOptimizeAsync(HttpClient http, string tag)
    {
        var body = new
        {
            role = "PM",
            promptTemplate = $"测试提示词 {tag}",
            mode = "concise",
            title = $"IT {tag}"
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/prompts/optimize/stream")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task CallImageGenGenerateAsync(HttpClient http, string platformId, string modelId, string tag)
    {
        var body = new
        {
            prompt = $"测试图生图 {tag}",
            platformId,
            modelId,
            responseFormat = "url",
            size = "1024x1024"
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/visual-agent/image-gen/generate")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task<DocumentUploadResult> UploadDocumentAsync(HttpClient http, string title)
    {
        var content =
            "# Intro\n" +
            "这是测试文档内容。\n\n" +
            "## Scope\n" +
            "范围说明。\n";

        var body = new { content, title };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/documents")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var data = doc.RootElement.GetProperty("data");
        var sessionId = data.GetProperty("sessionId").GetString()!;
        var documentId = data.GetProperty("document").GetProperty("id").GetString()!;
        return new DocumentUploadResult(sessionId, documentId, "intro", "Intro");
    }

    private static async Task<GroupCreateResult> CreateGroupAsync(HttpClient http, string documentId)
    {
        var body = new { prdDocumentId = documentId };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/groups")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"CreateGroup failed: {(int)resp.StatusCode} {resp.ReasonPhrase} {err}");
        }
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var data = doc.RootElement.GetProperty("data");
        var groupId = data.GetProperty("groupId").GetString()!;
        var createdAt = data.TryGetProperty("createdAt", out var createdAtEl) && createdAtEl.ValueKind == JsonValueKind.String
            ? DateTime.Parse(createdAtEl.GetString()!, null, System.Globalization.DateTimeStyles.RoundtripKind)
            : DateTime.UtcNow;
        return new GroupCreateResult(groupId, createdAt);
    }

    private static async Task<string> CreateWorkspaceAsync(HttpClient http, string scenarioType)
    {
        var body = new { title = "IT Workspace", scenarioType };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/visual-agent/image-master/workspaces")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        return doc.RootElement.GetProperty("data").GetProperty("workspace").GetProperty("id").GetString()!;
    }

    private static async Task CallPreviewAskAsync(HttpClient http, string sessionId, string headingId)
    {
        var body = new { question = "本章要点是什么？", headingId, headingTitle = "Intro" };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/sessions/{sessionId}/preview-ask")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task CallChatRunAsync(HttpClient http, string sessionId, string content)
    {
        var body = new { content };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/sessions/{sessionId}/messages/run")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task<bool> CallGapsSummaryAsync(HttpClient http, string groupId)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/groups/{groupId}/gaps/summary-report")
        {
            Content = JsonContent.Create(new { })
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var report = doc.RootElement.GetProperty("data").GetProperty("report").GetString() ?? string.Empty;
        return !string.Equals(report.Trim(), "暂无内容缺口记录", StringComparison.Ordinal);
    }

    private static async Task CallArticleMarkersAsync(HttpClient http, string workspaceId, string article, string instruction)
    {
        var body = new { articleContent = article, userInstruction = instruction, idempotencyKey = Guid.NewGuid().ToString("N") };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/visual-agent/image-master/workspaces/{workspaceId}/article/generate-markers")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task CallWorkspaceTitleAsync(HttpClient http, string workspaceId, string prompt)
    {
        var body = new { prompt };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/visual-agent/image-master/workspaces/{workspaceId}/generate-title")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task CallImageGenPlanAsync(HttpClient http, string text)
    {
        var body = new { text, maxItems = 1 };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/visual-agent/image-gen/plan")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"ImageGen plan failed: {(int)resp.StatusCode} {resp.ReasonPhrase} {err}");
        }
    }

    private static async Task CallImageGenBatchAsync(HttpClient http, string platformId, string modelId, string prompt)
    {
        var body = new
        {
            platformId,
            modelId,
            size = "1024x1024",
            responseFormat = "url",
            items = new[] { new { prompt, count = 1, size = "1024x1024" } },
            maxConcurrency = 1
        };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/visual-agent/image-gen/batch/stream")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task CallOpenPlatformChatAsync(HttpClient http, string apiKey, string content, string groupId)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/open-platform/v1/chat/completions");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        req.Content = JsonContent.Create(new
        {
            model = "prdagent",
            stream = false,
            groupId,
            messages = new[] { new { role = "user", content } }
        });
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"OpenPlatform chat failed: {(int)resp.StatusCode} {resp.ReasonPhrase} {err}");
        }
    }

    private static async Task CallPlatformsReclassifyAsync(HttpClient http, string platformId)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/platforms/{platformId}/reclassify-models")
        {
            Content = JsonContent.Create(new { })
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
    }

    private static async Task<string> CreateModelGroupAsync(
        HttpClient http,
        string name,
        string code,
        string modelType,
        bool isDefault,
        string platformId,
        string modelId)
    {
        var body = new
        {
            name,
            code,
            modelType,
            isDefaultForType = isDefault,
            priority = 10,
            description = "integration-test",
            models = new[]
            {
                new { platformId, modelId, priority = 1 }
            }
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/mds/model-groups")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        return doc.RootElement.GetProperty("data").GetProperty("id").GetString()!;
    }

    private static async Task<string> EnsureDefaultGroupAsync(HttpClient http, string modelType, string platformId, string modelId)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var listReq = new HttpRequestMessage(HttpMethod.Get, $"/api/mds/model-groups?modelType={modelType}");
        using var listResp = await http.SendAsync(listReq, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        listResp.IsSuccessStatusCode.ShouldBeTrue();
        var listText = await listResp.Content.ReadAsStringAsync();
        using var listDoc = JsonDocument.Parse(listText);
        listDoc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var groups = listDoc.RootElement.GetProperty("data").EnumerateArray().ToList();
        var existingDefault = groups.FirstOrDefault(g => g.GetProperty("isDefaultForType").GetBoolean());
        if (existingDefault.ValueKind != JsonValueKind.Undefined)
        {
            return existingDefault.GetProperty("id").GetString()!;
        }

        return await CreateModelGroupAsync(
            http,
            name: $"IT Default {modelType} {DateTime.UtcNow:HHmmss}",
            code: $"it-default-{modelType}-{Guid.NewGuid():N}".Substring(0, 24),
            modelType: modelType,
            isDefault: true,
            platformId: platformId,
            modelId: modelId);
    }

    private static async Task UpdateBindingsAsync(HttpClient http, string appCallerId, string modelType, List<string> modelGroupIds)
    {
        var body = new { modelGroupIds };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Put, $"/api/open-platform/app-callers/{appCallerId}/requirements/{modelType}/bindings")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode)
        {
            var errorText = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"UpdateBindings failed: {(int)resp.StatusCode} {resp.ReasonPhrase} {errorText}");
        }
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
    }

    private static async Task<AppCallerInfo> EnsureAppCallerAsync(HttpClient http, string appCode)
    {
        var existing = await FindAppCallerAsync(http, appCode);
        if (existing != null) return existing!;

        var body = new
        {
            appCode,
            displayName = "Prompt Optimize",
            description = "Integration test app caller",
            modelRequirements = new[]
            {
                new
                {
                    modelType = ModelTypes.Chat,
                    purpose = "integration-test",
                    modelGroupIds = Array.Empty<string>(),
                    isRequired = true
                }
            }
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/open-platform/app-callers")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var data = doc.RootElement.GetProperty("data");
        return ReadAppCallerInfo(data);
    }

    private static async Task<AppCallerInfo?> FindAppCallerAsync(HttpClient http, string appCode)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/open-platform/app-callers?page=1&pageSize=200");
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var items = doc.RootElement.GetProperty("data").GetProperty("items");
        foreach (var item in items.EnumerateArray())
        {
            if (string.Equals(item.GetProperty("appCode").GetString(), appCode, StringComparison.Ordinal))
            {
                return ReadAppCallerInfo(item);
            }
        }
        return null;
    }

    private static async Task<UserAuth> EnsurePmUserTokenAsync(HttpClient httpAdmin)
    {
        var username = $"it_pm_{DateTime.UtcNow:MMddHHmmss}_{Guid.NewGuid():N}".Substring(0, 24);
        var password = "root";
        var createBody = new
        {
            username,
            displayName = "IT PM",
            role = "PM",
            password
        };

        using var ctsCreate = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var createReq = new HttpRequestMessage(HttpMethod.Post, "/api/users")
        {
            Content = JsonContent.Create(createBody)
        };
        using var createResp = await httpAdmin.SendAsync(createReq, HttpCompletionOption.ResponseHeadersRead, ctsCreate.Token);
        if (!createResp.IsSuccessStatusCode)
        {
            var err = await createResp.Content.ReadAsStringAsync();
            if (!err.Contains("USERNAME_EXISTS", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Create PM user failed: {(int)createResp.StatusCode} {createResp.ReasonPhrase} {err}");
            }
        }
        else
        {
            var createText = await createResp.Content.ReadAsStringAsync();
            using var createDoc = JsonDocument.Parse(createText);
            createDoc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        }

        using var httpLogin = new HttpClient { BaseAddress = httpAdmin.BaseAddress };
        using var ctsLogin = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var loginReq = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/login")
        {
            Content = JsonContent.Create(new
            {
                username,
                password,
                clientType = "desktop"
            })
        };
        using var loginResp = await httpLogin.SendAsync(loginReq, HttpCompletionOption.ResponseHeadersRead, ctsLogin.Token);
        if (!loginResp.IsSuccessStatusCode)
        {
            var err = await loginResp.Content.ReadAsStringAsync();
            Console.WriteLine($"PM login failed for {username}: {(int)loginResp.StatusCode} {loginResp.ReasonPhrase} {err}");
            throw new InvalidOperationException($"PM login failed: {(int)loginResp.StatusCode} {loginResp.ReasonPhrase} {err}");
        }
        var loginText = await loginResp.Content.ReadAsStringAsync();
        using var loginDoc = JsonDocument.Parse(loginText);
        loginDoc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var data = loginDoc.RootElement.GetProperty("data");
        var token = data.GetProperty("accessToken").GetString();
        var userId = data.GetProperty("user").GetProperty("userId").GetString();
        if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(userId))
            throw new InvalidOperationException("PM login returned empty accessToken/userId");
        return new UserAuth(token!, userId!, username);
    }

    private static AppCallerInfo ReadAppCallerInfo(JsonElement item)
    {
        var id = item.GetProperty("id").GetString() ?? string.Empty;
        var chatGroupIds = new List<string>();
        if (item.TryGetProperty("modelRequirements", out var reqs) && reqs.ValueKind == JsonValueKind.Array)
        {
            foreach (var req in reqs.EnumerateArray())
            {
                var modelType = req.TryGetProperty("modelType", out var mtEl) ? mtEl.GetString() : null;
                if (!string.Equals(modelType, ModelTypes.Chat, StringComparison.Ordinal)) continue;
                if (req.TryGetProperty("modelGroupIds", out var idsEl) && idsEl.ValueKind == JsonValueKind.Array)
                {
                    chatGroupIds.AddRange(idsEl.EnumerateArray().Select(x => x.GetString() ?? string.Empty).Where(x => !string.IsNullOrWhiteSpace(x)));
                }
            }
        }
        return new AppCallerInfo(id, chatGroupIds);
    }

    private static ModelInfo ReadModelInfo(JsonElement item)
    {
        return new ModelInfo(
            PlatformId: item.TryGetProperty("platformId", out var pid) ? pid.GetString() ?? string.Empty : string.Empty,
            ModelName: item.TryGetProperty("modelName", out var mid) ? mid.GetString() ?? string.Empty : string.Empty,
            Enabled: item.TryGetProperty("enabled", out var enabled) && enabled.GetBoolean(),
            IsMain: item.TryGetProperty("isMain", out var isMain) && isMain.GetBoolean(),
            IsImageGen: item.TryGetProperty("isImageGen", out var isImageGen) && isImageGen.GetBoolean());
    }

    private static async Task TryDeleteModelGroupAsync(HttpClient http, string groupId)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Delete, $"/api/mds/model-groups/{groupId}");
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode) return;
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        _ = doc.RootElement.GetProperty("success").GetBoolean();
    }

    private void PrintResults(List<CaseResult> results)
    {
        _output.WriteLine("LLM Scheduling Integration Results:");
        Console.WriteLine("LLM Scheduling Integration Results:");
        foreach (var r in results)
        {
            var apiError = string.IsNullOrWhiteSpace(r.ApiError) ? "" : $" | apiError={r.ApiError}";
            var line = $"{r.Name} | purpose={r.RequestPurpose} | expected={r.ExpectedResolution} | actual={r.ActualResolution} | groupId={r.ModelGroupId}{apiError}";
            _output.WriteLine(line);
            Console.WriteLine(line);
        }

        try
        {
            var payload = JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true });
            var roots = new[]
            {
                EnvConfig.GetRepoRoot(),
                Directory.GetCurrentDirectory(),
                AppContext.BaseDirectory
            }.Distinct();

            foreach (var root in roots)
            {
                var dir = Path.Combine(root, "prd-api", "tests", "PrdAgent.Api.Tests", "Artifacts");
                Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, "llm-scheduling-results.json");
                File.WriteAllText(path, payload);
            }
        }
        catch
        {
            // ignore
        }
    }

    private static async Task<LlmLogItem> WaitForLogAsync(
        HttpClient http,
        string requestPurpose,
        DateTime sinceUtc,
        TimeSpan timeout)
    {
        var end = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < end)
        {
            var from = sinceUtc.AddSeconds(-2);
            var url =
                $"/api/logs/llm?page=1&pageSize=10&requestPurpose={Uri.EscapeDataString(requestPurpose)}&from={Uri.EscapeDataString(from.ToString("O"))}";
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (!resp.IsSuccessStatusCode)
            {
                var error = await resp.Content.ReadAsStringAsync();
                throw new InvalidOperationException($"Query logs failed: {(int)resp.StatusCode} {resp.ReasonPhrase} {error}");
            }
            var text = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("success", out var ok) || !ok.GetBoolean())
            {
                await Task.Delay(500);
                continue;
            }

            if (doc.RootElement.TryGetProperty("data", out var data) &&
                data.TryGetProperty("items", out var items) &&
                items.ValueKind == JsonValueKind.Array &&
                items.GetArrayLength() > 0)
            {
                var item = items[0];
                return ParseLogItem(item);
            }

            await Task.Delay(500);
        }

        throw new TimeoutException($"LLM log not found for {requestPurpose}");
    }

    private static async Task<(LlmLogItem? Log, string? Error)> TryWaitLogAsync(
        HttpClient http,
        string requestPurpose,
        DateTime sinceUtc,
        TimeSpan timeout)
    {
        try
        {
            var log = await WaitForLogAsync(http, requestPurpose, sinceUtc, timeout);
            return (log, null);
        }
        catch (Exception ex)
        {
            return (null, ex.Message);
        }
    }

    private static LlmLogItem ParseLogItem(JsonElement item)
    {
        var purpose = item.TryGetProperty("requestPurpose", out var rp) ? rp.GetString() : null;
        var modelGroupId = item.TryGetProperty("modelGroupId", out var mg) ? mg.GetString() : null;
        var modelGroupName = item.TryGetProperty("modelGroupName", out var mgn) ? mgn.GetString() : null;
        var resolution = ReadModelResolutionType(item);
        return new LlmLogItem(purpose, resolution, modelGroupId, modelGroupName);
    }

    private static string? ReadModelResolutionType(JsonElement item)
    {
        if (!item.TryGetProperty("modelResolutionType", out var el)) return null;
        if (el.ValueKind == JsonValueKind.String) return el.GetString();
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n))
        {
            return n switch
            {
                0 => ModelResolutionType.DirectModel.ToString(),
                1 => ModelResolutionType.DefaultPool.ToString(),
                2 => ModelResolutionType.DedicatedPool.ToString(),
                _ => n.ToString()
            };
        }
        return null;
    }

    private static async Task<string?> TryCallAsync(Func<Task> action)
    {
        try
        {
            await action();
            return null;
        }
        catch (Exception ex)
        {
            return ex.Message;
        }
    }

    private static async Task<string> CreateOpenPlatformAppAsync(HttpClient httpAdmin, string userId, string groupId)
    {
        var body = new
        {
            appName = $"IT OpenPlatform {DateTime.UtcNow:HHmmss}",
            description = "Integration test",
            boundUserId = userId,
            boundGroupId = groupId,
            ignoreUserSystemPrompt = false,
            disableGroupContext = false
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/open-platform/apps")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await httpAdmin.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"Create OpenPlatform app failed: {(int)resp.StatusCode} {resp.ReasonPhrase} {err}");
        }
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var apiKey = doc.RootElement.GetProperty("data").GetProperty("apiKey").GetString();
        if (string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("OpenPlatform apiKey missing");
        return apiKey!;
    }

    private sealed record EnvConfig
    {
        public string ApiBaseUrl { get; init; } = "http://localhost:5000";
        public string AdminToken { get; init; } = string.Empty;
        public string MongoUri { get; init; } = "mongodb://localhost:27017";
        public string MongoDb { get; init; } = "prdagent";
        public string? PlatformId { get; init; }
        public string? ModelId { get; init; }
        public string? RootUsername { get; init; }
        public string? RootPassword { get; init; }
        public string? OpenPlatformTestApiKey { get; init; }
        public bool ShouldCleanup { get; init; }

        public static EnvConfig Load()
        {
            var (mongoUri, mongoDb) = ReadMongoDefaults();
            var cleanup = (Environment.GetEnvironmentVariable("PRD_TEST_CLEANUP") ?? string.Empty).Trim();
            var shouldCleanup = string.Equals(cleanup, "1", StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(cleanup, "true", StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(cleanup, "yes", StringComparison.OrdinalIgnoreCase);

            var rootUser = NullIfEmpty(Environment.GetEnvironmentVariable("ROOT_ACCESS_USERNAME"))
                           ?? ReadZshExport("ROOT_ACCESS_USERNAME")
                           ?? "root";
            var rootPass = NullIfEmpty(Environment.GetEnvironmentVariable("ROOT_ACCESS_PASSWORD")) ?? ReadZshExport("ROOT_ACCESS_PASSWORD");
            var adminToken = (Environment.GetEnvironmentVariable("PRD_TEST_ADMIN_TOKEN") ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(adminToken))
            {
                adminToken = ReadZshExport("PRD_TEST_ADMIN_TOKEN") ?? string.Empty;
            }

            return new EnvConfig
            {
                ApiBaseUrl = (Environment.GetEnvironmentVariable("PRD_TEST_API_BASE_URL") ?? "http://localhost:5000").Trim().TrimEnd('/'),
                AdminToken = adminToken,
                MongoUri = (Environment.GetEnvironmentVariable("PRD_TEST_MONGODB_URI") ?? mongoUri).Trim(),
                MongoDb = (Environment.GetEnvironmentVariable("PRD_TEST_MONGODB_DB") ?? mongoDb).Trim(),
                PlatformId = NullIfEmpty(Environment.GetEnvironmentVariable("PRD_TEST_PLATFORM_ID")),
                ModelId = NullIfEmpty(Environment.GetEnvironmentVariable("PRD_TEST_MODEL_ID")),
                RootUsername = rootUser,
                RootPassword = rootPass,
                OpenPlatformTestApiKey = NullIfEmpty(Environment.GetEnvironmentVariable("PRD_TEST_OPEN_PLATFORM_KEY")),
                ShouldCleanup = shouldCleanup
            };
        }

        private static string? NullIfEmpty(string? v)
        {
            var s = (v ?? string.Empty).Trim();
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }

        private static string? ReadZshExport(string key)
        {
            try
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var path = Path.Combine(home, ".zshrc");
                if (!File.Exists(path)) return null;
                foreach (var raw in File.ReadAllLines(path))
                {
                    var line = (raw ?? string.Empty).Trim();
                    if (!line.StartsWith("export ", StringComparison.Ordinal)) continue;
                    if (!line.Contains('=')) continue;
                    var parts = line["export ".Length..].Split('=', 2);
                    if (parts.Length != 2) continue;
                    var name = parts[0].Trim();
                    if (!string.Equals(name, key, StringComparison.Ordinal)) continue;
                    var value = parts[1].Trim().Trim('"').Trim('\'');
                    return string.IsNullOrWhiteSpace(value) ? null : value;
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static (string mongoUri, string mongoDb) ReadMongoDefaults()
        {
            try
            {
                var root = GetRepoRoot();
                var path = Path.Combine(root, "prd-api", "src", "PrdAgent.Api", "appsettings.json");
                if (!File.Exists(path)) return ("mongodb://localhost:27017", "prdagent");
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                var rootEl = doc.RootElement;
                var mongo = rootEl.GetProperty("MongoDB");
                var uri = mongo.GetProperty("ConnectionString").GetString() ?? "mongodb://localhost:27017";
                var db = mongo.GetProperty("DatabaseName").GetString() ?? "prdagent";
                return (uri.Trim(), db.Trim());
            }
            catch
            {
                return ("mongodb://localhost:27017", "prdagent");
            }
        }

        public static string GetRepoRoot()
        {
            var dir = AppContext.BaseDirectory;
            for (var i = 0; i < 10; i++)
            {
                if (Directory.Exists(Path.Combine(dir, ".git")))
                {
                    return dir;
                }
                var parent = Directory.GetParent(dir);
                if (parent == null)
                {
                    break;
                }
                dir = parent.FullName;
            }
            return Directory.GetCurrentDirectory();
        }
    }

    private static async Task<bool> IsServerAvailableAsync(HttpClient http, string baseUrl)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var req = new HttpRequestMessage(HttpMethod.Get, "/health");
            using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            return true; // 只要能连接就认为可用
        }
        catch
        {
            return false;
        }
    }

    private static async Task<string?> TryLoginRootAsync(HttpClient http, string? username, string? password)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)) return null;
        var body = new { username, password, clientType = "admin" };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/login")
        {
            Content = JsonContent.Create(body)
        };
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode) return null;
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        if (!doc.RootElement.TryGetProperty("success", out var ok) || !ok.GetBoolean()) return null;
        var token = doc.RootElement.GetProperty("data").GetProperty("accessToken").GetString();
        return string.IsNullOrWhiteSpace(token) ? null : token;
    }

    private static async Task<ModelInfo> ResolveModelAsync(HttpClient http, bool preferImageGen)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/mds");
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.IsSuccessStatusCode.ShouldBeTrue();
        var text = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        var models = doc.RootElement.GetProperty("data").EnumerateArray()
            .Select(ReadModelInfo)
            .Where(m => m.Enabled && !string.IsNullOrWhiteSpace(m.PlatformId) && !string.IsNullOrWhiteSpace(m.ModelName))
            .ToList();

        ModelInfo? picked = null;
        if (preferImageGen)
        {
            picked = models.FirstOrDefault(m => m.IsImageGen);
        }
        else
        {
            picked = models.FirstOrDefault(m => m.IsMain);
        }

        picked ??= models.FirstOrDefault();
        if (picked == null) throw new InvalidOperationException("未找到可用的模型（平台/模型ID为空）");
        return picked.Value;
    }

    private static string? ReadOpenPlatformTestApiKey()
    {
        try
        {
            var root = EnvConfig.GetRepoRoot();
            var path = Path.Combine(root, "prd-api", "src", "PrdAgent.Api", "appsettings.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var key = doc.RootElement.GetProperty("OpenPlatform").GetProperty("TestApiKey").GetString();
            return string.IsNullOrWhiteSpace(key) ? null : key.Trim();
        }
        catch
        {
            return null;
        }
    }

    private sealed record DocumentUploadResult(string SessionId, string DocumentId, string FirstHeadingId, string FirstHeadingTitle);
    private sealed record GroupCreateResult(string GroupId, DateTime CreatedAt);
    private sealed record AppCallerInfo(string Id, List<string> ChatModelGroupIds);
    private readonly record struct ModelInfo(string PlatformId, string ModelName, bool Enabled, bool IsMain, bool IsImageGen);
    private sealed record LlmLogItem(string? RequestPurpose, string? ModelResolutionType, string? ModelGroupId, string? ModelGroupName);
    private sealed record UserAuth(string Token, string UserId, string Username);

    private sealed record CaseResult(
        string Name,
        string RequestPurpose,
        string ExpectedResolution,
        string ActualResolution,
        string? ModelGroupId,
        string? ModelGroupName,
        string? ApiError)
    {
        public static CaseResult FromLog(string name, LlmLogItem log, string expected, string? apiError = null)
        {
            var actual = log.ModelResolutionType?.ToString() ?? "null";
            return new CaseResult(name, log.RequestPurpose ?? "", expected, actual, log.ModelGroupId, log.ModelGroupName, apiError);
        }
    }
}
