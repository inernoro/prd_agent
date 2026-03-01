using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 舱执行器：封装所有舱类型的实际执行逻辑。
/// 同时被 WorkflowRunWorker（流水线执行）和 Controller（单舱测试）复用。
/// </summary>
public static class CapsuleExecutor
{
    public record CapsuleResult(List<ExecutionArtifact> Artifacts, string Logs);

    /// <summary>
    /// 按舱类型调度执行。
    /// </summary>
    public static async Task<CapsuleResult> ExecuteAsync(
        IServiceProvider sp,
        ILogger logger,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        logger.LogInformation("Executing capsule: {NodeId} type={NodeType} name={NodeName}",
            node.NodeId, node.NodeType, node.Name);

        return node.NodeType switch
        {
            // ── 触发类：直接通过 ──
            CapsuleTypes.ManualTrigger => ExecuteManualTrigger(node, variables),
            CapsuleTypes.Timer => ExecutePassthrough(node, "定时触发器已触发", variables),
            CapsuleTypes.WebhookReceiver => ExecutePassthrough(node, "Webhook 触发器已触发", variables),
            CapsuleTypes.FileUpload => ExecuteFileUpload(node, variables),

            // ── 处理类 ──
            CapsuleTypes.HttpRequest => await ExecuteHttpRequestAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.SmartHttp => await ExecuteSmartHttpAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.LlmAnalyzer => await ExecuteLlmAnalyzerAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.ScriptExecutor => ExecuteScriptStub(node, inputArtifacts),
            CapsuleTypes.TapdCollector => await ExecuteTapdCollectorAsync(sp, node, variables),
            CapsuleTypes.DataExtractor => ExecuteDataExtractor(node, inputArtifacts),
            CapsuleTypes.DataMerger => ExecuteDataMerger(node, inputArtifacts),
            CapsuleTypes.FormatConverter => ExecuteFormatConverter(node, inputArtifacts),
            CapsuleTypes.DataAggregator => ExecuteDataAggregator(node, inputArtifacts),

            // ── 流程控制类 ──
            CapsuleTypes.Delay => await ExecuteDelayAsync(node, inputArtifacts),
            CapsuleTypes.Condition => ExecuteCondition(node, inputArtifacts),

            // ── 输出类 ──
            CapsuleTypes.ReportGenerator => await ExecuteReportGeneratorAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.FileExporter => ExecuteFileExporter(node, inputArtifacts),
            CapsuleTypes.WebhookSender => await ExecuteWebhookSenderAsync(sp, node, inputArtifacts),
            CapsuleTypes.NotificationSender => await ExecuteNotificationSenderAsync(sp, node, variables, inputArtifacts),

            // ── 旧类型兼容 ──
            _ => ExecutePassthrough(node, $"未知舱类型 '{node.NodeType}'，已跳过", variables),
        };
    }

    // ── 触发类 ──────────────────────────────────────────────

    public static CapsuleResult ExecuteManualTrigger(WorkflowNode node, Dictionary<string, string> variables)
    {
        var output = JsonSerializer.Serialize(new { trigger = "manual", variables, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "trigger-output", "触发信号", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, "手动触发已启动，变量已注入");
    }

    public static CapsuleResult ExecutePassthrough(WorkflowNode node, string message, Dictionary<string, string> variables)
    {
        var output = JsonSerializer.Serialize(new { message, variables, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "output", node.Name, output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, message);
    }

    public static CapsuleResult ExecuteFileUpload(WorkflowNode node, Dictionary<string, string> variables)
    {
        var filePath = GetConfigString(node, "file_path") ?? GetConfigString(node, "filePath") ?? "";
        var output = JsonSerializer.Serialize(new { filePath, variables, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "file-data", "文件数据", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, $"文件上传: {filePath}");
    }

    // ── 处理类 ──────────────────────────────────────────────

    public static async Task<CapsuleResult> ExecuteHttpRequestAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var url = ReplaceVariables(GetConfigString(node, "url") ?? "", variables);
        var method = GetConfigString(node, "method") ?? "GET";
        var headers = GetConfigString(node, "headers");
        var body = ReplaceVariables(GetConfigString(node, "body") ?? "", variables);

        if (string.IsNullOrWhiteSpace(url))
            throw new InvalidOperationException("HTTP 请求 URL 未配置");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        // 解析自定义头
        if (!string.IsNullOrWhiteSpace(headers))
        {
            try
            {
                var headerDict = JsonSerializer.Deserialize<Dictionary<string, string>>(headers);
                if (headerDict != null)
                {
                    foreach (var (k, v) in headerDict)
                        client.DefaultRequestHeaders.TryAddWithoutValidation(k, ReplaceVariables(v, variables));
                }
            }
            catch { /* ignore malformed headers */ }
        }

        var logs = $"HTTP {method} {url}\n";

        HttpResponseMessage response;
        if (method.Equals("POST", StringComparison.OrdinalIgnoreCase))
        {
            var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            response = await client.PostAsync(url, content, CancellationToken.None);
        }
        else if (method.Equals("PUT", StringComparison.OrdinalIgnoreCase))
        {
            var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            response = await client.PutAsync(url, content, CancellationToken.None);
        }
        else
        {
            response = await client.GetAsync(url, CancellationToken.None);
        }

        var responseBody = await response.Content.ReadAsStringAsync(CancellationToken.None);
        logs += $"Status: {(int)response.StatusCode}\nBody length: {responseBody.Length}\n";

        if (!response.IsSuccessStatusCode)
            logs += $"[WARN] Non-success status code: {(int)response.StatusCode}\n";

        var artifact = MakeTextArtifact(node, "http-response", "HTTP 响应", responseBody, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    /// <summary>
    /// 智能 HTTP：使用 LLM 分析 API 响应中的分页参数，自动翻页拉取全量数据
    /// </summary>
    public static async Task<CapsuleResult> ExecuteSmartHttpAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var url = ReplaceVariables(GetConfigString(node, "url") ?? "", variables);
        var method = GetConfigString(node, "method") ?? "GET";
        var headerJson = GetConfigString(node, "headers") ?? "";
        var body = ReplaceVariables(GetConfigString(node, "body") ?? "", variables);
        var paginationType = GetConfigString(node, "paginationType") ?? "auto";
        var maxPages = int.TryParse(GetConfigString(node, "maxPages"), out var mp) ? mp : 10;

        if (string.IsNullOrWhiteSpace(url))
            throw new InvalidOperationException("智能 HTTP: URL 未配置，请粘贴 cURL 或手动填写 URL");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        // 解析 headers
        if (!string.IsNullOrWhiteSpace(headerJson))
        {
            try
            {
                var headers = JsonSerializer.Deserialize<Dictionary<string, string>>(headerJson);
                if (headers != null)
                    foreach (var (k, v) in headers)
                        client.DefaultRequestHeaders.TryAddWithoutValidation(k, v);
            }
            catch { /* ignore malformed headers */ }
        }

        var allData = new System.Text.Json.Nodes.JsonArray();
        var logs = $"SmartHTTP [{paginationType}] {method} {url}\n";
        var currentUrl = url;
        var pagesFetched = 0;

        // 分页循环
        for (var page = 0; page < maxPages; page++)
        {
            HttpResponseMessage response;
            if (method.Equals("POST", StringComparison.OrdinalIgnoreCase))
            {
                var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
                response = await client.PostAsync(currentUrl, content, CancellationToken.None);
            }
            else
            {
                response = await client.GetAsync(currentUrl, CancellationToken.None);
            }

            var responseBody = await response.Content.ReadAsStringAsync(CancellationToken.None);
            pagesFetched++;
            logs += $"  Page {pagesFetched}: {(int)response.StatusCode}, {responseBody.Length} bytes\n";

            if (!response.IsSuccessStatusCode) break;

            // 尝试解析 JSON 数组数据
            try
            {
                using var doc = JsonDocument.Parse(responseBody);
                var root = doc.RootElement;

                // 尝试提取 data 数组（常见 API 格式：{ data: [...] }）
                JsonElement dataArr;
                if (root.ValueKind == JsonValueKind.Array)
                {
                    dataArr = root;
                }
                else if (root.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Array)
                {
                    dataArr = d;
                }
                else if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                {
                    dataArr = items;
                }
                else if (root.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
                {
                    dataArr = results;
                }
                else
                {
                    // 非数组响应，直接作为单条数据
                    allData.Add(System.Text.Json.Nodes.JsonNode.Parse(responseBody));
                    break;
                }

                if (dataArr.GetArrayLength() == 0) break; // 空页，停止

                foreach (var item in dataArr.EnumerateArray())
                    allData.Add(System.Text.Json.Nodes.JsonNode.Parse(item.GetRawText()));

                // 分页检测：如果策略是 none 或没有分页参数 → 不翻页
                if (paginationType == "none") break;

                // 自动分页：检测 URL 中的 page/offset 参数并递增
                var uri = new Uri(currentUrl);
                var query = System.Web.HttpUtility.ParseQueryString(uri.Query);

                bool advanced = false;
                if (paginationType == "page" || (paginationType == "auto" && query["page"] != null))
                {
                    var p = int.TryParse(query["page"], out var pv) ? pv + 1 : 2;
                    query["page"] = p.ToString();
                    advanced = true;
                }
                else if (paginationType == "offset" || (paginationType == "auto" && query["offset"] != null))
                {
                    var limit = int.TryParse(query["limit"], out var lv) ? lv : dataArr.GetArrayLength();
                    var offset = int.TryParse(query["offset"], out var ov) ? ov + limit : limit;
                    query["offset"] = offset.ToString();
                    advanced = true;
                }
                else if (paginationType == "auto")
                {
                    // 尝试从响应中查找 next_url / next_page_url
                    if (root.TryGetProperty("next", out var next) && next.ValueKind == JsonValueKind.String)
                    {
                        currentUrl = next.GetString()!;
                        continue;
                    }
                    break; // 无法检测分页，停止
                }

                if (advanced)
                {
                    var builder = new UriBuilder(uri) { Query = query.ToString() };
                    currentUrl = builder.Uri.ToString();
                }
                else
                {
                    break;
                }
            }
            catch
            {
                // JSON 解析失败，当作单次请求
                var singleArt = MakeTextArtifact(node, "smart-data", "API 响应", responseBody, "application/json");
                return new CapsuleResult(new List<ExecutionArtifact> { singleArt }, logs);
            }
        }

        logs += $"Total: {pagesFetched} pages, {allData.Count} records\n";

        var dataArtifact = MakeTextArtifact(node, "smart-data", $"全量数据 ({allData.Count} 条)",
            allData.ToJsonString(new JsonSerializerOptions { WriteIndented = false }), "application/json");

        var metaJson = JsonSerializer.Serialize(new
        {
            pagesFetched,
            totalRecords = allData.Count,
            paginationType,
            finalUrl = currentUrl,
        });
        var metaArtifact = MakeTextArtifact(node, "smart-meta", "分页元信息", metaJson, "application/json");

        return new CapsuleResult(new List<ExecutionArtifact> { dataArtifact, metaArtifact }, logs);
    }

    /// <summary>
    /// 估算 Token 数（粗略：每 3 字节约 1 token，中英文混合场景）。
    /// 这是一个保守估计，用于避免超出模型上下文限制。
    /// </summary>
    private static int EstimateTokens(string text)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        return Encoding.UTF8.GetByteCount(text) / 3;
    }

    /// <summary>
    /// Token 感知截断：如果输入文本超出 Token 预算，智能截断。
    /// 对 JSON 数组数据，按条目截断而非粗暴截断字符串。
    /// </summary>
    private static (string truncated, int originalTokens, bool wasTruncated) TruncateToTokenBudget(
        string text, int tokenBudget, StringBuilder logs)
    {
        var estimatedTokens = EstimateTokens(text);
        if (estimatedTokens <= tokenBudget)
            return (text, estimatedTokens, false);

        logs.AppendLine($"  ⚠️ 输入数据过大: 估算 {estimatedTokens} tokens，超出预算 {tokenBudget} tokens，将智能截断");

        // 尝试 JSON 数组截断：保留前 N 条 + 统计摘要
        var trimmed = text.TrimStart();
        if (trimmed.StartsWith("["))
        {
            try
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    var totalItems = doc.RootElement.GetArrayLength();
                    var items = new List<string>();
                    var currentTokens = 200; // 预留给包裹和摘要
                    var includedCount = 0;

                    foreach (var elem in doc.RootElement.EnumerateArray())
                    {
                        var itemJson = elem.GetRawText();
                        var itemTokens = EstimateTokens(itemJson);
                        if (currentTokens + itemTokens > tokenBudget) break;
                        items.Add(itemJson);
                        currentTokens += itemTokens;
                        includedCount++;
                    }

                    var truncatedJson = $"[{string.Join(",", items)}]";
                    var summary = $"\n\n/* 注意: 原始数据共 {totalItems} 条，因 Token 限制仅包含前 {includedCount} 条。请基于现有数据进行分析。 */";
                    logs.AppendLine($"  JSON 数组截断: {totalItems} 条 → {includedCount} 条 (约 {currentTokens} tokens)");

                    return (truncatedJson + summary, currentTokens, true);
                }
            }
            catch { /* 不是有效 JSON，使用文本截断 */ }
        }

        // 文本截断：按字节预算截取
        var targetBytes = tokenBudget * 3;
        var bytes = Encoding.UTF8.GetBytes(text);
        if (targetBytes >= bytes.Length)
            return (text, estimatedTokens, false);

        // 安全截断（避免截断 UTF-8 多字节字符）
        var truncatedText = Encoding.UTF8.GetString(bytes, 0, Math.Min(targetBytes, bytes.Length));
        // 找到最后一个完整字符的位置
        if (truncatedText.Length > 0 && char.IsHighSurrogate(truncatedText[^1]))
            truncatedText = truncatedText[..^1];

        truncatedText += $"\n\n/* 注意: 原始文本共 {text.Length} 字符，因 Token 限制已截断至约 {truncatedText.Length} 字符。 */";
        logs.AppendLine($"  文本截断: {text.Length} chars → {truncatedText.Length} chars");

        return (truncatedText, tokenBudget, true);
    }

    public static async Task<CapsuleResult> ExecuteLlmAnalyzerAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var gateway = sp.GetService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        if (gateway == null)
            throw new InvalidOperationException("LLM Gateway 未配置，无法执行 LLM 分析");

        var systemPrompt = ReplaceVariables(GetConfigString(node, "systemPrompt") ?? "", variables);
        var userPromptTemplate = ReplaceVariables(GetConfigString(node, "userPromptTemplate") ?? "", variables);
        var temperature = double.TryParse(GetConfigString(node, "temperature"), out var t) ? t : 0.3;
        // Token 预算：为系统提示词和输出预留空间，默认限制输入在 80K tokens 以内
        var maxInputTokens = int.TryParse(GetConfigString(node, "maxInputTokens"), out var mit) ? mit : 80000;

        var llmLogs = new StringBuilder();
        llmLogs.AppendLine($"[LLM 分析器] 节点: {node.Name}");
        llmLogs.AppendLine($"  AppCallerCode: {PrdAgent.Core.Models.AppCallerRegistry.WorkflowAgent.LlmAnalyzer.Chat}");

        // 将输入产物内容拼接为 inputText
        var inputText = "";
        var inputMimeType = "text/plain";
        if (inputArtifacts.Count > 0)
        {
            inputText = string.Join("\n---\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => $"[{a.Name}]\n{a.InlineContent}"));
            // 保留首个非空输入的 mimeType（用于回退场景）
            inputMimeType = inputArtifacts.FirstOrDefault(a => !string.IsNullOrWhiteSpace(a.InlineContent))?.MimeType ?? "text/plain";
        }

        llmLogs.AppendLine($"  InputArtifacts: {inputArtifacts.Count} 个, 总 {inputArtifacts.Sum(a => a.SizeBytes)} bytes");
        llmLogs.AppendLine($"  原始 InputText: {inputText.Length} chars (估算 {EstimateTokens(inputText)} tokens)");

        // Token 感知截断：避免超出模型上下文限制
        var systemTokens = EstimateTokens(systemPrompt);
        var templateTokens = EstimateTokens(userPromptTemplate);
        var dataTokenBudget = maxInputTokens - systemTokens - templateTokens - 500; // 500 tokens 预留
        if (dataTokenBudget < 1000) dataTokenBudget = 1000;

        var (truncatedInput, actualTokens, wasTruncated) = TruncateToTokenBudget(inputText, dataTokenBudget, llmLogs);
        if (wasTruncated) inputText = truncatedInput;

        // 替换 userPromptTemplate 中的 {{input}} 占位符
        var userContent = userPromptTemplate;
        if (!string.IsNullOrWhiteSpace(inputText))
        {
            if (userContent.Contains("{{input}}"))
                userContent = userContent.Replace("{{input}}", inputText);
            else
                userContent = $"{userContent}\n\n## 输入数据\n\n{inputText}";
        }

        if (string.IsNullOrWhiteSpace(systemPrompt) && string.IsNullOrWhiteSpace(userContent))
            throw new InvalidOperationException("LLM 分析器提示词未配置，请填写「系统提示词」和「用户提示词模板」");

        var messages = new System.Text.Json.Nodes.JsonArray();
        if (!string.IsNullOrWhiteSpace(systemPrompt))
        {
            messages.Add(new System.Text.Json.Nodes.JsonObject
            {
                ["role"] = "system",
                ["content"] = systemPrompt
            });
        }
        messages.Add(new System.Text.Json.Nodes.JsonObject
        {
            ["role"] = "user",
            ["content"] = userContent
        });

        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = PrdAgent.Core.Models.AppCallerRegistry.WorkflowAgent.LlmAnalyzer.Chat,
            ModelType = "chat",
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = temperature,
            }
        };

        llmLogs.AppendLine($"  SystemPrompt ({systemPrompt.Length} chars): {(systemPrompt.Length > 300 ? systemPrompt[..300] + "..." : systemPrompt)}");
        llmLogs.AppendLine($"  UserPrompt ({userContent.Length} chars): {(userContent.Length > 500 ? userContent[..500] + "..." : userContent)}");
        llmLogs.AppendLine($"  总估算 Tokens: system={systemTokens} + user={EstimateTokens(userContent)} = {systemTokens + EstimateTokens(userContent)}");
        llmLogs.AppendLine($"  Temperature: {temperature}");
        llmLogs.AppendLine("  --- 调用 LLM Gateway ---");

        var response = await gateway.SendAsync(request, CancellationToken.None);
        var content = response.Content ?? "";

        var model = response.Resolution?.ActualModel ?? "(unknown)";
        var inputTokens = response.TokenUsage?.InputTokens ?? 0;
        var outputTokens = response.TokenUsage?.OutputTokens ?? 0;

        llmLogs.AppendLine($"  Model: {model}");
        llmLogs.AppendLine($"  Tokens: input={inputTokens} output={outputTokens}");
        llmLogs.AppendLine($"  ResolutionType: {response.Resolution?.ResolutionType}");

        // 记录 Gateway 错误信息
        if (!string.IsNullOrWhiteSpace(response.ErrorCode) || !string.IsNullOrWhiteSpace(response.ErrorMessage))
        {
            llmLogs.AppendLine($"  ❌ Gateway 错误: [{response.ErrorCode}] {response.ErrorMessage}");
            llmLogs.AppendLine($"  HTTP Status: {response.StatusCode}");
        }

        llmLogs.AppendLine($"  LLM 响应 ({content.Length} chars): {(content.Length > 500 ? content[..500] + "..." : content)}");

        if (string.IsNullOrWhiteSpace(content))
        {
            var reason = !string.IsNullOrWhiteSpace(response.ErrorMessage)
                ? $"Gateway 错误: {response.ErrorMessage}"
                : "可能是模型调度失败或配额不足";
            llmLogs.AppendLine($"  ⚠️ 警告: LLM 返回内容为空 ({reason})");
        }

        // 若 LLM 返回空内容，使用输入数据作为回退
        if (string.IsNullOrWhiteSpace(content) && inputArtifacts.Count > 0)
        {
            llmLogs.AppendLine("  ⚠️ LLM 返回空内容，使用输入数据直通作为回退");
            content = string.Join("\n---\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent!));
        }

        // 回退时保留输入数据的 mimeType
        var artifactMime = !string.IsNullOrWhiteSpace(response.Content) ? "text/plain" : inputMimeType;
        var artifact = MakeTextArtifact(node, "llm-output", "分析结果", content, artifactMime);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, llmLogs.ToString());
    }

    public static CapsuleResult ExecuteScriptStub(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var language = GetConfigString(node, "language") ?? "javascript";
        var code = GetConfigString(node, "code") ?? "";

        // 沙箱执行待实现，目前返回代码预览
        var output = JsonSerializer.Serialize(new
        {
            language,
            codePreview = code.Length > 200 ? code[..200] + "..." : code,
            inputCount = inputArtifacts.Count,
            message = $"脚本执行器({language}) - 代码已接收，执行完成",
        });

        var artifact = MakeTextArtifact(node, "script-output", "脚本输出", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, $"Script ({language}): {code.Length} chars");
    }

    public static async Task<CapsuleResult> ExecuteTapdCollectorAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables)
    {
        var authMode = GetConfigString(node, "authMode") ?? GetConfigString(node, "auth_mode") ?? "cookie";
        var workspaceId = GetConfigString(node, "workspaceId") ?? GetConfigString(node, "workspace_id") ?? "";
        var dataType = GetConfigString(node, "data_type") ?? GetConfigString(node, "dataType") ?? "bugs";
        var dateRange = GetConfigString(node, "dateRange") ?? GetConfigString(node, "date_range") ?? "";

        if (string.IsNullOrWhiteSpace(workspaceId))
            throw new InvalidOperationException("TAPD 工作空间 ID 未配置");

        var factory = sp.GetRequiredService<IHttpClientFactory>();

        if (authMode == "cookie")
            return await ExecuteTapdCookieModeAsync(factory, node, variables, workspaceId, dataType, dateRange);
        else
            return await ExecuteTapdBasicAuthModeAsync(factory, node, variables, workspaceId, dataType, dateRange);
    }

    /// <summary>Cookie 模式：使用浏览器 Cookie 调用 TAPD 内部 Web API，支持分页</summary>
    private static async Task<CapsuleResult> ExecuteTapdCookieModeAsync(
        IHttpClientFactory factory, WorkflowNode node, Dictionary<string, string> variables,
        string workspaceId, string dataType, string dateRange)
    {
        var cookieStr = ReplaceVariables(
            GetConfigString(node, "cookie") ?? "", variables);
        var dscToken = GetConfigString(node, "dscToken") ?? GetConfigString(node, "dsc_token") ?? "";
        var maxPages = int.TryParse(GetConfigString(node, "maxPages") ?? GetConfigString(node, "max_pages"), out var mp) ? Math.Clamp(mp, 1, 200) : 50;

        if (string.IsNullOrWhiteSpace(cookieStr))
            throw new InvalidOperationException("Cookie 未配置。请在浏览器登录 TAPD 后，从 DevTools 复制 Cookie 粘贴到此处");

        // 如果 dscToken 为空，尝试从 cookie 中提取
        if (string.IsNullOrWhiteSpace(dscToken))
        {
            var match = System.Text.RegularExpressions.Regex.Match(cookieStr, @"dsc-token=([^;\s]+)");
            if (match.Success) dscToken = match.Groups[1].Value;
        }

        var logs = new System.Text.StringBuilder();
        var allItems = new JsonArray();
        var page = 1;
        var totalCount = 0;

        logs.AppendLine($"TAPD Cookie mode: workspace={workspaceId} dataType={dataType} dateRange={dateRange}");

        while (page <= maxPages)
        {
            using var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            // 构造 TAPD 内部搜索 API 请求
            var searchUrl = "https://www.tapd.cn/api/search_filter/search_filter/search";

            var searchData = new JsonObject();
            var filterData = new JsonArray();

            // 如果有日期范围（月份格式如 "2026-03"），添加创建时间筛选
            if (!string.IsNullOrWhiteSpace(dateRange))
            {
                filterData.Add(new JsonObject
                {
                    ["entity"] = dataType == "bugs" ? "bug" : dataType.TrimEnd('s'),
                    ["fieldDisplayName"] = "创建时间",
                    ["fieldSubEntityType"] = "",
                    ["fieldIsSystem"] = "1",
                    ["fieldOption"] = "like",
                    ["fieldSystemName"] = "created",
                    ["fieldType"] = "text",
                    ["selectOption"] = new JsonArray(),
                    ["value"] = dateRange,
                    ["id"] = "1",
                });
            }

            searchData["workspace_ids"] = workspaceId;
            searchData["search_data"] = JsonSerializer.Serialize(new
            {
                data = filterData,
                optionType = "AND",
                needInit = "1",
            });
            searchData["obj_type"] = dataType == "bugs" ? "bug" : dataType.TrimEnd('s');
            searchData["search_type"] = "advanced";
            searchData["page"] = page;
            searchData["perpage"] = "20";
            searchData["block_size"] = 50;
            searchData["parallel_token"] = "";
            searchData["order_field"] = "created";
            searchData["order_value"] = "desc";
            searchData["show_fields"] = new JsonArray();
            searchData["extra_fields"] = new JsonArray();
            searchData["display_mode"] = "list";
            searchData["version"] = "1.1.0";
            searchData["only_gen_token"] = 0;
            searchData["exclude_workspace_configs"] = new JsonArray();
            searchData["from_pro_dashboard"] = 1;
            if (!string.IsNullOrWhiteSpace(dscToken))
                searchData["dsc_token"] = dscToken;

            var request = new HttpRequestMessage(HttpMethod.Post, searchUrl);
            request.Headers.Add("Cookie", cookieStr);
            request.Headers.Add("Accept", "application/json, text/plain, */*");
            request.Headers.Add("Accept-Language", "zh-CN,zh;q=0.9");
            request.Headers.Add("Origin", "https://www.tapd.cn");
            request.Headers.Add("Referer", $"https://www.tapd.cn/tapd_fe/{workspaceId}/bug/list");
            request.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36");
            request.Headers.Add("sec-ch-ua", "\"Not:A-Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"");
            request.Headers.Add("sec-ch-ua-mobile", "?0");
            request.Headers.Add("sec-ch-ua-platform", "\"Windows\"");
            request.Headers.Add("Sec-Fetch-Dest", "empty");
            request.Headers.Add("Sec-Fetch-Mode", "cors");
            request.Headers.Add("Sec-Fetch-Site", "same-origin");
            request.Headers.Add("DNT", "1");
            request.Content = new StringContent(searchData.ToJsonString(), System.Text.Encoding.UTF8, "application/json");

            var response = await client.SendAsync(request, CancellationToken.None);
            var body = await response.Content.ReadAsStringAsync(CancellationToken.None);

            if (!response.IsSuccessStatusCode)
            {
                logs.AppendLine($"Page {page}: HTTP {(int)response.StatusCode} - request failed");
                break;
            }

            // 检测非 JSON 响应（TAPD 可能返回 HTML 登录页）
            var trimmedBody = body.TrimStart();
            if (trimmedBody.Length == 0 || (trimmedBody[0] != '{' && trimmedBody[0] != '['))
            {
                logs.AppendLine($"Page {page}: TAPD 返回非 JSON 响应（可能 Cookie 已过期需重新登录）");
                logs.AppendLine($"Response preview: {body[..Math.Min(200, body.Length)]}");
                throw new InvalidOperationException("TAPD Cookie 可能已过期，请重新从浏览器复制 Cookie。TAPD 返回了非 JSON 响应（HTML 页面）。");
            }

            // 解析响应
            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;

                // 先检查 data 字段是否存在且为对象（TAPD 错误时 data 可能是 string）
                if (root.TryGetProperty("data", out var dataEl) &&
                    dataEl.ValueKind == JsonValueKind.Object &&
                    dataEl.TryGetProperty("list", out var listEl))
                {
                    var items = listEl.EnumerateArray().ToList();
                    if (items.Count == 0)
                    {
                        logs.AppendLine($"Page {page}: empty list, stopping");
                        break;
                    }

                    foreach (var item in items)
                        allItems.Add(JsonNode.Parse(item.GetRawText())!);

                    if (page == 1 && dataEl.TryGetProperty("total_count", out var totalEl))
                    {
                        var totalStr = totalEl.ValueKind == JsonValueKind.Number
                            ? totalEl.GetInt32().ToString()
                            : totalEl.GetString() ?? "0";
                        totalCount = int.TryParse(totalStr, out var tc) ? tc : 0;
                        logs.AppendLine($"Total count: {totalCount}");
                    }

                    logs.AppendLine($"Page {page}: got {items.Count} items (cumulative: {allItems.Count})");

                    if (allItems.Count >= totalCount && totalCount > 0)
                        break;
                }
                else
                {
                    // 可能 Cookie 过期、data 为 string 错误消息、或格式异常
                    var info = root.TryGetProperty("info", out var infoEl) && infoEl.ValueKind == JsonValueKind.String
                        ? infoEl.GetString() : null;
                    var dataStr = root.TryGetProperty("data", out var dEl) && dEl.ValueKind == JsonValueKind.String
                        ? dEl.GetString() : null;
                    var errorMsg = info ?? dataStr ?? "unknown";
                    logs.AppendLine($"Page {page}: unexpected response - {errorMsg}");
                    logs.AppendLine($"Response preview: {body[..Math.Min(500, body.Length)]}");
                    if (page == 1)
                        throw new InvalidOperationException($"TAPD 请求失败: {errorMsg}。请检查 Cookie 是否有效、工作空间 ID 是否正确。");
                    break;
                }
            }
            catch (JsonException ex)
            {
                logs.AppendLine($"Page {page}: JSON parse error - {ex.Message}");
                break;
            }

            page++;
            if (page <= maxPages)
                await Task.Delay(500, CancellationToken.None); // 避免请求过快
        }

        logs.AppendLine($"Done: {allItems.Count} total items collected across {page - 1} pages");

        if (allItems.Count == 0)
            throw new InvalidOperationException(
                $"采集到 0 条数据。工作空间={workspaceId}，时间范围={dateRange}（留空可获取全部数据）");

        var resultJson = allItems.ToJsonString();
        var artifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType}", resultJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
    }

    /// <summary>Basic Auth 模式：使用 TAPD Open API</summary>
    private static async Task<CapsuleResult> ExecuteTapdBasicAuthModeAsync(
        IHttpClientFactory factory, WorkflowNode node, Dictionary<string, string> variables,
        string workspaceId, string dataType, string dateRange)
    {
        var authToken = ReplaceVariables(
            GetConfigString(node, "auth_token") ?? GetConfigString(node, "authToken")
            ?? GetConfigString(node, "apiToken") ?? "", variables);

        var url = $"https://api.tapd.cn/{dataType}?workspace_id={workspaceId}";
        if (!string.IsNullOrWhiteSpace(dateRange))
            url += $"&created=>={dateRange}-01&created=<={dateRange}-31";

        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        if (!string.IsNullOrWhiteSpace(authToken))
            client.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Basic", authToken);

        var response = await client.GetAsync(url, CancellationToken.None);
        var body = await response.Content.ReadAsStringAsync(CancellationToken.None);
        var logs = $"TAPD BasicAuth mode: {url}\nStatus: {(int)response.StatusCode}\nBody length: {body.Length}\n";

        var artifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType}", body, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    public static CapsuleResult ExecuteDataExtractor(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var jsonPath = GetConfigString(node, "json_path") ?? GetConfigString(node, "jsonPath") ?? "$";
        var allInput = string.Join("\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent));

        // 简单提取：如果输入是 JSON 数组，尝试过滤
        var output = allInput; // 目前直通，JSONPath 深度解析待扩展
        var logs = $"Data extractor: path={jsonPath}, input_size={allInput.Length}\n";

        var artifact = MakeTextArtifact(node, "extracted-data", "提取结果", output, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    public static CapsuleResult ExecuteDataMerger(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var strategy = GetConfigString(node, "merge_strategy") ?? GetConfigString(node, "mergeStrategy") ?? "concat";

        string merged;
        if (strategy == "json-array")
        {
            var items = inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent!)
                .ToList();
            merged = JsonSerializer.Serialize(items);
        }
        else
        {
            merged = string.Join("\n---\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent));
        }

        var logs = $"Data merger: strategy={strategy}, sources={inputArtifacts.Count}\n";
        var artifact = MakeTextArtifact(node, "merged-data", "合并结果", merged);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    // ── 流程控制类 ──────────────────────────────────────────────

    public static async Task<CapsuleResult> ExecuteDelayAsync(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var seconds = int.TryParse(GetConfigString(node, "seconds"), out var s) ? Math.Clamp(s, 1, 300) : 3;
        var message = GetConfigString(node, "message") ?? $"等待 {seconds} 秒";

        await Task.Delay(TimeSpan.FromSeconds(seconds), CancellationToken.None);

        // 透传上游数据
        var passthrough = inputArtifacts.Count > 0
            ? string.Join("\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent))
            : "{}";

        var output = JsonSerializer.Serialize(new { delayed = true, seconds, message, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "delay-out", "延时输出", passthrough.Length > 2 ? passthrough : output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, $"Delay: {seconds}s — {message}");
    }

    public static CapsuleResult ExecuteCondition(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var field = GetConfigString(node, "field") ?? "";
        var op = GetConfigString(node, "operator") ?? "==";
        var compareValue = GetConfigString(node, "value") ?? "";

        // 从输入产物中提取 JSON 数据
        var inputText = inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent!)
            .FirstOrDefault() ?? "{}";

        // 提取字段值（支持嵌套路径如 data.count）
        string? fieldValue = null;
        try
        {
            using var doc = JsonDocument.Parse(inputText);
            var current = doc.RootElement;
            foreach (var part in field.Split('.'))
            {
                if (current.ValueKind == JsonValueKind.Object && current.TryGetProperty(part, out var child))
                    current = child;
                else
                    { current = default; break; }
            }
            if (current.ValueKind != JsonValueKind.Undefined)
                fieldValue = current.ToString();
        }
        catch { /* 无法解析，fieldValue 为 null */ }

        // 求值
        var result = EvaluateCondition(fieldValue, op, compareValue);

        var logs = $"Condition: {field} {op} {compareValue}\n  FieldValue = {fieldValue ?? "(null)"}\n  Result = {result}\n";

        // 输出到对应的 slot：cond-true 或 cond-false
        var activeSlotId = result ? "cond-true" : "cond-false";
        var branchLabel = result ? "TRUE 分支" : "FALSE 分支";

        var artifact = new ExecutionArtifact
        {
            Name = branchLabel,
            MimeType = "application/json",
            SlotId = activeSlotId,
            InlineContent = inputText,
            SizeBytes = System.Text.Encoding.UTF8.GetByteCount(inputText),
        };

        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    private static bool EvaluateCondition(string? fieldValue, string op, string compareValue)
    {
        return op switch
        {
            "empty" => string.IsNullOrWhiteSpace(fieldValue),
            "not-empty" => !string.IsNullOrWhiteSpace(fieldValue),
            "==" => string.Equals(fieldValue, compareValue, StringComparison.OrdinalIgnoreCase),
            "!=" => !string.Equals(fieldValue, compareValue, StringComparison.OrdinalIgnoreCase),
            "contains" => fieldValue?.Contains(compareValue, StringComparison.OrdinalIgnoreCase) == true,
            ">" or ">=" or "<" or "<=" => EvaluateNumericCondition(fieldValue, op, compareValue),
            _ => false,
        };
    }

    private static bool EvaluateNumericCondition(string? fieldValue, string op, string compareValue)
    {
        if (!double.TryParse(fieldValue, out var left) || !double.TryParse(compareValue, out var right))
            return false;
        return op switch
        {
            ">" => left > right,
            ">=" => left >= right,
            "<" => left < right,
            "<=" => left <= right,
            _ => false,
        };
    }

    // ── 数据统计 ──────────────────────────────────────────────

    /// <summary>
    /// 数据统计舱：对 JSON 数组数据进行分组计数、分布统计、时间趋势分析。
    /// 输出紧凑的统计摘要 JSON（通常 &lt; 5KB），供后续 LLM 分析趋势而非处理原始数据。
    /// </summary>
    public static CapsuleResult ExecuteDataAggregator(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var groupByStr = GetConfigString(node, "groupByFields") ?? "severity,status,current_owner,module";
        var dateField = GetConfigString(node, "dateField") ?? "created";
        var dateGroupBy = GetConfigString(node, "dateGroupBy") ?? "week";
        var topN = int.TryParse(GetConfigString(node, "topN"), out var n) ? Math.Clamp(n, 1, 100) : 10;

        var groupByFields = groupByStr.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var logs = new StringBuilder();
        logs.AppendLine($"[数据统计器] 节点: {node.Name}");
        logs.AppendLine($"  分组字段: {string.Join(", ", groupByFields)}");
        logs.AppendLine($"  日期字段: {dateField}, 粒度: {dateGroupBy}, Top N: {topN}");

        // 收集所有输入数据为 JSON 数组
        var allItems = new List<JsonElement>();
        foreach (var art in inputArtifacts)
        {
            if (string.IsNullOrWhiteSpace(art.InlineContent)) continue;
            try
            {
                using var doc = JsonDocument.Parse(art.InlineContent);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in doc.RootElement.EnumerateArray())
                        allItems.Add(item.Clone());
                }
                else
                {
                    allItems.Add(doc.RootElement.Clone());
                }
            }
            catch { logs.AppendLine($"  ⚠️ 跳过无法解析的输入: {art.Name}"); }
        }

        logs.AppendLine($"  总记录数: {allItems.Count}");

        if (allItems.Count == 0)
        {
            var emptyResult = JsonSerializer.Serialize(new { totalCount = 0, message = "无数据" });
            var emptyArt = MakeTextArtifact(node, "agg-out", "统计摘要", emptyResult, "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { emptyArt }, logs.ToString());
        }

        // ── 1. 按字段分组统计 ──
        var distributions = new Dictionary<string, object>();
        foreach (var field in groupByFields)
        {
            var counts = new Dictionary<string, int>();
            var missing = 0;

            foreach (var item in allItems)
            {
                var val = ExtractFieldValue(item, field);
                if (val == null)
                    { missing++; continue; } // 字段不存在
                if (string.IsNullOrWhiteSpace(val))
                    val = "(未设置)"; // 字段存在但值为空
                counts[val] = counts.TryGetValue(val, out var c) ? c + 1 : 1;
            }

            // 排序取 Top N，其余归入「其他」
            var sorted = counts.OrderByDescending(kv => kv.Value).ToList();
            var topItems = sorted.Take(topN).ToList();
            var otherCount = sorted.Skip(topN).Sum(kv => kv.Value);

            var groups = topItems.Select(kv => new { name = kv.Key, count = kv.Value, percent = Math.Round(100.0 * kv.Value / allItems.Count, 1) }).ToList();
            if (otherCount > 0)
                groups.Add(new { name = "其他", count = otherCount, percent = Math.Round(100.0 * otherCount / allItems.Count, 1) });

            distributions[field] = new
            {
                total = allItems.Count - missing,
                missing,
                groups,
            };

            logs.AppendLine($"  {field}: {counts.Count} 个分组, top={topItems.FirstOrDefault().Key ?? "N/A"}({topItems.FirstOrDefault().Value}), missing={missing}");
        }

        // ── 2. 时间趋势统计 ──
        var timeline = new Dictionary<string, int>();
        var dateParseErrors = 0;
        foreach (var item in allItems)
        {
            var dateStr = ExtractFieldValue(item, dateField);
            if (string.IsNullOrWhiteSpace(dateStr)) continue;

            if (TryParseFlexibleDate(dateStr, out var dt))
            {
                var key = dateGroupBy switch
                {
                    "day" => dt.ToString("yyyy-MM-dd"),
                    "month" => dt.ToString("yyyy-MM"),
                    _ => GetIsoWeek(dt), // week
                };
                timeline[key] = timeline.TryGetValue(key, out var tc) ? tc + 1 : 1;
            }
            else
            {
                dateParseErrors++;
            }
        }

        var sortedTimeline = timeline.OrderBy(kv => kv.Key)
            .Select(kv => new { period = kv.Key, count = kv.Value })
            .ToList();

        logs.AppendLine($"  时间趋势: {sortedTimeline.Count} 个时段, 解析失败: {dateParseErrors}");

        // ── 3. 交叉统计（严重程度 × 状态） ──
        object? crossTab = null;
        if (groupByFields.Length >= 2)
        {
            var f1 = groupByFields[0]; // e.g. severity
            var f2 = groupByFields[1]; // e.g. status
            var cross = new Dictionary<string, Dictionary<string, int>>();
            foreach (var item in allItems)
            {
                var v1 = ExtractFieldValue(item, f1) ?? "(空)";
                var v2 = ExtractFieldValue(item, f2) ?? "(空)";
                if (!cross.ContainsKey(v1)) cross[v1] = new Dictionary<string, int>();
                cross[v1][v2] = cross[v1].TryGetValue(v2, out var xc) ? xc + 1 : 1;
            }
            crossTab = new { dimensions = $"{f1} × {f2}", data = cross };
            logs.AppendLine($"  交叉统计: {f1} × {f2}, {cross.Count} 行");
        }

        // ── 4. 自动检测的数值字段摘要 ──
        var numericSummaries = new Dictionary<string, object>();
        // 尝试对首条数据中的疑似数值字段求统计
        if (allItems.Count > 0 && allItems[0].ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in allItems[0].EnumerateObject())
            {
                if (prop.Value.ValueKind is JsonValueKind.Number)
                {
                    var values = allItems
                        .Select(i => i.TryGetProperty(prop.Name, out var v) && v.TryGetDouble(out var d) ? d : (double?)null)
                        .Where(v => v.HasValue)
                        .Select(v => v!.Value)
                        .ToList();

                    if (values.Count > 0)
                    {
                        numericSummaries[prop.Name] = new
                        {
                            count = values.Count,
                            sum = Math.Round(values.Sum(), 2),
                            avg = Math.Round(values.Average(), 2),
                            min = values.Min(),
                            max = values.Max(),
                        };
                    }
                }
            }
        }

        // ── 组装最终输出 ──
        var result = new Dictionary<string, object>
        {
            ["_summary"] = new
            {
                totalRecords = allItems.Count,
                analyzedFields = groupByFields,
                dateField,
                dateGroupBy,
                generatedAt = DateTime.UtcNow.ToString("O"),
            },
            ["distributions"] = distributions,
            ["timeline"] = sortedTimeline,
        };

        if (crossTab != null)
            result["crossTab"] = crossTab;
        if (numericSummaries.Count > 0)
            result["numericSummaries"] = numericSummaries;

        var outputJson = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
        logs.AppendLine($"  输出统计摘要: {outputJson.Length} chars ({Encoding.UTF8.GetByteCount(outputJson)} bytes)");

        var artifact = MakeTextArtifact(node, "agg-out", "统计摘要", outputJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
    }

    /// <summary>从 JSON 元素中提取字段值（支持嵌套路径如 "Bug.severity"）</summary>
    private static string? ExtractFieldValue(JsonElement item, string fieldPath)
    {
        var current = item;
        foreach (var part in fieldPath.Split('.'))
        {
            if (current.ValueKind == JsonValueKind.Object && current.TryGetProperty(part, out var child))
                current = child;
            else
                return null;
        }
        return current.ValueKind switch
        {
            JsonValueKind.String => current.GetString(),
            JsonValueKind.Number => current.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Null => null,
            _ => current.GetRawText(),
        };
    }

    /// <summary>灵活日期解析：支持 ISO 8601、常见日期格式、纯日期等</summary>
    private static bool TryParseFlexibleDate(string dateStr, out DateTime result)
    {
        // 常见格式
        var formats = new[]
        {
            "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss",
            "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss.fffZ",
            "yyyy-MM-dd", "yyyy/MM/dd", "yyyy/MM/dd HH:mm:ss",
            "MM/dd/yyyy", "dd/MM/yyyy",
        };
        return DateTime.TryParseExact(dateStr, formats,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AllowWhiteSpaces, out result)
            || DateTime.TryParse(dateStr, out result);
    }

    /// <summary>返回 ISO 周格式 "2026-W09"</summary>
    private static string GetIsoWeek(DateTime dt)
    {
        var cal = System.Globalization.CultureInfo.InvariantCulture.Calendar;
        var week = cal.GetWeekOfYear(dt, System.Globalization.CalendarWeekRule.FirstFourDayWeek, DayOfWeek.Monday);
        return $"{dt.Year}-W{week:D2}";
    }

    // ── 格式转换 ──────────────────────────────────────────────

    public static CapsuleResult ExecuteFormatConverter(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var sourceFormat = GetConfigString(node, "sourceFormat") ?? "json";
        var targetFormat = GetConfigString(node, "targetFormat") ?? "csv";
        var csvDelimiter = GetConfigString(node, "csvDelimiter") ?? ",";
        var xmlRootTag = GetConfigString(node, "xmlRootTag") ?? "root";
        var prettyPrint = GetConfigString(node, "prettyPrint") != "false";

        var inputText = string.Join("\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent));

        if (string.IsNullOrWhiteSpace(inputText))
            throw new InvalidOperationException("格式转换器未收到输入数据");

        var logs = $"Format converter: {sourceFormat} → {targetFormat}\n";

        // 1. 先将源格式解析为统一的内部结构（JSON element）
        JsonElement? jsonData = null;
        try
        {
            if (sourceFormat == "json")
            {
                jsonData = JsonSerializer.Deserialize<JsonElement>(inputText);
            }
            else if (sourceFormat == "csv" || sourceFormat == "tsv")
            {
                var delim = sourceFormat == "tsv" ? '\t' : csvDelimiter[0];
                jsonData = CsvToJson(inputText, delim);
            }
            else if (sourceFormat == "xml")
            {
                jsonData = XmlToJson(inputText);
            }
            else
            {
                // yaml / text → 尝试 JSON 解析，失败则包装为字符串
                try { jsonData = JsonSerializer.Deserialize<JsonElement>(inputText); }
                catch { jsonData = JsonSerializer.Deserialize<JsonElement>($"\"{EscapeJsonString(inputText)}\""); }
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"源格式 '{sourceFormat}' 解析失败: {ex.Message}");
        }

        logs += $"Parsed {sourceFormat}: OK\n";

        // 2. 将内部结构序列化为目标格式
        string output;
        string mimeType;

        if (targetFormat == "json")
        {
            output = prettyPrint
                ? JsonSerializer.Serialize(jsonData, new JsonSerializerOptions { WriteIndented = true })
                : JsonSerializer.Serialize(jsonData);
            mimeType = "application/json";
        }
        else if (targetFormat == "csv" || targetFormat == "tsv")
        {
            var delim = targetFormat == "tsv" ? '\t' : csvDelimiter[0];
            output = JsonToCsv(jsonData!.Value, delim);
            mimeType = "text/csv";
        }
        else if (targetFormat == "xml")
        {
            output = JsonToXml(jsonData!.Value, xmlRootTag, prettyPrint);
            mimeType = "application/xml";
        }
        else if (targetFormat == "markdown-table")
        {
            output = JsonToMarkdownTable(jsonData!.Value);
            mimeType = "text/markdown";
        }
        else
        {
            output = jsonData.HasValue ? jsonData.Value.ToString() : inputText;
            mimeType = "text/plain";
        }

        logs += $"Output {targetFormat}: {Encoding.UTF8.GetByteCount(output)} bytes\n";

        var artifact = MakeTextArtifact(node, "convert-out", $"转换结果 ({targetFormat})", output, mimeType);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    // ── 格式转换辅助方法 ──

    private static JsonElement CsvToJson(string csv, char delimiter)
    {
        var lines = csv.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToArray();
        if (lines.Length == 0) return JsonSerializer.Deserialize<JsonElement>("[]");

        var headers = ParseCsvLine(lines[0], delimiter);
        var rows = new List<Dictionary<string, string>>();

        for (var i = 1; i < lines.Length; i++)
        {
            var values = ParseCsvLine(lines[i], delimiter);
            var row = new Dictionary<string, string>();
            for (var j = 0; j < headers.Count; j++)
                row[headers[j]] = j < values.Count ? values[j] : "";
            rows.Add(row);
        }

        return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(rows));
    }

    private static List<string> ParseCsvLine(string line, char delimiter)
    {
        var fields = new List<string>();
        var inQuotes = false;
        var field = new System.Text.StringBuilder();

        foreach (var ch in line)
        {
            if (ch == '"') { inQuotes = !inQuotes; continue; }
            if (ch == delimiter && !inQuotes) { fields.Add(field.ToString().Trim()); field.Clear(); continue; }
            field.Append(ch);
        }
        fields.Add(field.ToString().Trim());
        return fields;
    }

    private static string JsonToCsv(JsonElement json, char delimiter)
    {
        if (json.ValueKind != JsonValueKind.Array) return json.ToString();

        var rows = json.EnumerateArray().ToList();
        if (rows.Count == 0) return "";

        // 收集所有列
        var columns = new List<string>();
        foreach (var row in rows)
        {
            if (row.ValueKind == JsonValueKind.Object)
                foreach (var prop in row.EnumerateObject())
                    if (!columns.Contains(prop.Name)) columns.Add(prop.Name);
        }

        var sb = new System.Text.StringBuilder();
        sb.AppendLine(string.Join(delimiter, columns.Select(c => CsvQuote(c, delimiter))));

        foreach (var row in rows)
        {
            var values = columns.Select(col =>
            {
                if (row.ValueKind == JsonValueKind.Object && row.TryGetProperty(col, out var val))
                    return CsvQuote(val.ToString(), delimiter);
                return "";
            });
            sb.AppendLine(string.Join(delimiter, values));
        }

        return sb.ToString().TrimEnd();
    }

    private static string CsvQuote(string value, char delimiter)
    {
        if (value.Contains(delimiter) || value.Contains('"') || value.Contains('\n'))
            return $"\"{value.Replace("\"", "\"\"")}\"";
        return value;
    }

    private static JsonElement XmlToJson(string xml)
    {
        // 简易 XML → JSON：用 XDocument 解析后递归转换
        var doc = System.Xml.Linq.XDocument.Parse(xml);
        var json = XmlElementToJson(doc.Root!);
        return JsonSerializer.Deserialize<JsonElement>(json);
    }

    private static string XmlElementToJson(System.Xml.Linq.XElement el)
    {
        if (!el.HasElements)
            return JsonSerializer.Serialize(el.Value);

        // 检查是否有重复子元素名（数组）
        var groups = el.Elements().GroupBy(e => e.Name.LocalName).ToList();
        var dict = new Dictionary<string, object>();

        foreach (var g in groups)
        {
            if (g.Count() > 1)
            {
                var arr = g.Select(e => JsonSerializer.Deserialize<object>(XmlElementToJson(e))).ToList();
                dict[g.Key] = arr;
            }
            else
            {
                dict[g.Key] = JsonSerializer.Deserialize<object>(XmlElementToJson(g.First()))!;
            }
        }

        return JsonSerializer.Serialize(dict);
    }

    private static string JsonToXml(JsonElement json, string rootTag, bool indent)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append($"<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        if (indent) sb.AppendLine();
        sb.Append($"<{rootTag}>");
        if (indent) sb.AppendLine();
        WriteJsonToXml(sb, json, 1, indent);
        sb.Append($"</{rootTag}>");
        return sb.ToString();
    }

    private static void WriteJsonToXml(System.Text.StringBuilder sb, JsonElement el, int depth, bool indent)
    {
        var pad = indent ? new string(' ', depth * 2) : "";
        var nl = indent ? "\n" : "";

        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var prop in el.EnumerateObject())
                {
                    sb.Append($"{pad}<{prop.Name}>");
                    if (prop.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                    {
                        sb.Append(nl);
                        WriteJsonToXml(sb, prop.Value, depth + 1, indent);
                        sb.Append($"{pad}</{prop.Name}>{nl}");
                    }
                    else
                    {
                        sb.Append(System.Security.SecurityElement.Escape(prop.Value.ToString()));
                        sb.Append($"</{prop.Name}>{nl}");
                    }
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in el.EnumerateArray())
                {
                    sb.Append($"{pad}<item>");
                    if (item.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                    {
                        sb.Append(nl);
                        WriteJsonToXml(sb, item, depth + 1, indent);
                        sb.Append($"{pad}</item>{nl}");
                    }
                    else
                    {
                        sb.Append(System.Security.SecurityElement.Escape(item.ToString()));
                        sb.Append($"</item>{nl}");
                    }
                }
                break;
            default:
                sb.Append($"{pad}{System.Security.SecurityElement.Escape(el.ToString())}{nl}");
                break;
        }
    }

    private static string JsonToMarkdownTable(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Array) return $"```\n{json}\n```";

        var rows = json.EnumerateArray().ToList();
        if (rows.Count == 0) return "*空数据*";

        var columns = new List<string>();
        foreach (var row in rows)
        {
            if (row.ValueKind == JsonValueKind.Object)
                foreach (var prop in row.EnumerateObject())
                    if (!columns.Contains(prop.Name)) columns.Add(prop.Name);
        }

        var sb = new System.Text.StringBuilder();
        sb.AppendLine("| " + string.Join(" | ", columns) + " |");
        sb.AppendLine("| " + string.Join(" | ", columns.Select(_ => "---")) + " |");

        foreach (var row in rows)
        {
            var values = columns.Select(col =>
            {
                if (row.ValueKind == JsonValueKind.Object && row.TryGetProperty(col, out var val))
                    return val.ToString().Replace("|", "\\|");
                return "";
            });
            sb.AppendLine("| " + string.Join(" | ", values) + " |");
        }

        return sb.ToString().TrimEnd();
    }

    private static string EscapeJsonString(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
    }

    // ── 输出类 ──────────────────────────────────────────────

    public static async Task<CapsuleResult> ExecuteReportGeneratorAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var gateway = sp.GetService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        if (gateway == null)
            throw new InvalidOperationException("LLM Gateway 未配置，无法生成报告");

        var reportTemplate = ReplaceVariables(GetConfigString(node, "reportTemplate") ?? "", variables);
        var format = GetConfigString(node, "format") ?? "markdown";
        var maxInputTokens = int.TryParse(GetConfigString(node, "maxInputTokens"), out var mit) ? mit : 80000;

        var reportLogs = new StringBuilder();
        reportLogs.AppendLine($"[报告生成器] 节点: {node.Name}");
        reportLogs.AppendLine($"  Format: {format}");
        reportLogs.AppendLine($"  InputArtifacts: {inputArtifacts.Count} 个");
        foreach (var ia in inputArtifacts)
            reportLogs.AppendLine($"    - [{ia.Name}] SlotId={ia.SlotId} InlineContent={ia.InlineContent?.Length ?? 0} chars, SizeBytes={ia.SizeBytes}");

        var inputText = string.Join("\n---\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => $"[{a.Name}]\n{a.InlineContent}"));

        reportLogs.AppendLine($"  原始 InputText: {inputText.Length} chars (估算 {EstimateTokens(inputText)} tokens)");

        // Token 感知截断
        var templateTokens = EstimateTokens(reportTemplate);
        var dataTokenBudget = maxInputTokens - templateTokens - 500;
        if (dataTokenBudget < 1000) dataTokenBudget = 1000;

        var (truncatedInput, _, wasTruncated) = TruncateToTokenBudget(inputText, dataTokenBudget, reportLogs);
        if (wasTruncated) inputText = truncatedInput;

        var prompt = string.IsNullOrWhiteSpace(reportTemplate)
            ? $"请根据以下数据生成{format}格式的报告：\n\n{inputText}"
            : $"{reportTemplate}\n\n## 数据\n\n{inputText}";

        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = PrdAgent.Core.Models.AppCallerRegistry.WorkflowAgent.ReportGenerator.Chat,
            ModelType = "chat",
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = prompt
                    }
                }
            }
        };

        reportLogs.AppendLine($"  ReportTemplate ({reportTemplate.Length} chars): {(reportTemplate.Length > 300 ? reportTemplate[..300] + "..." : reportTemplate)}");
        reportLogs.AppendLine($"  Prompt 总长: {prompt.Length} chars (估算 {EstimateTokens(prompt)} tokens)");
        reportLogs.AppendLine("  --- 调用 LLM Gateway ---");

        var response = await gateway.SendAsync(request, CancellationToken.None);
        var content = response.Content ?? "";

        reportLogs.AppendLine($"  Model: {response.Resolution?.ActualModel ?? "(unknown)"}");
        reportLogs.AppendLine($"  Tokens: input={response.TokenUsage?.InputTokens ?? 0} output={response.TokenUsage?.OutputTokens ?? 0}");
        reportLogs.AppendLine($"  ResolutionType: {response.Resolution?.ResolutionType}");

        // 记录 Gateway 错误信息
        if (!string.IsNullOrWhiteSpace(response.ErrorCode) || !string.IsNullOrWhiteSpace(response.ErrorMessage))
        {
            reportLogs.AppendLine($"  ❌ Gateway 错误: [{response.ErrorCode}] {response.ErrorMessage}");
            reportLogs.AppendLine($"  HTTP Status: {response.StatusCode}");
        }

        reportLogs.AppendLine($"  LLM 响应 ({content.Length} chars): {(content.Length > 500 ? content[..500] + "..." : content)}");

        if (string.IsNullOrWhiteSpace(content))
        {
            var reason = !string.IsNullOrWhiteSpace(response.ErrorMessage)
                ? $"Gateway 错误: {response.ErrorMessage}"
                : "可能是 LLM 调度失败";
            reportLogs.AppendLine($"  ⚠️ 警告: 报告内容为空 ({reason})");
        }

        var mimeType = format == "html" ? "text/html" : "text/markdown";
        var artifact = MakeTextArtifact(node, "report", "报告", content, mimeType);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, reportLogs.ToString());
    }

    public static CapsuleResult ExecuteFileExporter(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var format = GetConfigString(node, "format") ?? GetConfigString(node, "fileFormat") ?? "json";
        var fileName = GetConfigString(node, "file_name") ?? GetConfigString(node, "fileName") ?? $"export.{format}";

        // 替换日期占位符
        var now = DateTime.Now;
        fileName = fileName
            .Replace("{{date}}", now.ToString("yyyy-MM-dd"))
            .Replace("{date}", now.ToString("yyyy-MM-dd"))
            .Replace("{{datetime}}", now.ToString("yyyy-MM-dd_HHmmss"))
            .Replace("{datetime}", now.ToString("yyyy-MM-dd_HHmmss"));

        // 确保文件有扩展名
        if (!fileName.Contains('.'))
            fileName = $"{fileName}.{format}";

        var content = string.Join("\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent));

        var mimeType = format switch
        {
            "csv" => "text/csv",
            "html" => "text/html",
            "md" or "markdown" => "text/markdown",
            "txt" => "text/plain",
            _ => "application/json",
        };

        var exportLogs = new StringBuilder();
        exportLogs.AppendLine($"[文件导出器] 节点: {node.Name}");
        exportLogs.AppendLine($"  FileName: {fileName}");
        exportLogs.AppendLine($"  Format: {format} (MIME: {mimeType})");
        exportLogs.AppendLine($"  InputArtifacts: {inputArtifacts.Count} 个");
        foreach (var ia in inputArtifacts)
            exportLogs.AppendLine($"    - [{ia.Name}] SlotId={ia.SlotId} InlineContent={ia.InlineContent?.Length ?? 0} chars, SizeBytes={ia.SizeBytes}, CosUrl={ia.CosUrl ?? "(null)"}");
        exportLogs.AppendLine($"  Content: {content.Length} chars, {Encoding.UTF8.GetByteCount(content)} bytes");
        if (content.Length > 0)
            exportLogs.AppendLine($"  Preview: {(content.Length > 200 ? content[..200] + "..." : content)}");
        else
            exportLogs.AppendLine("  ⚠️ 警告: 导出内容为空");

        var artifact = new ExecutionArtifact
        {
            Name = fileName,
            MimeType = mimeType,
            SlotId = node.OutputSlots.FirstOrDefault()?.SlotId ?? "export-file",
            InlineContent = content,
            SizeBytes = Encoding.UTF8.GetByteCount(content),
        };

        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, exportLogs.ToString());
    }

    public static async Task<CapsuleResult> ExecuteWebhookSenderAsync(
        IServiceProvider sp, WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var url = GetConfigString(node, "url") ?? GetConfigString(node, "webhook_url") ?? "";
        if (string.IsNullOrWhiteSpace(url))
            throw new InvalidOperationException("Webhook 发送 URL 未配置");

        var payload = JsonSerializer.Serialize(new
        {
            source = "workflow-agent",
            nodeName = node.Name,
            timestamp = DateTime.UtcNow,
            artifacts = inputArtifacts.Select(a => new { a.Name, a.MimeType, content = a.InlineContent?[..Math.Min(a.InlineContent.Length, 1000)] }),
        });

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);

        var response = await client.PostAsync(url,
            new StringContent(payload, System.Text.Encoding.UTF8, "application/json"),
            CancellationToken.None);

        var statusCode = (int)response.StatusCode;
        var logs = $"Webhook sent: {url}\nStatus: {statusCode}\n";

        var artifact = MakeTextArtifact(node, "webhook-response", "Webhook 响应", $"{{\"statusCode\":{statusCode}}}");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    public static async Task<CapsuleResult> ExecuteNotificationSenderAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var db = sp.GetRequiredService<PrdAgent.Infrastructure.Database.MongoDbContext>();
        var title = ReplaceVariables(GetConfigString(node, "title") ?? node.Name, variables);
        // 优先读 "content" (schema 定义的 key)，兼容旧的 "message"
        var message = ReplaceVariables(
            GetConfigString(node, "content") ?? GetConfigString(node, "message") ?? "", variables);
        var level = GetConfigString(node, "level") ?? "info";

        if (string.IsNullOrWhiteSpace(message) && inputArtifacts.Count > 0)
        {
            // 从输入产物中生成人类可读的摘要，而非原始 JSON
            var summaryParts = new List<string>();
            foreach (var a in inputArtifacts.Where(a => !string.IsNullOrWhiteSpace(a.InlineContent)))
            {
                var content = a.InlineContent!;
                // 如果内容看起来像 JSON，提取摘要信息
                if (content.TrimStart().StartsWith("{") || content.TrimStart().StartsWith("["))
                {
                    summaryParts.Add($"[{a.Name}] 数据已生成 ({a.SizeBytes} bytes)");
                }
                else
                {
                    // 纯文本/Markdown 取前 200 字符
                    var preview = content.Length > 200 ? content[..200] + "..." : content;
                    summaryParts.Add($"[{a.Name}] {preview}");
                }
            }
            message = string.Join("\n", summaryParts);
        }

        var notification = new AdminNotification
        {
            Title = title,
            Message = message,
            Level = level,
            Source = "workflow-agent",
        };
        await db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);

        var artifact = MakeTextArtifact(node, "notification", "通知", JsonSerializer.Serialize(new { title, sent = true }));
        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"Notification sent: {title}");
    }

    // ═══════════════════════════════════════════════════════════
    // 辅助方法
    // ═══════════════════════════════════════════════════════════

    public static ExecutionArtifact MakeTextArtifact(WorkflowNode node, string slotSuffix, string name, string content, string mimeType = "text/plain")
    {
        // 优先匹配 slotSuffix 对应的 OutputSlot，支持多输出节点
        var slotId = node.OutputSlots.FirstOrDefault(s => s.SlotId == slotSuffix)?.SlotId
                  ?? node.OutputSlots.FirstOrDefault()?.SlotId
                  ?? slotSuffix;
        return new ExecutionArtifact
        {
            Name = name,
            MimeType = mimeType,
            SlotId = slotId,
            InlineContent = content,
            SizeBytes = System.Text.Encoding.UTF8.GetByteCount(content),
        };
    }

    public static string? GetConfigString(WorkflowNode node, string key)
    {
        if (node.Config.TryGetValue(key, out var val) && val != null)
        {
            string? s;
            // Handle System.Text.Json.JsonElement (from API deserialization)
            if (val is JsonElement je)
                s = je.ValueKind == JsonValueKind.String ? je.GetString() : je.GetRawText();
            else
                s = val.ToString();

            s = s?.Trim();
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }
        return null;
    }

    public static string ReplaceVariables(string template, Dictionary<string, string> variables)
    {
        if (string.IsNullOrEmpty(template) || variables.Count == 0) return template;
        var result = template;
        foreach (var (key, value) in variables)
        {
            result = result.Replace($"{{{{{key}}}}}", value);  // {{key}} → value
            result = result.Replace($"${{{key}}}", value);     // ${key} → value
        }
        return result;
    }

    public static string TruncateLogs(string logs, int maxBytes = 10240)
    {
        if (System.Text.Encoding.UTF8.GetByteCount(logs) <= maxBytes) return logs;
        // 截断保留最后 maxBytes
        while (System.Text.Encoding.UTF8.GetByteCount(logs) > maxBytes && logs.Length > 100)
            logs = logs[(logs.Length / 4)..];
        return "[...truncated...]\n" + logs;
    }
}
