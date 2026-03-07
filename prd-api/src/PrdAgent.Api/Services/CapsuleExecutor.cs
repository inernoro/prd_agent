using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jint;
using Jint.Runtime;
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

    /// <summary>共享序列化选项：不转义中文、美化输出</summary>
    private static readonly JsonSerializerOptions JsonPretty = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>共享序列化选项：不转义中文、紧凑输出</summary>
    private static readonly JsonSerializerOptions JsonCompact = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// 按舱类型调度执行。
    /// </summary>
    /// <summary>
    /// 事件发射委托：(eventName, payload) → Task
    /// </summary>
    public delegate Task EmitEventDelegate(string eventName, object payload);

    public static async Task<CapsuleResult> ExecuteAsync(
        IServiceProvider sp,
        ILogger logger,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts,
        EmitEventDelegate? emitEvent = null)
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
            CapsuleTypes.LlmAnalyzer => await ExecuteLlmAnalyzerAsync(sp, node, variables, inputArtifacts, emitEvent),
            CapsuleTypes.ScriptExecutor => ExecuteScript(node, inputArtifacts),
            CapsuleTypes.TapdCollector => await ExecuteTapdCollectorAsync(sp, node, variables),
            CapsuleTypes.DataExtractor => ExecuteDataExtractor(node, inputArtifacts),
            CapsuleTypes.DataMerger => ExecuteDataMerger(node, inputArtifacts),
            CapsuleTypes.FormatConverter => ExecuteFormatConverter(node, inputArtifacts),
            CapsuleTypes.DataAggregator => ExecuteDataAggregator(node, inputArtifacts),

            // ── 流程控制类 ──
            CapsuleTypes.Delay => await ExecuteDelayAsync(node, inputArtifacts),
            CapsuleTypes.Condition => ExecuteCondition(node, inputArtifacts),

            // ── 输出类 ──
            CapsuleTypes.ReportGenerator => await ExecuteReportGeneratorAsync(sp, node, variables, inputArtifacts, emitEvent),
            CapsuleTypes.WebpageGenerator => await ExecuteWebpageGeneratorAsync(sp, node, variables, inputArtifacts, emitEvent),
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
            allData.ToJsonString(JsonCompact), "application/json");

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
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts,
        EmitEventDelegate? emitEvent = null)
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
            TimeoutSeconds = 300, // 复杂分析任务（如 28 维度统计）需要较长时间
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = temperature,
            }
        };

        llmLogs.AppendLine($"  SystemPrompt ({systemPrompt.Length} chars):");
        llmLogs.AppendLine(systemPrompt);
        llmLogs.AppendLine($"  UserPrompt ({userContent.Length} chars):");
        llmLogs.AppendLine(userContent);
        llmLogs.AppendLine($"  总估算 Tokens: system={systemTokens} + user={EstimateTokens(userContent)} = {systemTokens + EstimateTokens(userContent)}");
        llmLogs.AppendLine($"  Temperature: {temperature}");
        llmLogs.AppendLine("  --- 调用 LLM Gateway (streaming) ---");

        // 使用流式调用，支持实时推送 LLM 输出到前端
        var contentBuilder = new StringBuilder();
        var model = "(unknown)";
        int inputTokens = 0, outputTokens = 0;
        string? resolutionType = null;
        string? errorCode = null, errorMessage = null;
        int? httpStatus = null;

        // 每积累 CHUNK_BATCH_SIZE 个字符发一次事件，避免事件过于频繁
        const int CHUNK_BATCH_SIZE = 200;
        var pendingChunk = new StringBuilder();
        var streamSw = Stopwatch.StartNew();

        if (emitEvent != null)
        {
            await emitEvent("llm-stream-start", new { nodeId = node.NodeId, nodeName = node.Name });
        }

        try
        {
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                switch (chunk.Type)
                {
                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Start:
                        model = chunk.Resolution?.ActualModel ?? "(unknown)";
                        resolutionType = chunk.Resolution?.ResolutionType;
                        if (emitEvent != null)
                        {
                            await emitEvent("llm-stream-start", new { nodeId = node.NodeId, nodeName = node.Name, model });
                        }
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Text:
                        if (!string.IsNullOrEmpty(chunk.Content))
                        {
                            contentBuilder.Append(chunk.Content);
                            pendingChunk.Append(chunk.Content);

                            // 批量发送 chunk 事件
                            if (emitEvent != null && pendingChunk.Length >= CHUNK_BATCH_SIZE)
                            {
                                await emitEvent("llm-chunk", new
                                {
                                    nodeId = node.NodeId,
                                    content = pendingChunk.ToString(),
                                    accumulatedLength = contentBuilder.Length,
                                });
                                pendingChunk.Clear();
                            }
                        }
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Done:
                        inputTokens = chunk.TokenUsage?.InputTokens ?? 0;
                        outputTokens = chunk.TokenUsage?.OutputTokens ?? 0;
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Error:
                        errorCode = "STREAM_ERROR";
                        errorMessage = chunk.Error;
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            errorCode = "STREAM_EXCEPTION";
            errorMessage = ex.Message;
        }

        // 发送剩余的 pending chunk
        if (emitEvent != null && pendingChunk.Length > 0)
        {
            await emitEvent("llm-chunk", new
            {
                nodeId = node.NodeId,
                content = pendingChunk.ToString(),
                accumulatedLength = contentBuilder.Length,
            });
        }

        streamSw.Stop();
        var content = contentBuilder.ToString();

        if (emitEvent != null)
        {
            await emitEvent("llm-stream-end", new
            {
                nodeId = node.NodeId,
                totalLength = content.Length,
                durationMs = streamSw.ElapsedMilliseconds,
                model,
                inputTokens,
                outputTokens,
            });
        }

        llmLogs.AppendLine($"  Model: {model}");
        llmLogs.AppendLine($"  Tokens: input={inputTokens} output={outputTokens}");
        llmLogs.AppendLine($"  ResolutionType: {resolutionType}");
        llmLogs.AppendLine($"  StreamDuration: {streamSw.ElapsedMilliseconds}ms");

        // 记录 Gateway 错误信息
        if (!string.IsNullOrWhiteSpace(errorCode) || !string.IsNullOrWhiteSpace(errorMessage))
        {
            llmLogs.AppendLine($"  ❌ Gateway 错误: [{errorCode}] {errorMessage}");
            if (httpStatus.HasValue) llmLogs.AppendLine($"  HTTP Status: {httpStatus}");
        }

        llmLogs.AppendLine($"  LLM 响应 ({content.Length} chars):");
        llmLogs.AppendLine(content);

        if (string.IsNullOrWhiteSpace(content))
        {
            var reason = !string.IsNullOrWhiteSpace(errorMessage)
                ? $"Gateway 错误: {errorMessage}"
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
        var hasLlmContent = contentBuilder.Length > 0 && string.IsNullOrWhiteSpace(errorCode);
        var artifactMime = hasLlmContent ? "text/plain" : inputMimeType;
        var artifact = MakeTextArtifact(node, "llm-output", "分析结果", content, artifactMime);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, llmLogs.ToString());
    }

    /// <summary>
    /// JavaScript 脚本执行器 —— 使用 Jint 引擎在沙箱中执行用户脚本。
    /// 输入：上游 artifacts 合并为 JSON → 注入为全局变量 `data`。
    /// 输出：用户脚本赋值给 `result` 变量的内容。
    /// </summary>
    public static CapsuleResult ExecuteScript(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var logs = new StringBuilder();
        logs.AppendLine($"[脚本执行器] 节点: {node.Name}");

        var code = GetConfigString(node, "code") ?? "";
        var timeoutStr = GetConfigString(node, "timeoutSeconds");
        var timeoutSeconds = int.TryParse(timeoutStr, out var t) && t is > 0 and <= 300 ? t : 30;

        if (string.IsNullOrWhiteSpace(code))
        {
            logs.AppendLine("  ⚠️ 代码为空，跳过执行");
            var emptyArt = MakeTextArtifact(node, "script-out", "脚本输出",
                JsonSerializer.Serialize(new { error = "代码为空" }), "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { emptyArt }, logs.ToString());
        }

        // ── 1. 解析上游输入：合并所有 artifact 的 InlineContent ──
        var allItems = new List<JsonElement>();
        foreach (var art in inputArtifacts)
        {
            if (string.IsNullOrWhiteSpace(art.InlineContent)) continue;
            try
            {
                using var doc = JsonDocument.Parse(art.InlineContent);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                    foreach (var item in doc.RootElement.EnumerateArray())
                        allItems.Add(item.Clone());
                else
                    allItems.Add(doc.RootElement.Clone());
            }
            catch { logs.AppendLine($"  ⚠️ 跳过无法解析的输入 artifact: {art.Name}"); }
        }

        // 将输入转为 JSON 字符串，供 Jint 解析
        var inputJson = allItems.Count switch
        {
            0 => "[]",
            1 when inputArtifacts.Count == 1 => JsonSerializer.Serialize(allItems[0], JsonCompact),
            _ => JsonSerializer.Serialize(allItems, JsonCompact)
        };
        logs.AppendLine($"  输入数据: {inputJson.Length} chars, {allItems.Count} 条记录");

        // ── 2. 创建 Jint 引擎（沙箱配置） ──
        try
        {
            var engine = new Engine(options =>
            {
                options.TimeoutInterval(TimeSpan.FromSeconds(timeoutSeconds));
                options.LimitMemory(16_000_000); // 16 MB
                options.LimitRecursion(256);
                options.Strict(false);
            });

            // 注入 data 变量：先用 JSON.parse 把字符串转为 JS 对象
            engine.Execute($"var data = JSON.parse({JsonSerializer.Serialize(inputJson)});");
            // 初始化 result 为 null
            engine.Execute("var result = null;");

            // ── 3. 执行用户脚本（Evaluate 返回最后一个表达式的值） ──
            var sw = Stopwatch.StartNew();
            var lastExprValue = engine.Evaluate(code);
            sw.Stop();

            logs.AppendLine($"  执行耗时: {sw.ElapsedMilliseconds}ms");

            // ── 4. 提取 result 变量（优先），否则用最终表达式值 ──
            var resultValue = engine.GetValue("result");
            string outputJson;

            if (resultValue == null || resultValue.IsNull() || resultValue.IsUndefined())
            {
                logs.AppendLine("  ⚠️ result 变量为空，尝试使用脚本最终表达式值");
                if (lastExprValue != null && !lastExprValue.IsNull() && !lastExprValue.IsUndefined())
                {
                    var raw = lastExprValue.ToObject();
                    outputJson = raw is string s ? s : JsonSerializer.Serialize(raw, JsonPretty);
                }
                else
                {
                    outputJson = JsonSerializer.Serialize(new { warning = "脚本未设置 result 变量且无返回值" });
                }
            }
            else
            {
                var raw = resultValue.ToObject();
                outputJson = raw is string s ? s : JsonSerializer.Serialize(raw, JsonPretty);
            }

            logs.AppendLine($"  输出: {outputJson.Length} chars");

            var artifact = MakeTextArtifact(node, "script-out", "脚本输出", outputJson, "application/json");
            var artifacts = new List<ExecutionArtifact> { artifact };

            // ── 5. 自动透传源数据引用（精简版：仅保留 ID/标题/URL，供下游 LLM 生成带链接的报告）──
            var sourceRef = BuildSourceDataReference(allItems);
            if (!string.IsNullOrEmpty(sourceRef))
            {
                var refArtifact = MakeTextArtifact(node, "script-out", "源数据引用", sourceRef, "application/json");
                artifacts.Add(refArtifact);
                logs.AppendLine($"  源数据引用: {sourceRef.Length} chars ({allItems.Count} 条记录)");
            }

            return new CapsuleResult(artifacts, logs.ToString());
        }
        catch (TimeoutException)
        {
            logs.AppendLine($"  ❌ 脚本执行超时（{timeoutSeconds}秒限制）");
            var art = MakeTextArtifact(node, "script-out", "超时错误",
                JsonSerializer.Serialize(new { error = $"脚本执行超时，已超过 {timeoutSeconds} 秒限制" }), "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { art }, logs.ToString());
        }
        catch (MemoryLimitExceededException)
        {
            logs.AppendLine("  ❌ 脚本内存超限（16MB）");
            var art = MakeTextArtifact(node, "script-out", "内存超限",
                JsonSerializer.Serialize(new { error = "脚本内存使用超过 16MB 限制" }), "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { art }, logs.ToString());
        }
        catch (RecursionDepthOverflowException)
        {
            logs.AppendLine("  ❌ 脚本递归深度超限（256层）");
            var art = MakeTextArtifact(node, "script-out", "递归超限",
                JsonSerializer.Serialize(new { error = "脚本递归深度超过 256 层限制" }), "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { art }, logs.ToString());
        }
        catch (JavaScriptException jsEx)
        {
            logs.AppendLine($"  ❌ JavaScript 运行时错误: {jsEx.Message}");
            var art = MakeTextArtifact(node, "script-out", "脚本错误",
                JsonSerializer.Serialize(new { error = jsEx.Message, stack = jsEx.JavaScriptStackTrace }), "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { art }, logs.ToString());
        }
        catch (Exception ex)
        {
            logs.AppendLine($"  ❌ 执行异常: {ex.Message}");
            var art = MakeTextArtifact(node, "script-out", "执行错误",
                JsonSerializer.Serialize(new { error = ex.Message }), "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { art }, logs.ToString());
        }
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
        // ── 兜底：如果用户提供了自定义 cURL，直接执行它 ──
        var customCurl = GetConfigString(node, "customCurl") ?? "";
        if (!string.IsNullOrWhiteSpace(customCurl))
            return await ExecuteCustomCurlAsync(factory, node, customCurl, dataType);

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

            // 如果有日期范围（月份格式如 "2026-03"），添加反馈时间筛选（自定义字段，与 GitHub 代码一致）
            if (!string.IsNullOrWhiteSpace(dateRange))
            {
                filterData.Add(new JsonObject
                {
                    ["entity"] = dataType == "bugs" ? "bug" : dataType.TrimEnd('s'),
                    ["fieldDisplayName"] = "反馈时间",
                    ["fieldSubEntityType"] = "",
                    ["fieldIsSystem"] = "0",
                    ["fieldOption"] = "like",
                    ["fieldSystemName"] = "反馈时间",
                    ["fieldType"] = "text",
                    ["selectOption"] = new JsonArray(),
                    ["value"] = dateRange,
                    ["id"] = "4",
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

        // ── 阶段二：逐个调用 common_get_info 获取缺陷详情 ──
        var fetchDetail = GetConfigString(node, "fetchDetail") ?? "true";
        if (fetchDetail == "true" && dataType is "bugs" or "bug")
        {
            var detailItems = await FetchTapdBugDetailsAsync(
                factory, allItems, workspaceId, cookieStr, dscToken, logs);
            if (detailItems.Count > 0)
            {
                var resultJson = detailItems.ToJsonString(JsonCompact);
                var artifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType} 详情", resultJson, "application/json");
                return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
            }
            // 如果详情获取全部失败，回退到搜索列表数据
            logs.AppendLine("⚠️ 详情获取失败，回退使用搜索列表数据");
        }

        var resultJsonFallback = allItems.ToJsonString(JsonCompact);
        var artifactFallback = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType}", resultJsonFallback, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifactFallback }, logs.ToString());
    }

    /// <summary>
    /// 阶段二：逐个调用 common_get_info 获取缺陷详情，提取全部字段（含自定义字段），
    /// 并映射为中文字段名，同时计算"是否历史问题"和"及时处理"衍生字段。
    /// </summary>
    private static async Task<JsonArray> FetchTapdBugDetailsAsync(
        IHttpClientFactory factory, JsonArray searchItems, string workspaceId,
        string cookieStr, string dscToken, StringBuilder logs)
    {
        var detailItems = new JsonArray();
        var detailUrl = "https://www.tapd.cn/api/aggregation/workitem_aggregation/common_get_info";

        // 从搜索结果提取 bug ID 列表
        var bugIds = new List<string>();
        foreach (var item in searchItems)
        {
            var id = item?["id"]?.GetValue<string>()
                     ?? item?["bug_id"]?.GetValue<string>()
                     ?? item?["ID"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(id)) bugIds.Add(id);
        }

        logs.AppendLine($"Phase 2: fetching details for {bugIds.Count} bugs via common_get_info");

        var successCount = 0;
        for (var i = 0; i < bugIds.Count; i++)
        {
            var entityId = bugIds[i];
            try
            {
                using var client = factory.CreateClient();
                client.Timeout = TimeSpan.FromSeconds(30);

                var body = new JsonObject
                {
                    ["workspace_id"] = workspaceId,
                    ["entity_id"] = entityId,
                    ["entity_type"] = "bug",
                    ["api_controller_prefix"] = "",
                    ["enable_description"] = "true",
                    ["is_detail"] = 1,
                    ["blacklist_fields"] = new JsonArray(),
                    ["identifier"] = "app_for_editor,app_for_obj_more,app_for_obj_dialog_dropdown",
                    ["installed_app_entity"] = new JsonObject
                    {
                        ["obj_id"] = entityId,
                        ["obj_type"] = "bug",
                        ["obj_name"] = "缺陷",
                    },
                    ["has_edit_rule_fields"] = new JsonArray(),
                    ["is_archived"] = 0,
                    ["is_assistant_exec_log"] = 1,
                };
                if (!string.IsNullOrWhiteSpace(dscToken))
                    body["dsc_token"] = dscToken;

                var request = new HttpRequestMessage(HttpMethod.Post, detailUrl);
                request.Headers.Add("Cookie", cookieStr);
                request.Headers.Add("Accept", "application/json, text/plain, */*");
                request.Headers.Add("Accept-Language", "zh-CN,zh;q=0.9");
                request.Headers.Add("Origin", "https://www.tapd.cn");
                request.Headers.Add("Referer", $"https://www.tapd.cn/tapd_fe/{workspaceId}/bug/detail/{entityId}");
                request.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36");
                request.Headers.Add("Sec-Fetch-Dest", "empty");
                request.Headers.Add("Sec-Fetch-Mode", "cors");
                request.Headers.Add("Sec-Fetch-Site", "same-origin");
                request.Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json");

                var response = await client.SendAsync(request, CancellationToken.None);
                var respBody = await response.Content.ReadAsStringAsync(CancellationToken.None);

                // 首条记录记录详细请求/响应信息，用于调试
                if (i == 0)
                {
                    logs.AppendLine($"  [DEBUG] First request URL: {detailUrl}");
                    logs.AppendLine($"  [DEBUG] HTTP Status: {(int)response.StatusCode}");
                    logs.AppendLine($"  [DEBUG] Response length: {respBody.Length} chars");
                    logs.AppendLine($"  [DEBUG] Response preview: {respBody[..Math.Min(500, respBody.Length)]}");
                }

                if (!response.IsSuccessStatusCode)
                {
                    logs.AppendLine($"  [{i + 1}/{bugIds.Count}] {entityId}: HTTP {(int)response.StatusCode} failed, body={respBody[..Math.Min(200, respBody.Length)]}");
                    // 保留原始搜索数据，映射为中文字段名以保持一致
                    detailItems.Add(MapSearchItemToChinese(searchItems[i]!, workspaceId));
                    continue;
                }

                using var doc = JsonDocument.Parse(respBody);
                var root = doc.RootElement;

                // 解析 data.get_info_ret.data.Bug
                if (root.TryGetProperty("data", out var dataEl) &&
                    dataEl.TryGetProperty("get_info_ret", out var retEl) &&
                    retEl.TryGetProperty("data", out var retDataEl) &&
                    retDataEl.TryGetProperty("Bug", out var bugEl))
                {
                    // copy_info 可能在 data 层级下，也可能在 get_info_ret 下
                    var copyUrl = "";
                    if (dataEl.TryGetProperty("copy_info", out var copyEl) &&
                        copyEl.TryGetProperty("url", out var urlEl))
                        copyUrl = urlEl.GetString() ?? "";
                    // 备选路径：get_info_ret.copy_info
                    if (string.IsNullOrWhiteSpace(copyUrl) &&
                        retEl.TryGetProperty("copy_info", out var copyEl2) &&
                        copyEl2.TryGetProperty("url", out var urlEl2))
                        copyUrl = urlEl2.GetString() ?? "";

                    // 提取并映射为中文字段名（首条记录带 debug 日志）
                    var mapped = MapBugFieldsToChinese(bugEl, copyUrl, workspaceId, i == 0 ? logs : null);
                    detailItems.Add(mapped);
                    successCount++;
                }
                else
                {
                    // 记录响应结构帮助调试
                    var keys = new List<string>();
                    if (root.TryGetProperty("data", out var dEl2))
                    {
                        foreach (var prop in dEl2.EnumerateObject())
                            keys.Add(prop.Name);
                    }
                    logs.AppendLine($"  [{i + 1}/{bugIds.Count}] {entityId}: unexpected structure, data keys=[{string.Join(",", keys)}]");
                    logs.AppendLine($"    Response preview: {respBody[..Math.Min(300, respBody.Length)]}");
                    // 保留原始搜索数据，映射为中文字段名以保持一致
                    detailItems.Add(MapSearchItemToChinese(searchItems[i]!, workspaceId));
                }
            }
            catch (Exception ex)
            {
                logs.AppendLine($"  [{i + 1}/{bugIds.Count}] {entityId}: error - {ex.Message}");
                // 保留原始搜索数据，映射为中文字段名以保持一致
                detailItems.Add(MapSearchItemToChinese(searchItems[i]!, workspaceId));
            }

            // 进度日志（每 10 条记录一次）
            if ((i + 1) % 10 == 0 || i == bugIds.Count - 1)
                logs.AppendLine($"  [{i + 1}/{bugIds.Count}] progress: {successCount} success, {detailItems.Count - successCount} fallback");

            // 避免请求过快
            if (i < bugIds.Count - 1)
                await Task.Delay(300, CancellationToken.None);
        }

        logs.AppendLine($"Phase 2 done: {successCount}/{bugIds.Count} details fetched, {detailItems.Count} total items");
        return detailItems;
    }

    /// <summary>
    /// 将 common_get_info 返回的 Bug JSON 字段映射为中文字段名，
    /// 同时计算"是否历史问题"和"及时处理"衍生字段。
    /// </summary>
    private static JsonNode MapBugFieldsToChinese(JsonElement bug, string copyUrl, string workspaceId = "", StringBuilder? logs = null)
    {
        // 通用取值：支持 String / Number / True / False，Null 和不存在返回空串
        string Get(string key)
        {
            if (!bug.TryGetProperty(key, out var el)) return "";
            return el.ValueKind switch
            {
                JsonValueKind.String => el.GetString() ?? "",
                JsonValueKind.Number => el.GetRawText(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Null => "",
                _ => el.GetRawText(), // Object / Array → 原始 JSON 文本
            };
        }

        // 调试日志：记录 Bug 对象的所有字段名（仅首次调用时记录）
        if (logs != null)
        {
            var fieldNames = new List<string>();
            foreach (var prop in bug.EnumerateObject())
                fieldNames.Add(prop.Name);
            logs.AppendLine($"  [DEBUG] Bug fields ({fieldNames.Count}): {string.Join(", ", fieldNames.Take(40))}");
            // 打印自定义字段的实际值，方便调试空值问题
            logs.AppendLine($"  [DEBUG] custom_field_one={Get("custom_field_one")} | custom_field_11={Get("custom_field_11")} | custom_field_13={Get("custom_field_13")}");
        }

        var resolved = Get("resolved");
        var due = Get("due");
        var customField100 = Get("custom_field_100"); // 问题开始时间

        // 计算"是否历史问题"：问题开始时间距解决时间 ≥ 6 个月
        var isHistorical = "否";
        if (!string.IsNullOrWhiteSpace(customField100) && !string.IsNullOrWhiteSpace(resolved))
        {
            if (DateTime.TryParse(customField100, out var startDt) && DateTime.TryParse(resolved, out var resolvedDt))
            {
                var monthsDiff = (resolvedDt.Year - startDt.Year) * 12 + (resolvedDt.Month - startDt.Month);
                if (monthsDiff >= 6) isHistorical = "是";
            }
        }

        // 计算"及时处理"：预计结束时间 ≥ 解决时间（只比较日期）
        var timelyFixed = "无法判断";
        if (!string.IsNullOrWhiteSpace(due) && !string.IsNullOrWhiteSpace(resolved))
        {
            if (DateTime.TryParse(due, out var dueDt) && DateTime.TryParse(resolved, out var resolvedDt))
                timelyFixed = dueDt.Date >= resolvedDt.Date ? "是" : "否";
        }

        // TAPD API 中 Bug 的 id 字段可能是 "id" 或 "ID"（大小写不一致）
        var bugIdValue = Get("id");
        if (string.IsNullOrEmpty(bugIdValue)) bugIdValue = Get("ID");
        if (string.IsNullOrEmpty(bugIdValue)) bugIdValue = Get("bug_id");

        // URL链接：优先使用 copy_info.url，如果为空则从 workspaceId + bugId 构造
        var finalUrl = copyUrl;
        if (string.IsNullOrWhiteSpace(finalUrl) && !string.IsNullOrWhiteSpace(workspaceId) && !string.IsNullOrWhiteSpace(bugIdValue))
            finalUrl = $"https://www.tapd.cn/tapd_fe/{workspaceId}/bug/detail/{bugIdValue}";

        // 从 description 字段中提取外部链接（如语雀溯源报告链接）
        var descriptionRaw = Get("description");
        var descriptionLinks = ExtractUrlsFromHtmlOrText(descriptionRaw);

        if (logs != null && descriptionLinks.Count > 0)
            logs.AppendLine($"  [DEBUG] 描述中提取到 {descriptionLinks.Count} 个链接: {string.Join(", ", descriptionLinks.Take(3))}");

        var result = new JsonObject
        {
            ["缺陷ID"] = bugIdValue,
            ["标题"] = Get("title"),
            ["创建人"] = Get("reporter"),
            ["创建时间"] = Get("created"),
            ["问题开始时间"] = customField100,
            ["解决时间"] = resolved,
            ["关闭时间"] = Get("closed"),
            ["预计结束时间"] = due,
            ["处理人"] = Get("current_owner"),
            ["状态"] = Get("status"),
            ["责任人"] = Get("custom_field_two"),
            ["是否逾期"] = Get("custom_field_four"),
            ["有效报告"] = Get("custom_field_five"),
            ["缺陷等级"] = Get("custom_field_6"),
            ["缺陷划分"] = Get("custom_field_7"),
            ["反馈人"] = Get("custom_field_8"),
            ["公司名称"] = Get("custom_field_9"),
            ["商户编号"] = Get("custom_field_10"),
            ["引入项目"] = Get("custom_field_11"),
            ["反馈时间"] = Get("custom_field_12"),
            ["影响范围"] = Get("custom_field_13"),
            ["结构归母"] = Get("custom_field_one"),
            ["URL链接"] = finalUrl,
            ["描述中的链接"] = descriptionLinks.Count > 0 ? string.Join(" | ", descriptionLinks) : "",
            ["是否历史问题"] = isHistorical,
            ["及时处理"] = timelyFixed,
        };
        return result;
    }

    /// <summary>
    /// 将 Phase 1 搜索列表的原始 item（JSON 字段名不统一）映射为与 MapBugFieldsToChinese 一致的中文字段名，
    /// 这样在 Phase 2 部分失败回退时，输出的列结构与成功项保持一致，前端表格不会出现空列。
    /// </summary>
    private static JsonNode MapSearchItemToChinese(JsonNode item, string workspaceId)
    {
        string Get(string key) => item[key]?.GetValue<string>() ?? "";

        var bugIdValue = Get("id");
        if (string.IsNullOrEmpty(bugIdValue)) bugIdValue = Get("ID");
        if (string.IsNullOrEmpty(bugIdValue)) bugIdValue = Get("bug_id");

        var url = "";
        if (!string.IsNullOrWhiteSpace(workspaceId) && !string.IsNullOrWhiteSpace(bugIdValue))
            url = $"https://www.tapd.cn/tapd_fe/{workspaceId}/bug/detail/{bugIdValue}";

        // Phase 1 搜索结果中也可能包含 description 字段
        var descriptionLinks = ExtractUrlsFromHtmlOrText(Get("description"));

        return new JsonObject
        {
            ["缺陷ID"] = bugIdValue,
            ["标题"] = Get("title"),
            ["创建人"] = Get("reporter"),
            ["创建时间"] = Get("created"),
            ["问题开始时间"] = Get("custom_field_100"),
            ["解决时间"] = Get("resolved"),
            ["关闭时间"] = Get("closed"),
            ["预计结束时间"] = Get("due"),
            ["处理人"] = Get("current_owner"),
            ["状态"] = Get("status"),
            ["责任人"] = Get("custom_field_two"),
            ["是否逾期"] = Get("custom_field_four"),
            ["有效报告"] = Get("custom_field_five"),
            ["缺陷等级"] = Get("custom_field_6"),
            ["缺陷划分"] = Get("custom_field_7"),
            ["反馈人"] = Get("custom_field_8"),
            ["公司名称"] = Get("custom_field_9"),
            ["商户编号"] = Get("custom_field_10"),
            ["引入项目"] = Get("custom_field_11"),
            ["反馈时间"] = Get("custom_field_12"),
            ["影响范围"] = Get("custom_field_13"),
            ["结构归母"] = Get("custom_field_one"),
            ["URL链接"] = url,
            ["描述中的链接"] = descriptionLinks.Count > 0 ? string.Join(" | ", descriptionLinks) : "",
            ["是否历史问题"] = "",
            ["及时处理"] = "",
        };
    }

    /// <summary>自定义 cURL 兜底模式：解析用户粘贴的 cURL 命令并直接执行，支持自动分页</summary>
    private static async Task<CapsuleResult> ExecuteCustomCurlAsync(
        IHttpClientFactory factory, WorkflowNode node, string curlCommand, string dataType)
    {
        var logs = new StringBuilder();
        logs.AppendLine("Custom cURL mode: parsing user-provided curl command");

        // 解析 cURL
        var parsed = ParseCurlCommand(curlCommand);
        if (string.IsNullOrWhiteSpace(parsed.Url))
            throw new InvalidOperationException("无法从 cURL 命令中解析出 URL。请检查格式是否正确。");

        logs.AppendLine($"URL: {parsed.Url}");
        logs.AppendLine($"Method: {parsed.Method}");
        logs.AppendLine($"Headers: {parsed.Headers.Count} 个");
        logs.AppendLine($"Body: {(string.IsNullOrEmpty(parsed.Body) ? "(无)" : $"{parsed.Body.Length} chars")}");

        var allItems = new JsonArray();
        var page = 1;
        var maxPages = 50;
        var totalCount = 0;

        while (page <= maxPages)
        {
            using var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            var request = new HttpRequestMessage(
                parsed.Method.Equals("POST", StringComparison.OrdinalIgnoreCase) ? HttpMethod.Post :
                parsed.Method.Equals("PUT", StringComparison.OrdinalIgnoreCase) ? HttpMethod.Put :
                parsed.Method.Equals("DELETE", StringComparison.OrdinalIgnoreCase) ? HttpMethod.Delete :
                HttpMethod.Get,
                parsed.Url);

            // 添加解析出的请求头
            foreach (var (key, value) in parsed.Headers)
            {
                // Content-Type 需要通过 Content 设置，跳过
                if (key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) continue;
                try { request.Headers.TryAddWithoutValidation(key, value); }
                catch { /* 忽略无法添加的头 */ }
            }

            // 设置请求体（如果有），支持分页替换
            if (!string.IsNullOrEmpty(parsed.Body))
            {
                var bodyToSend = parsed.Body;
                // 尝试修改 body 中的 page 参数以支持分页
                if (page > 1)
                {
                    try
                    {
                        var bodyNode = JsonNode.Parse(bodyToSend);
                        if (bodyNode is JsonObject bodyObj && bodyObj.ContainsKey("page"))
                        {
                            bodyObj["page"] = page;
                            bodyToSend = bodyObj.ToJsonString();
                        }
                    }
                    catch { /* body 非 JSON 或没有 page 字段，保持原样 */ }
                }

                var contentType = parsed.Headers
                    .FirstOrDefault(h => h.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)).Value
                    ?? "application/json";
                request.Content = new StringContent(bodyToSend, Encoding.UTF8, contentType);
            }

            var response = await client.SendAsync(request, CancellationToken.None);
            var body = await response.Content.ReadAsStringAsync(CancellationToken.None);

            logs.AppendLine($"Page {page}: HTTP {(int)response.StatusCode}");

            if (!response.IsSuccessStatusCode)
            {
                logs.AppendLine($"Page {page}: request failed - {body[..Math.Min(300, body.Length)]}");
                if (page == 1)
                    throw new InvalidOperationException($"自定义 cURL 请求失败: HTTP {(int)response.StatusCode}。响应: {body[..Math.Min(500, body.Length)]}");
                break;
            }

            // 检测非 JSON 响应
            var trimmedBody = body.TrimStart();
            if (trimmedBody.Length == 0 || (trimmedBody[0] != '{' && trimmedBody[0] != '['))
            {
                logs.AppendLine($"Page {page}: 非 JSON 响应（可能 Cookie 已过期）");
                if (page == 1)
                    throw new InvalidOperationException("cURL 请求返回了非 JSON 响应，可能 Cookie 已过期。请重新从浏览器复制最新的 cURL 命令。");
                break;
            }

            // 解析响应 — 兼容多种 TAPD 响应格式
            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;

                if (root.TryGetProperty("data", out var dataEl) &&
                    dataEl.ValueKind == JsonValueKind.Object &&
                    dataEl.TryGetProperty("list", out var listEl) &&
                    listEl.ValueKind == JsonValueKind.Array)
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

                    // 如果 body 里没有 page 字段，无法分页，直接结束
                    if (!string.IsNullOrEmpty(parsed.Body))
                    {
                        try
                        {
                            var bodyCheck = JsonNode.Parse(parsed.Body);
                            if (bodyCheck is not JsonObject obj || !obj.ContainsKey("page"))
                            {
                                logs.AppendLine("Body 中无 page 字段，无法自动分页，仅返回首页数据");
                                break;
                            }
                        }
                        catch { break; }
                    }
                    else
                    {
                        logs.AppendLine("无请求体，无法自动分页");
                        break;
                    }
                }
                else
                {
                    // 非标准格式 — 对于首页尝试返回整个响应
                    if (page == 1)
                    {
                        logs.AppendLine("Response is not standard TAPD format (no data.list), returning raw response");
                        var rawArtifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType}", body, "application/json");
                        return new CapsuleResult(new List<ExecutionArtifact> { rawArtifact }, logs.ToString());
                    }
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
                await Task.Delay(500, CancellationToken.None);
        }

        logs.AppendLine($"Done: {allItems.Count} total items collected across {page - 1} pages");

        if (allItems.Count == 0)
            throw new InvalidOperationException("自定义 cURL 采集到 0 条数据。请检查 cURL 命令是否有效、Cookie 是否过期。");

        // ── 阶段二：对 bugs 类型调用 common_get_info 获取详情 ──
        var fetchDetail = GetConfigString(node, "fetchDetail") ?? "true";
        if (fetchDetail == "true" && dataType is "bugs" or "bug")
        {
            // 从 cURL headers 中提取 Cookie 和 dsc-token
            var cookieStr = parsed.Headers
                .FirstOrDefault(h => h.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase)).Value ?? "";
            var dscToken = "";
            if (!string.IsNullOrWhiteSpace(cookieStr))
            {
                var match = System.Text.RegularExpressions.Regex.Match(cookieStr, @"dsc-token=([^;\s]+)");
                if (match.Success) dscToken = match.Groups[1].Value;
            }

            // 从 cURL body 中提取 workspace_id（如果 allItems 里没有 workspace_id 字段）
            var wsId = GetConfigString(node, "workspaceId") ?? GetConfigString(node, "workspace_id") ?? "";
            if (string.IsNullOrWhiteSpace(wsId) && !string.IsNullOrEmpty(parsed.Body))
            {
                try
                {
                    var bodyNode = JsonNode.Parse(parsed.Body);
                    wsId = bodyNode?["workspace_id"]?.GetValue<string>() ?? "";
                }
                catch { /* ignore */ }
            }
            // 尝试从搜索结果中获取 workspace_id
            if (string.IsNullOrWhiteSpace(wsId) && allItems.Count > 0)
            {
                wsId = allItems[0]?["workspace_id"]?.GetValue<string>()
                    ?? allItems[0]?["project_id"]?.GetValue<string>() ?? "";
            }

            if (!string.IsNullOrWhiteSpace(cookieStr) && !string.IsNullOrWhiteSpace(wsId))
            {
                logs.AppendLine($"Phase 2: will fetch bug details via common_get_info (workspace={wsId})");
                var detailItems = await FetchTapdBugDetailsAsync(factory, allItems, wsId, cookieStr, dscToken, logs);
                if (detailItems.Count > 0)
                {
                    var detailJson = detailItems.ToJsonString(JsonCompact);
                    var detailArtifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType} 详情", detailJson, "application/json");
                    return new CapsuleResult(new List<ExecutionArtifact> { detailArtifact }, logs.ToString());
                }
                logs.AppendLine("⚠️ Phase 2 全部失败，回退使用搜索列表数据");
            }
            else
            {
                logs.AppendLine($"⚠️ Phase 2 skipped: cookie={(!string.IsNullOrWhiteSpace(cookieStr) ? "yes" : "no")}, workspaceId={(!string.IsNullOrWhiteSpace(wsId) ? wsId : "missing")}");
            }
        }

        var resultJson = allItems.ToJsonString(JsonCompact);
        var artifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType}", resultJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
    }

    /// <summary>解析 cURL 命令，提取 URL、Method、Headers、Body</summary>
    private static (string Url, string Method, List<KeyValuePair<string, string>> Headers, string? Body) ParseCurlCommand(string curl)
    {
        var url = "";
        var method = "GET";
        var headers = new List<KeyValuePair<string, string>>();
        string? body = null;

        // 移除换行续行符
        curl = curl.Replace("\\\n", " ").Replace("\\\r\n", " ").Replace("\r\n", " ").Replace("\n", " ").Trim();

        // 去掉开头的 curl
        if (curl.StartsWith("curl ", StringComparison.OrdinalIgnoreCase))
            curl = curl[5..].TrimStart();

        var tokens = TokenizeCurl(curl);

        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];

            if (token is "-X" or "--request")
            {
                if (i + 1 < tokens.Count) method = tokens[++i].ToUpperInvariant();
            }
            else if (token is "-H" or "--header")
            {
                if (i + 1 < tokens.Count)
                {
                    var headerStr = tokens[++i];
                    var colonIdx = headerStr.IndexOf(':');
                    if (colonIdx > 0)
                    {
                        var key = headerStr[..colonIdx].Trim();
                        var value = headerStr[(colonIdx + 1)..].Trim();
                        headers.Add(new KeyValuePair<string, string>(key, value));
                    }
                }
            }
            else if (token is "-d" or "--data" or "--data-raw" or "--data-binary" or "--data-urlencode")
            {
                if (i + 1 < tokens.Count)
                {
                    body = tokens[++i];
                    if (method == "GET") method = "POST"; // curl 默认 -d 时用 POST
                }
            }
            else if (token is "--compressed" or "--insecure" or "-k" or "-s" or "--silent" or "-v" or "--verbose" or "-L" or "--location")
            {
                // 忽略这些标志
            }
            else if (!token.StartsWith('-') && string.IsNullOrEmpty(url))
            {
                // 第一个非标志参数是 URL
                url = token;
            }
        }

        return (url, method, headers, body);
    }

    /// <summary>将 cURL 命令字符串分词（处理单引号、双引号、转义）</summary>
    private static List<string> TokenizeCurl(string input)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        var inSingleQuote = false;
        var inDoubleQuote = false;
        var escape = false;

        for (var i = 0; i < input.Length; i++)
        {
            var c = input[i];

            if (escape)
            {
                current.Append(c);
                escape = false;
                continue;
            }

            if (c == '\\' && !inSingleQuote)
            {
                escape = true;
                continue;
            }

            if (c == '\'' && !inDoubleQuote)
            {
                inSingleQuote = !inSingleQuote;
                continue;
            }

            if (c == '"' && !inSingleQuote)
            {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }

            if (c == ' ' && !inSingleQuote && !inDoubleQuote)
            {
                if (current.Length > 0)
                {
                    tokens.Add(current.ToString());
                    current.Clear();
                }
                continue;
            }

            current.Append(c);
        }

        if (current.Length > 0)
            tokens.Add(current.ToString());

        return tokens;
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
            merged = JsonSerializer.Serialize(items, JsonCompact);
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
        // 检查是否为 TAPD 28 维度专用聚合模式
        var aggregationType = GetConfigString(node, "aggregationType") ?? "";
        if (aggregationType == "tapd-bug-28d")
            return ExecuteTapdBug28DAggregation(node, inputArtifacts);

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
            var emptyResult = JsonSerializer.Serialize(new { totalCount = 0, message = "无数据" }, JsonCompact);
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

        var outputJson = JsonSerializer.Serialize(result, JsonPretty);
        logs.AppendLine($"  输出统计摘要: {outputJson.Length} chars ({Encoding.UTF8.GetByteCount(outputJson)} bytes)");

        var artifact = MakeTextArtifact(node, "agg-out", "统计摘要", outputJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
    }

    // ── TAPD 缺陷 28 维度预统计 ─────────────────────────────────

    /// <summary>
    /// TAPD 缺陷 28 维度专用聚合：用代码精确计算所有统计指标和缺陷 ID 列表，
    /// 输出结构化 JSON 摘要（~5-15KB），替代将原始数据（~200KB+）直接喂给 LLM 让其"数数"。
    /// </summary>
    private static CapsuleResult ExecuteTapdBug28DAggregation(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var logs = new StringBuilder();
        logs.AppendLine($"[TAPD 28维度预统计] 节点: {node.Name}");

        // ── 解析输入数据 ──
        var allItems = new List<Dictionary<string, string>>();
        foreach (var art in inputArtifacts)
        {
            if (string.IsNullOrWhiteSpace(art.InlineContent)) continue;
            try
            {
                using var doc = JsonDocument.Parse(art.InlineContent);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in doc.RootElement.EnumerateArray())
                        allItems.Add(JsonElementToDict(item));
                }
                else if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    allItems.Add(JsonElementToDict(doc.RootElement));
                }
            }
            catch { logs.AppendLine($"  ⚠️ 跳过无法解析的输入: {art.Name}"); }
        }

        logs.AppendLine($"  总记录数: {allItems.Count}");

        if (allItems.Count == 0)
        {
            var emptyJson = JsonSerializer.Serialize(new { totalCount = 0, message = "无数据", dimensions = Array.Empty<object>() }, JsonCompact);
            var emptyArt = MakeTextArtifact(node, "agg-out", "TAPD 28维度统计", emptyJson, "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { emptyArt }, logs.ToString());
        }

        // 字段取值辅助
        string Get(Dictionary<string, string> item, string field) =>
            item.TryGetValue(field, out var v) ? (v ?? "") : "";

        // ── 构建子集 ──
        var all = allItems;
        var techBugs = all.Where(i => Get(i, "缺陷划分") == "技术缺陷").ToList();
        var p2Below = techBugs.Where(i =>
        {
            var level = Get(i, "缺陷等级").ToUpperInvariant();
            return level is "P2" or "P3" or "P4";
        }).ToList();

        // 辅助：提取缺陷 ID 列表
        List<string> Ids(List<Dictionary<string, string>> items) =>
            items.Select(i => Get(i, "缺陷ID")).Where(id => !string.IsNullOrWhiteSpace(id)).ToList();

        // 辅助：提取缺陷明细列表（用于报告中展示具体问题）
        List<object> Details(List<Dictionary<string, string>> items) =>
            items.Select(i => (object)new Dictionary<string, string>
            {
                ["缺陷ID"] = Get(i, "缺陷ID"),
                ["标题"] = Get(i, "标题"),
                ["URL链接"] = Get(i, "URL链接"),
                ["描述中的链接"] = Get(i, "描述中的链接"),
                ["处理人"] = Get(i, "处理人"),
                ["创建人"] = Get(i, "创建人"),
                ["状态"] = Get(i, "状态"),
                ["缺陷等级"] = Get(i, "缺陷等级"),
                ["结构归母"] = Get(i, "结构归母"),
            }).ToList();

        // 辅助：构建一个维度对象
        object Dim(int num, string name, int count, List<string> ids, string? logic = null, string? extra = null)
        {
            var d = new Dictionary<string, object>
            {
                ["dim"] = num,
                ["name"] = name,
                ["count"] = count,
                ["ids"] = ids,
            };
            if (logic != null) d["logic"] = logic;
            if (extra != null) d["extra"] = extra;
            return d;
        }

        // 辅助：构建带明细的维度对象
        object DimWithDetails(int num, string name, int count, List<string> ids,
            List<object> details, string? logic = null, string? extra = null)
        {
            var d = new Dictionary<string, object>
            {
                ["dim"] = num,
                ["name"] = name,
                ["count"] = count,
                ["ids"] = ids,
                ["details"] = details,
            };
            if (logic != null) d["logic"] = logic;
            if (extra != null) d["extra"] = extra;
            return d;
        }

        // ── 28 维度计算 ──
        var dimensions = new List<object>();

        // 1. 缺陷总数
        dimensions.Add(Dim(1, "缺陷总数", all.Count, Ids(all)));

        // 2. 非缺陷数量
        var nonBugs = all.Where(i => Get(i, "缺陷划分") == "非缺陷").ToList();
        dimensions.Add(Dim(2, "非缺陷数量", nonBugs.Count, Ids(nonBugs), "缺陷划分=\"非缺陷\""));

        // 3. 产品缺陷数量
        var productBugs = all.Where(i => Get(i, "缺陷划分") == "产品缺陷").ToList();
        dimensions.Add(Dim(3, "产品缺陷数量", productBugs.Count, Ids(productBugs), "缺陷划分=\"产品缺陷\""));

        // 4. 技术缺陷数量
        dimensions.Add(Dim(4, "技术缺陷数量", techBugs.Count, Ids(techBugs), "缺陷划分=\"技术缺陷\""));

        // 5. 无法判断数量
        var indeterminate = all.Where(i => Get(i, "缺陷划分") == "无法判断").ToList();
        dimensions.Add(Dim(5, "无法判断的数量", indeterminate.Count, Ids(indeterminate), "缺陷划分=\"无法判断\""));

        // 6. 未判断（空）的数量
        var unclassified = all.Where(i => string.IsNullOrWhiteSpace(Get(i, "缺陷划分"))).ToList();
        dimensions.Add(Dim(6, "未判断（空）的数量", unclassified.Count, Ids(unclassified), "缺陷划分为空"));

        // 7. 无效反馈数量
        var invalidFeedback = all.Where(i => Get(i, "有效报告") == "否").ToList();
        dimensions.Add(Dim(7, "无效反馈数量", invalidFeedback.Count, Ids(invalidFeedback), "有效报告=\"否\""));

        // 8. 有效反馈数量
        var validFeedback = all.Where(i => Get(i, "有效报告") == "是").ToList();
        dimensions.Add(Dim(8, "有效反馈数量", validFeedback.Count, Ids(validFeedback), "有效报告=\"是\""));

        // 9. P2级及以下技术缺陷
        dimensions.Add(Dim(9, "P2级及以下技术缺陷数量", p2Below.Count, Ids(p2Below),
            "缺陷划分=\"技术缺陷\" 且 缺陷等级∈{P2,P3,P4}"));

        // 10-15. 各等级技术缺陷（P0/P1 附带明细，便于报告展示）
        var severityLevels = new[] { ("P0", 10), ("P1", 11), ("P2", 12), ("P3", 13), ("P4", 14) };
        foreach (var (level, dimNum) in severityLevels)
        {
            var subset = techBugs.Where(i => Get(i, "缺陷等级").Equals(level, StringComparison.OrdinalIgnoreCase)).ToList();
            if (level is "P0" or "P1")
            {
                dimensions.Add(DimWithDetails(dimNum, $"{level}级别技术缺陷数量", subset.Count, Ids(subset),
                    Details(subset), $"缺陷划分=\"技术缺陷\" 且 缺陷等级=\"{level}\""));
            }
            else
            {
                dimensions.Add(Dim(dimNum, $"{level}级别技术缺陷数量", subset.Count, Ids(subset),
                    $"缺陷划分=\"技术缺陷\" 且 缺陷等级=\"{level}\""));
            }
        }

        var techNoLevel = techBugs.Where(i => string.IsNullOrWhiteSpace(Get(i, "缺陷等级"))).ToList();
        dimensions.Add(Dim(15, "未判断缺陷等级技术缺陷数量", techNoLevel.Count, Ids(techNoLevel),
            "缺陷划分=\"技术缺陷\" 且 缺陷等级为空"));

        // 16. 等级统计验证
        var levelSum = severityLevels.Sum(sl =>
            techBugs.Count(i => Get(i, "缺陷等级").Equals(sl.Item1, StringComparison.OrdinalIgnoreCase)))
            + techNoLevel.Count;
        var levelValid = levelSum == techBugs.Count;
        dimensions.Add(Dim(16, "技术缺陷等级统计总和验证", levelSum, new List<string>(),
            $"P0+P1+P2+P3+P4+未判断={levelSum}，技术缺陷总数={techBugs.Count}",
            levelValid ? "✅ 一致" : $"❌ 差异={techBugs.Count - levelSum}"));

        // 17-19. P2 及以下逾期状态
        var p2Overdue = p2Below.Where(i => Get(i, "是否逾期") == "是").ToList();
        dimensions.Add(Dim(17, "P2及以下技术缺陷中简报逾期数量", p2Overdue.Count, Ids(p2Overdue),
            "P2及以下技术缺陷中 是否逾期=\"是\""));

        var p2NotOverdue = p2Below.Where(i => Get(i, "是否逾期") == "否").ToList();
        dimensions.Add(Dim(18, "P2及以下技术缺陷中未逾期数量", p2NotOverdue.Count, Ids(p2NotOverdue),
            "P2及以下技术缺陷中 是否逾期=\"否\""));

        var p2OverdueEmpty = p2Below.Where(i => string.IsNullOrWhiteSpace(Get(i, "是否逾期"))).ToList();
        dimensions.Add(Dim(19, "P2及以下技术缺陷中逾期状态为空数量", p2OverdueEmpty.Count, Ids(p2OverdueEmpty),
            "P2及以下技术缺陷中 是否逾期为空"));

        // 20. 逾期验证
        var overdueSum = p2Overdue.Count + p2NotOverdue.Count + p2OverdueEmpty.Count;
        var overdueValid = overdueSum == p2Below.Count;
        dimensions.Add(Dim(20, "P2及以下技术缺陷逾期统计验证", overdueSum, new List<string>(),
            $"逾期+未逾期+空={overdueSum}，P2及以下总数={p2Below.Count}",
            overdueValid ? "✅ 一致" : $"❌ 差异={p2Below.Count - overdueSum}"));

        // 21-23. P2 及以下及时处理
        var p2Timely = p2Below.Where(i => Get(i, "及时处理") == "是").ToList();
        dimensions.Add(Dim(21, "P2及以下技术缺陷中及时处理数量", p2Timely.Count, Ids(p2Timely),
            "P2及以下技术缺陷中 及时处理=\"是\""));

        var p2NotTimely = p2Below.Where(i => Get(i, "及时处理") == "否").ToList();
        dimensions.Add(DimWithDetails(22, "P2及以下技术缺陷中未及时处理数量", p2NotTimely.Count, Ids(p2NotTimely),
            Details(p2NotTimely), "P2及以下技术缺陷中 及时处理=\"否\""));

        var p2TimelyUnknown = p2Below.Where(i =>
        {
            var v = Get(i, "及时处理");
            return v == "无法判断" || string.IsNullOrWhiteSpace(v);
        }).ToList();
        dimensions.Add(Dim(23, "P2及以下技术缺陷中无法判断是否及时处理数量", p2TimelyUnknown.Count, Ids(p2TimelyUnknown),
            "P2及以下技术缺陷中 及时处理=\"无法判断\"或为空"));

        // 24. 及时处理验证
        var timelySum = p2Timely.Count + p2NotTimely.Count + p2TimelyUnknown.Count;
        var timelyValid = timelySum == p2Below.Count;
        dimensions.Add(Dim(24, "P2及以下技术缺陷及时处理统计验证", timelySum, new List<string>(),
            $"及时+未及时+无法判断={timelySum}，P2及以下总数={p2Below.Count}",
            timelyValid ? "✅ 一致" : $"❌ 差异={p2Below.Count - timelySum}"));

        // 25. 已修复数量
        var closedStatuses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "closed", "已关闭", "已解决", "关闭" };
        var p2Fixed = p2Below.Where(i => closedStatuses.Contains(Get(i, "状态"))).ToList();
        dimensions.Add(Dim(25, "P2及以下技术缺陷中已修复数量", p2Fixed.Count, Ids(p2Fixed),
            "P2及以下技术缺陷中 状态∈{closed,已关闭,已解决,关闭}"));

        // 26. 及时修复率
        var fixRate = p2Below.Count > 0 ? Math.Round(100.0 * p2Fixed.Count / p2Below.Count, 2) : 0;
        var fixRating = fixRate >= 90 ? "优秀" : fixRate >= 80 ? "良好" : fixRate >= 70 ? "一般" : fixRate >= 60 ? "需改进" : "较差";
        dimensions.Add(Dim(26, "P2及以下技术缺陷及时修复率", p2Fixed.Count, new List<string>(),
            $"{p2Fixed.Count}/{p2Below.Count}×100%={fixRate}%",
            $"比率={fixRate}%，评级={fixRating}"));

        // 27. 及时处理率
        var processRate = p2Below.Count > 0 ? Math.Round(100.0 * p2Timely.Count / p2Below.Count, 2) : 0;
        var processRating = processRate >= 90 ? "优秀" : processRate >= 80 ? "良好" : processRate >= 70 ? "一般" : processRate >= 60 ? "需改进" : "较差";
        dimensions.Add(Dim(27, "P2及以下技术缺陷及时处理率", p2Timely.Count, new List<string>(),
            $"{p2Timely.Count}/{p2Below.Count}×100%={processRate}%",
            $"比率={processRate}%，评级={processRating}"));

        // 28. 结构归母统计（含每个类别的缺陷明细，便于开会选取代表性案例分析）
        var structureGroups = techBugs
            .GroupBy(i =>
            {
                var v = Get(i, "结构归母");
                return string.IsNullOrWhiteSpace(v) ? "暂未归母" : v;
            })
            .OrderByDescending(g => g.Count())
            .Select(g => new Dictionary<string, object>
            {
                ["category"] = g.Key,
                ["count"] = g.Count(),
                ["ids"] = g.Select(i => Get(i, "缺陷ID")).Where(id => !string.IsNullOrWhiteSpace(id)).ToList(),
                ["details"] = g.Select(i => (object)new Dictionary<string, string>
                {
                    ["缺陷ID"] = Get(i, "缺陷ID"),
                    ["标题"] = Get(i, "标题"),
                    ["URL链接"] = Get(i, "URL链接"),
                    ["描述中的链接"] = Get(i, "描述中的链接"),
                    ["处理人"] = Get(i, "处理人"),
                    ["创建人"] = Get(i, "创建人"),
                    ["缺陷等级"] = Get(i, "缺陷等级"),
                    ["状态"] = Get(i, "状态"),
                }).ToList(),
            })
            .ToList();
        dimensions.Add(new Dictionary<string, object>
        {
            ["dim"] = 28,
            ["name"] = "技术缺陷结构归母统计",
            ["logic"] = "按结构归母分组统计技术缺陷，每个归母类别附带缺陷明细列表",
            ["groups"] = structureGroups,
            ["totalTechBugs"] = techBugs.Count,
        });

        // 29. 挂起状态的缺陷（含明细）
        var suspendedBugs = all.Where(i =>
        {
            var status = Get(i, "状态");
            return status.Contains("挂起") || status.Equals("suspended", StringComparison.OrdinalIgnoreCase);
        }).ToList();
        dimensions.Add(DimWithDetails(29, "挂起状态缺陷", suspendedBugs.Count, Ids(suspendedBugs),
            Details(suspendedBugs), "状态包含\"挂起\""));

        // 30. 临时解决的缺陷（含明细）
        var tempFixBugs = all.Where(i =>
        {
            var status = Get(i, "状态");
            return status.Contains("临时解决") || status.Contains("workaround");
        }).ToList();
        dimensions.Add(DimWithDetails(30, "临时解决缺陷", tempFixBugs.Count, Ids(tempFixBugs),
            Details(tempFixBugs), "状态包含\"临时解决\""));

        // ── 组装输出 ──
        var output = new Dictionary<string, object>
        {
            ["_meta"] = new
            {
                aggregationType = "tapd-bug-28d",
                totalRecords = all.Count,
                generatedAt = DateTime.UtcNow.ToString("O"),
                note = "所有统计由代码精确计算，非 LLM 估算。dim 10/11/22/28/29/30 含 details 明细列表",
            },
            ["dimensions"] = dimensions,
        };

        var outputJson = JsonSerializer.Serialize(output, JsonPretty);
        logs.AppendLine($"  30 维度统计完成");
        logs.AppendLine($"  输出摘要: {outputJson.Length} chars ({Encoding.UTF8.GetByteCount(outputJson)} bytes)");
        logs.AppendLine($"  关键指标: 总数={all.Count}, 技术缺陷={techBugs.Count}, P2及以下={p2Below.Count}");
        logs.AppendLine($"  挂起={suspendedBugs.Count}, 临时解决={tempFixBugs.Count}, 未及时处理={p2NotTimely.Count}");
        logs.AppendLine($"  及时修复率={fixRate}%({fixRating}), 及时处理率={processRate}%({processRating})");

        var outputArtifact = MakeTextArtifact(node, "agg-out", "TAPD 28维度统计", outputJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { outputArtifact }, logs.ToString());
    }

    /// <summary>将 JsonElement 展平为 Dictionary（只取一层字符串值）</summary>
    private static Dictionary<string, string> JsonElementToDict(JsonElement el)
    {
        var dict = new Dictionary<string, string>();
        if (el.ValueKind != JsonValueKind.Object) return dict;
        foreach (var prop in el.EnumerateObject())
        {
            dict[prop.Name] = prop.Value.ValueKind switch
            {
                JsonValueKind.String => prop.Value.GetString() ?? "",
                JsonValueKind.Number => prop.Value.GetRawText(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Null => "",
                _ => prop.Value.GetRawText(),
            };
        }
        return dict;
    }

    /// <summary>从 JSON 元素中提取字段值（支持嵌套路径如 "Bug.severity"）</summary>
    /// <summary>
    /// 从脚本执行器的输入数据中提取精简的源数据引用（仅保留 ID/标题/URL 相关字段），
    /// 供下游 LLM 节点生成带链接的报告。这样即使 JS 脚本只输出统计结果，
    /// 下游仍能获取每条记录的 URL 和标题信息。
    /// </summary>
    private static string? BuildSourceDataReference(List<JsonElement> allItems)
    {
        if (allItems.Count == 0) return null;

        // 检测是否有 URL 相关字段（只有包含链接信息时才透传，避免无用数据）
        var urlFieldNames = new[] { "URL链接", "url", "URL", "link", "href", "描述中的链接" };
        var idFieldNames = new[] { "缺陷ID", "id", "ID", "bug_id", "标题", "title", "name" };

        var first = allItems[0];
        if (first.ValueKind != JsonValueKind.Object) return null;

        var hasUrlField = false;
        var relevantFields = new List<string>();
        foreach (var prop in first.EnumerateObject())
        {
            if (urlFieldNames.Any(u => prop.Name.Equals(u, StringComparison.OrdinalIgnoreCase)))
            {
                hasUrlField = true;
                relevantFields.Add(prop.Name);
            }
            else if (idFieldNames.Any(u => prop.Name.Equals(u, StringComparison.OrdinalIgnoreCase)))
            {
                relevantFields.Add(prop.Name);
            }
        }

        if (!hasUrlField || relevantFields.Count == 0) return null;

        // 构建精简引用：每条记录只保留 ID/标题/URL 字段
        var refs = new JsonArray();
        foreach (var item in allItems)
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var refObj = new JsonObject();
            foreach (var field in relevantFields)
            {
                if (item.TryGetProperty(field, out var val))
                {
                    var strVal = val.ValueKind == JsonValueKind.String ? val.GetString() : val.GetRawText();
                    if (!string.IsNullOrWhiteSpace(strVal))
                        refObj[field] = strVal;
                }
            }
            if (refObj.Count > 0) refs.Add(refObj);
        }

        return refs.Count > 0 ? refs.ToJsonString(JsonCompact) : null;
    }

    /// <summary>
    /// 从 HTML 或纯文本中提取所有 http/https URL（过滤 TAPD 内部链接，保留外部文档链接如语雀等）。
    /// TAPD description 字段可能是 HTML（含 &lt;a href="..."&gt;）或纯文本。
    /// </summary>
    private static List<string> ExtractUrlsFromHtmlOrText(string content)
    {
        var urls = new List<string>();
        if (string.IsNullOrWhiteSpace(content)) return urls;

        // 匹配 href="url" 中的 URL（HTML 模式）和纯文本中的 URL
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Text.RegularExpressions.Match m in
            System.Text.RegularExpressions.Regex.Matches(content,
                @"(?:href\s*=\s*[""']?\s*|(?<!\w))(https?://[^\s""'<>\]）》]+)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            var url = m.Groups[1].Value.TrimEnd('.', ',', ')', '>', '）', '》', ';');
            // 跳过 TAPD 内部链接（已有 URL链接 字段）和常见静态资源
            if (url.Contains("tapd.cn", StringComparison.OrdinalIgnoreCase)) continue;
            if (url.EndsWith(".js", StringComparison.OrdinalIgnoreCase) ||
                url.EndsWith(".css", StringComparison.OrdinalIgnoreCase) ||
                url.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ||
                url.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)) continue;
            if (seen.Add(url)) urls.Add(url);
        }
        return urls;
    }

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
                ? JsonSerializer.Serialize(jsonData, JsonPretty)
                : JsonSerializer.Serialize(jsonData, JsonCompact);
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

        return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(rows, JsonCompact));
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
            return JsonSerializer.Serialize(el.Value, JsonCompact);

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

        return JsonSerializer.Serialize(dict, JsonCompact);
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
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts, EmitEventDelegate? emitEvent = null)
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
            TimeoutSeconds = 300,
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

        reportLogs.AppendLine($"  ReportTemplate ({reportTemplate.Length} chars):");
        reportLogs.AppendLine(reportTemplate);
        reportLogs.AppendLine($"  Prompt 总长: {prompt.Length} chars (估算 {EstimateTokens(prompt)} tokens)");
        reportLogs.AppendLine("  --- 调用 LLM Gateway (streaming) ---");

        // ── 流式调用，与 LLM 分析器相同模式 ──
        var contentBuilder = new StringBuilder();
        var model = "(unknown)";
        int inputTokens = 0, outputTokens = 0;
        string? resolutionType = null;
        string? errorCode = null, errorMessage = null;

        const int CHUNK_BATCH_SIZE = 200;
        var pendingChunk = new StringBuilder();
        var streamSw = Stopwatch.StartNew();

        if (emitEvent != null)
        {
            await emitEvent("llm-stream-start", new { nodeId = node.NodeId, nodeName = node.Name });
        }

        try
        {
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                switch (chunk.Type)
                {
                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Start:
                        model = chunk.Resolution?.ActualModel ?? "(unknown)";
                        resolutionType = chunk.Resolution?.ResolutionType;
                        if (emitEvent != null)
                        {
                            await emitEvent("llm-stream-start", new { nodeId = node.NodeId, nodeName = node.Name, model });
                        }
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Text:
                        if (!string.IsNullOrEmpty(chunk.Content))
                        {
                            contentBuilder.Append(chunk.Content);
                            pendingChunk.Append(chunk.Content);

                            if (emitEvent != null && pendingChunk.Length >= CHUNK_BATCH_SIZE)
                            {
                                await emitEvent("llm-chunk", new
                                {
                                    nodeId = node.NodeId,
                                    content = pendingChunk.ToString(),
                                    accumulatedLength = contentBuilder.Length,
                                });
                                pendingChunk.Clear();
                            }
                        }
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Done:
                        inputTokens = chunk.TokenUsage?.InputTokens ?? 0;
                        outputTokens = chunk.TokenUsage?.OutputTokens ?? 0;
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Error:
                        errorCode = "STREAM_ERROR";
                        errorMessage = chunk.Error;
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            errorCode = "STREAM_EXCEPTION";
            errorMessage = ex.Message;
        }

        // 发送剩余的 pending chunk
        if (emitEvent != null && pendingChunk.Length > 0)
        {
            await emitEvent("llm-chunk", new
            {
                nodeId = node.NodeId,
                content = pendingChunk.ToString(),
                accumulatedLength = contentBuilder.Length,
            });
        }

        streamSw.Stop();
        var content = contentBuilder.ToString();

        if (emitEvent != null)
        {
            await emitEvent("llm-stream-end", new
            {
                nodeId = node.NodeId,
                totalLength = content.Length,
                durationMs = streamSw.ElapsedMilliseconds,
                model,
                inputTokens,
                outputTokens,
            });
        }

        reportLogs.AppendLine($"  Model: {model}");
        reportLogs.AppendLine($"  Tokens: input={inputTokens} output={outputTokens}");
        reportLogs.AppendLine($"  ResolutionType: {resolutionType}");
        reportLogs.AppendLine($"  Streaming duration: {streamSw.ElapsedMilliseconds}ms");

        if (!string.IsNullOrWhiteSpace(errorCode) || !string.IsNullOrWhiteSpace(errorMessage))
        {
            reportLogs.AppendLine($"  ❌ Gateway 错误: [{errorCode}] {errorMessage}");
        }

        // HTML 格式时提取完整 HTML 文档，去除 LLM 多余输出
        if (format == "html" && !string.IsNullOrWhiteSpace(content))
        {
            var dtIdx = content.IndexOf("<!DOCTYPE html", StringComparison.OrdinalIgnoreCase);
            if (dtIdx < 0) dtIdx = content.IndexOf("<html", StringComparison.OrdinalIgnoreCase);
            var endIdx = content.LastIndexOf("</html>", StringComparison.OrdinalIgnoreCase);
            if (dtIdx >= 0 && endIdx > dtIdx)
                content = content[dtIdx..(endIdx + "</html>".Length)].Trim();
        }

        reportLogs.AppendLine($"  LLM 响应 ({content.Length} chars):");
        reportLogs.AppendLine(content);

        if (string.IsNullOrWhiteSpace(content))
        {
            var reason = !string.IsNullOrWhiteSpace(errorMessage)
                ? $"Gateway 错误: {errorMessage}"
                : "可能是 LLM 调度失败";
            reportLogs.AppendLine($"  ⚠️ 警告: 报告内容为空 ({reason})");
        }

        var mimeType = format == "html" ? "text/html" : "text/markdown";
        var artifact = MakeTextArtifact(node, "report", "报告", content, mimeType);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, reportLogs.ToString());
    }

    // ── 网页报告生成器 ──────────────────────────────────────────

    public static async Task<CapsuleResult> ExecuteWebpageGeneratorAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts, EmitEventDelegate? emitEvent = null)
    {
        var gateway = sp.GetService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        if (gateway == null)
            throw new InvalidOperationException("LLM Gateway 未配置，无法生成网页报告");

        var reportTemplate = ReplaceVariables(GetConfigString(node, "reportTemplate") ?? "", variables);
        var style = GetConfigString(node, "style") ?? "modern-dark";
        var title = ReplaceVariables(GetConfigString(node, "title") ?? "", variables);
        var includeCharts = GetConfigString(node, "includeCharts") != "false";
        var maxInputTokens = 80000;

        var logs = new StringBuilder();
        logs.AppendLine($"[网页报告生成器] 节点: {node.Name}");
        logs.AppendLine($"  Style: {style}, IncludeCharts: {includeCharts}");
        logs.AppendLine($"  InputArtifacts: {inputArtifacts.Count} 个");
        foreach (var ia in inputArtifacts)
            logs.AppendLine($"    - [{ia.Name}] SlotId={ia.SlotId} InlineContent={ia.InlineContent?.Length ?? 0} chars");

        var inputText = string.Join("\n---\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => $"[{a.Name}]\n{a.InlineContent}"));

        // Token 感知截断
        var templateTokens = EstimateTokens(reportTemplate);
        var dataTokenBudget = maxInputTokens - templateTokens - 2000; // 预留更多给系统提示词
        if (dataTokenBudget < 1000) dataTokenBudget = 1000;
        var (truncatedInput, _, wasTruncated) = TruncateToTokenBudget(inputText, dataTokenBudget, logs);
        if (wasTruncated) inputText = truncatedInput;

        // 构建风格描述
        var styleDesc = style switch
        {
            "modern-dark" => "深色玻璃拟态风格 (dark glassmorphism)：深色背景 (#0f0f23)，半透明毛玻璃卡片 (rgba(255,255,255,0.05) + backdrop-filter: blur)，渐变色标题，柔和的发光边框。配色以深蓝/紫色为主调，辅以亮青色和金色高亮。",
            "modern-light" => "现代浅色风格：白色/浅灰背景，卡片带轻微阴影，清爽蓝绿配色，简约排版。",
            "dashboard" => "数据看板风格：类似 Grafana/Superset 看板，深色背景，卡片网格布局，大数字指标卡 (KPI cards) 在顶部，图表区域整齐排列。",
            "report" => "正式报告风格：类似企业 PDF 报告，白色背景，衬线标题，表格和段落为主，配色低调专业。",
            _ => "" // custom: 不额外描述
        };

        var systemPrompt = @"你是一位资深前端开发专家，擅长生成**演示文稿风格**的精美 HTML 报告。

## 输出要求
1. 输出一个**完整的、自包含的 HTML 文件**（从 <!DOCTYPE html> 开始到 </html> 结束）
2. 所有 CSS 和 JS 必须**内嵌**，不依赖外部样式表（Chart.js 等图表库可使用 CDN，服务器会自动下载内联）
3. **不要**输出任何 markdown 代码块标记（不要 ```html ... ```），直接输出 HTML 代码
4. **不要**在 HTML 之前或之后输出任何额外的解释文字

## 幻灯片演示架构（核心！）
整个报告采用 **PPT 幻灯片分页模式**，每个章节是一张独立的全屏幻灯片（slide）：

### HTML 结构
```
<div class=""slides-container"">
  <section class=""slide"" id=""slide-0"">封面</section>
  <section class=""slide"" id=""slide-1"">KPI 概览</section>
  <section class=""slide"" id=""slide-2"">图表分析</section>
  <section class=""slide"" id=""slide-3"">数据表格</section>
  ...更多幻灯片...
  <section class=""slide"" id=""slide-N"">结论与建议</section>
</div>
```

### CSS 要求
```css
/* 幻灯片容器 - 竖向 scroll-snap */
.slides-container {
  height: 100vh; overflow-y: auto; scroll-snap-type: y mandatory;
  scroll-behavior: smooth;
}
/* 每张幻灯片占满视口 */
.slide {
  min-height: 100vh; scroll-snap-align: start;
  display: flex; flex-direction: column; justify-content: center;
  padding: 60px 80px; box-sizing: border-box; position: relative;
}
```

### 导航系统（必须实现）
1. **右侧导航圆点**：固定在右侧的竖排小圆点，点击跳转对应幻灯片，当前页高亮
2. **键盘导航**：↑↓ 方向键切换幻灯片
3. **页码指示器**：右下角显示「3 / 8」格式的当前页/总页数
4. **IntersectionObserver**：用 IntersectionObserver 监听当前可见 slide 来更新导航状态

### JavaScript 导航示例
```js
const slides = document.querySelectorAll('.slide');
const dots = document.querySelectorAll('.nav-dot');
const pageIndicator = document.getElementById('page-indicator');
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const idx = [...slides].indexOf(e.target);
      dots.forEach((d,i) => d.classList.toggle('active', i===idx));
      pageIndicator.textContent = `${idx+1} / ${slides.length}`;
    }
  });
}, { threshold: 0.5 });
slides.forEach(s => observer.observe(s));
document.addEventListener('keydown', (e) => {
  const current = [...slides].findIndex(s => s.getBoundingClientRect().top >= -10);
  if (e.key==='ArrowDown'||e.key===' ') { e.preventDefault(); slides[Math.min(current+1,slides.length-1)]?.scrollIntoView({behavior:'smooth'}); }
  if (e.key==='ArrowUp') { e.preventDefault(); slides[Math.max(current-1,0)]?.scrollIntoView({behavior:'smooth'}); }
});
```

## 幻灯片内容编排
- **封面**：大标题 + 副标题(日期/团队) + 装饰性背景图形
- **KPI 概览**：3-5 个关键指标大数字卡片(grid)，每个卡片带图标、数值、趋势箭头
- **图表分析**（可多页）：每页聚焦 1-2 个图表，图表要大而清晰，配简短解读文字
- **数据表格**（可多页）：表格简洁，关键数据高亮，每页不超过 15 行
- **结论与建议**：要点列表 + 行动建议，每条建议用卡片呈现

## 缺陷统计报告专用渲染规则（当数据包含 dimensions 且 aggregationType 为 tapd-bug-28d 时适用）

### 重大缺陷页（P0/P1）
如果 dim 10 (P0) 或 dim 11 (P1) 的 details 数组非空，**必须**为其生成独立幻灯片「近期重大缺陷」：
- 按等级分组展示（先 P0 后 P1）
- 每条缺陷渲染为一个卡片，包含：
  - **问题描述**（标题字段），作为**可点击的超链接**，`<a href=""URL链接"" target=""_blank"">` 跳转到 TAPD
  - 如果该缺陷的 `描述中的链接` 字段非空，**必须额外渲染为独立的链接行**（通常是语雀溯源报告等外部文档）。格式：
    - 将 `描述中的链接` 按 ` | ` 分隔拆分为多个 URL
    - 每个 URL 渲染为 `<a href=""url"" target=""_blank"" class=""doc-link"">url</a>`
    - 如果能从 URL 路径推断文档标题（如语雀链接），可在链接后附加描述
  - 链接文字使用蓝色高亮，带下划线 hover 效果
  - 处理人/创建人 显示在缺陷描述下方
- 示例 HTML 结构：
```html
<h3>P0</h3>
<div class=""defect-card"">
  <a href=""https://www.tapd.cn/..."" target=""_blank"" class=""defect-link"">问题描述：XXX功能异常无法使用</a>
  <div class=""defect-doc-links"">
    <a href=""https://xxx.yuque.com/..."" target=""_blank"" class=""doc-link"">https://xxx.yuque.com/...《溯源报告》</a>
  </div>
  <div class=""defect-meta"">处理人：张三 | 创建人：李四</div>
</div>
```

### 缺陷分析页（挂起 / 临时解决 / 未及时处理）
如果 dim 29 (挂起)、dim 30 (临时解决)、dim 22 (未及时处理) 的 details 数组非空，**必须**生成「缺陷分析」幻灯片（可拆分多页）：
- 每个类别作为独立分区，标题如「挂起：N个」「临时解决：N个」「未及时处理：N个」
- 每条缺陷用**带编号的列表**展示：
  - 缺陷标题作为**可点击超链接**跳转 TAPD
  - 如果 `描述中的链接` 非空，在标题下方额外渲染为独立链接行（语雀等外部文档链接）
  - 标题后面或下方显示「处理人：XXX，创建人：YYY」
- 链接样式：蓝色文字 (`color: #38bdf8` 深色模式 / `color: #1d4ed8` 浅色模式)，hover 加下划线

### 结构归母分析页
如果 dim 28 的 groups 数组非空，**必须**生成「结构归母分析」幻灯片（可拆分多页）：
- 先用柱状图或进度条展示各归母类别的数量排名
- 然后每个归母类别下列出其对应的缺陷明细：
  - 归母类别名作为小标题
  - 每条缺陷：标题（可点击超链接跳转TAPD） + 缺陷等级标签 + 处理人
  - 为开会讨论方便，**标记代表性案例**（每个类别默认标记前 2-3 条作为讨论重点，用高亮边框或星标图标区分）
- 如果缺陷过多（单个类别超过 8 条），仅展示前 5 条并注明「还有 N 条...」

### 通用链接样式
所有缺陷链接必须使用以下样式：
```css
.defect-link {
  color: #38bdf8; text-decoration: none; border-bottom: 1px dashed rgba(56,189,248,0.4);
  transition: all 200ms ease; cursor: pointer;
}
.defect-link:hover { color: #7dd3fc; border-bottom-color: #7dd3fc; }
.doc-link {
  color: #38bdf8; text-decoration: none; font-size: 14px; word-break: break-all;
  border-bottom: 1px dashed rgba(56,189,248,0.3); transition: all 200ms ease; cursor: pointer;
}
.doc-link:hover { color: #7dd3fc; border-bottom-color: #7dd3fc; }
.defect-doc-links { margin: 6px 0 4px 0; padding-left: 8px; border-left: 2px solid rgba(56,189,248,0.3); }
.defect-meta { font-size: 13px; opacity: 0.65; margin-top: 4px; }
```";

        if (!string.IsNullOrWhiteSpace(styleDesc))
        {
            systemPrompt += $@"

## 视觉风格
{styleDesc}";
        }
        else
        {
            // 默认深色玻璃拟态风格
            systemPrompt += @"

## 视觉风格
深色玻璃拟态风格 (dark glassmorphism)：
- 背景：深色渐变 (#0f0f23 → #171738)
- 卡片：半透明毛玻璃 (rgba(255,255,255,0.05) + backdrop-filter: blur(15px))，1px solid rgba(255,255,255,0.1) 边框
- 标题：渐变色文字 (linear-gradient 亮青 → 金色)
- 强调色：亮青 #22d3ee、金色 #f59e0b、蓝色 #3b82f6
- 导航圆点：半透明白色，active 状态发光
- 字体：系统字体栈 (-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)";
        }

        if (includeCharts)
        {
            systemPrompt += @"

## 图表要求
- 优先使用**纯 CSS + HTML**实现简单图表（进度条、占比条、数字卡片）
- 如果数据复杂确实需要饼图/折线图/柱状图，使用 Chart.js (CDN: https://cdn.bootcdn.net/ajax/libs/Chart.js/4.4.7/chart.umd.min.js)
- **Chart.js 必须容错加载**，使用以下模式：
```html
<script src=""https://cdn.bootcdn.net/ajax/libs/Chart.js/4.4.7/chart.umd.min.js"" onerror=""window.__chartjsFailed=true""></script>
<script>
// 每个图表初始化都包裹在检查中
function safeChart(canvasId, config) {
  if (window.__chartjsFailed || typeof Chart === 'undefined') {
    var el = document.getElementById(canvasId);
    if (el) el.parentElement.innerHTML = '<div style=""padding:20px;text-align:center;opacity:0.5"">图表库加载失败，请在新标签页打开查看</div>';
    return;
  }
  new Chart(document.getElementById(canvasId), config);
}
</script>
```
- 图表配色与整体风格协调（深色背景下使用明亮色系）
- 每个图表独占或最多两个共享一张幻灯片
- 图表需要有清晰的标题和图例
- canvas 需设置合理的 max-height，避免图表过大";
        }

        systemPrompt += @"

## 专业 UI 设计规范 (ui-ux-pro-max)

### 图标与视觉元素
- **禁止使用 emoji 作为 UI 图标**（如 🎨 🚀 ⚙️）。用内联 SVG 图标替代，推荐 Heroicons/Lucide 风格：
  ```html
  <!-- 正确：内联 SVG 图标 -->
  <svg viewBox=""0 0 24 24"" width=""20"" height=""20"" fill=""none"" stroke=""currentColor"" stroke-width=""2""><path d=""M13 7l5 5m0 0l-5 5m5-5H6""/></svg>
  <!-- 错误：emoji 图标 -->
  <span>📈</span>
  ```
- 所有图标统一尺寸：KPI 卡片图标 32×32，正文图标 20×20，导航图标 16×16

### 交互与动效
- 所有可点击元素（卡片、按钮、链接、导航点）必须设置 `cursor: pointer`
- Hover 状态使用 `transition: all 200ms ease`，变化属性：颜色、透明度、box-shadow
- **禁止** hover 时 `transform: scale()` 导致布局偏移，改用 `box-shadow` 或 `border-color` 变化
- 微交互动画时长：150-300ms，缓动函数 `cubic-bezier(0.4, 0, 0.2, 1)`
- 入场动画：卡片 staggered fadeIn（每张延迟 80ms），使用 `@keyframes` + `animation-delay`

### 排版系统
- 字体栈：`'Inter', 'PingFang SC', 'Microsoft YaHei', -apple-system, sans-serif`
- 数据看板备选：`'Fira Code', 'JetBrains Mono', monospace`（用于数字/代码）
- 字体层级：封面标题 48-64px/700, 章节标题 28-36px/600, 正文 16px/400, 辅助 13px/400
- 正文行高 1.6-1.75，每行限制 65-75 字符（`max-width: 65ch`）
- 大数字使用 `font-variant-numeric: tabular-nums` 等宽对齐
- 渐变标题：`background: linear-gradient(...); -webkit-background-clip: text; -webkit-text-fill-color: transparent`

### 深色模式专业配色
- 背景层次：底层 #0a0a1a → 卡片 rgba(255,255,255,0.04) → 悬浮 rgba(255,255,255,0.08)
- 文字层次：主文字 rgba(255,255,255,0.92) → 次要 rgba(255,255,255,0.6) → 禁用 rgba(255,255,255,0.3)
- 边框：默认 rgba(255,255,255,0.08)，hover rgba(255,255,255,0.15)
- 发光效果：`box-shadow: 0 0 20px rgba(56,189,248,0.08), 0 8px 32px rgba(0,0,0,0.3)`
- 图表配色序列（深色友好）：#38bdf8(天蓝) #a78bfa(紫) #34d399(绿) #fbbf24(金) #fb7185(粉) #22d3ee(青)

### 图表配色科学
- 分类数据：最多 6 种颜色，超过则合并为""其他""
- 趋势数据：单色渐变（#1e40af → #38bdf8）表示从低到高
- 对比数据：对比色对（#34d399 正面 / #fb7185 负面）
- 饼图/环形图：填充透明度 0.8，描边 2px #0a0a1a 分隔
- 图表区域 `border-radius: 12px` + 适当 padding

### 卡片设计系统
```css
.glass-card {
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px; padding: 24px;
  transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
.glass-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}
```

## 响应式与打印
- 桌面：幻灯片内容居中，最大宽度 1200px
- 移动端 (@media max-width: 768px)：padding 缩小为 24px 16px，卡片单列，字体缩小一级
- @media print：page-break-after: always，隐藏导航，白色背景，文字改深色

## 质量标准（交付检查清单）
- 每张幻灯片留白充足，内容不超过面积 60%
- 文字对比度 WCAG AA (4.5:1)，深色背景主文字不低于 rgba(255,255,255,0.87)
- 动画必须 `@media (prefers-reduced-motion: reduce)` 禁用检测
- 表格横向滚动（overflow-x: auto），表头固定背景色
- 所有可交互元素带 `cursor: pointer`
- **无 emoji 图标**，全部使用内联 SVG
- 导航圆点和页码指示器 `z-index: 50` 悬浮于内容上方";

        var userPrompt = string.IsNullOrWhiteSpace(reportTemplate)
            ? $"请根据以下数据生成一份精美的 HTML 网页报告：\n\n{inputText}"
            : $"{reportTemplate}\n\n## 数据\n\n{inputText}";

        if (!string.IsNullOrWhiteSpace(title))
            userPrompt = $"网页标题：{title}\n\n{userPrompt}";

        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = PrdAgent.Core.Models.AppCallerRegistry.WorkflowAgent.WebpageGenerator.Code,
            ModelType = "code",
            TimeoutSeconds = 300,
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userPrompt }
                }
            }
        };

        logs.AppendLine($"  SystemPrompt: {systemPrompt.Length} chars");
        logs.AppendLine($"  UserPrompt: {userPrompt.Length} chars (估算 {EstimateTokens(userPrompt)} tokens)");
        logs.AppendLine("  --- 调用 LLM Gateway (streaming) ---");

        // ── 流式调用 ──
        var contentBuilder = new StringBuilder();
        var model = "(unknown)";
        int inputTokens = 0, outputTokens = 0;
        string? errorCode = null, errorMessage = null;

        const int CHUNK_BATCH_SIZE = 200;
        var pendingChunk = new StringBuilder();
        var streamSw = Stopwatch.StartNew();

        if (emitEvent != null)
            await emitEvent("llm-stream-start", new { nodeId = node.NodeId, nodeName = node.Name });

        try
        {
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                switch (chunk.Type)
                {
                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Start:
                        model = chunk.Resolution?.ActualModel ?? "(unknown)";
                        if (emitEvent != null)
                            await emitEvent("llm-stream-start", new { nodeId = node.NodeId, nodeName = node.Name, model });
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Text:
                        if (!string.IsNullOrEmpty(chunk.Content))
                        {
                            contentBuilder.Append(chunk.Content);
                            pendingChunk.Append(chunk.Content);
                            if (emitEvent != null && pendingChunk.Length >= CHUNK_BATCH_SIZE)
                            {
                                await emitEvent("llm-chunk", new
                                {
                                    nodeId = node.NodeId,
                                    content = pendingChunk.ToString(),
                                    accumulatedLength = contentBuilder.Length,
                                });
                                pendingChunk.Clear();
                            }
                        }
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Done:
                        inputTokens = chunk.TokenUsage?.InputTokens ?? 0;
                        outputTokens = chunk.TokenUsage?.OutputTokens ?? 0;
                        break;

                    case PrdAgent.Infrastructure.LlmGateway.GatewayChunkType.Error:
                        errorCode = "STREAM_ERROR";
                        errorMessage = chunk.Error;
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            errorCode = "STREAM_EXCEPTION";
            errorMessage = ex.Message;
        }

        if (emitEvent != null && pendingChunk.Length > 0)
        {
            await emitEvent("llm-chunk", new
            {
                nodeId = node.NodeId,
                content = pendingChunk.ToString(),
                accumulatedLength = contentBuilder.Length,
            });
        }

        streamSw.Stop();
        var htmlContent = contentBuilder.ToString();

        // 清理 LLM 可能添加的 markdown 代码块标记和多余内容
        // 策略：优先提取 <!DOCTYPE html> ... </html> 之间的完整 HTML 文档
        var doctypeIdx = htmlContent.IndexOf("<!DOCTYPE html", StringComparison.OrdinalIgnoreCase);
        if (doctypeIdx < 0) doctypeIdx = htmlContent.IndexOf("<html", StringComparison.OrdinalIgnoreCase);
        var htmlEndIdx = htmlContent.LastIndexOf("</html>", StringComparison.OrdinalIgnoreCase);
        if (doctypeIdx >= 0 && htmlEndIdx > doctypeIdx)
        {
            htmlContent = htmlContent[doctypeIdx..(htmlEndIdx + "</html>".Length)];
        }
        else
        {
            // 回退：简单清理 markdown 围栏
            if (htmlContent.StartsWith("```html", StringComparison.OrdinalIgnoreCase))
                htmlContent = htmlContent["```html".Length..];
            else if (htmlContent.StartsWith("```"))
                htmlContent = htmlContent[3..];
            if (htmlContent.EndsWith("```"))
                htmlContent = htmlContent[..^3];
        }
        htmlContent = htmlContent.Trim();

        if (emitEvent != null)
        {
            await emitEvent("llm-stream-end", new
            {
                nodeId = node.NodeId,
                totalLength = htmlContent.Length,
                durationMs = streamSw.ElapsedMilliseconds,
                model, inputTokens, outputTokens,
            });
        }

        logs.AppendLine($"  Model: {model}");
        logs.AppendLine($"  Tokens: input={inputTokens} output={outputTokens}");
        logs.AppendLine($"  Streaming duration: {streamSw.ElapsedMilliseconds}ms");
        logs.AppendLine($"  HTML output: {htmlContent.Length} chars");

        if (!string.IsNullOrWhiteSpace(errorCode))
            logs.AppendLine($"  Gateway 错误: [{errorCode}] {errorMessage}");

        if (string.IsNullOrWhiteSpace(htmlContent))
        {
            var reason = !string.IsNullOrWhiteSpace(errorMessage) ? $"Gateway 错误: {errorMessage}" : "LLM 未返回内容";
            logs.AppendLine($"  警告: 网页内容为空 ({reason})");
        }

        // ── CDN 资源内联：下载外部 JS/CSS 并嵌入 HTML，避免内网无法访问 ──
        var factory = sp.GetRequiredService<IHttpClientFactory>();
        htmlContent = await InlineExternalResourcesAsync(factory, htmlContent, logs);

        var fileName = !string.IsNullOrWhiteSpace(title) ? $"{title}.html" : "网页报告.html";
        var artifact = MakeTextArtifact(node, "webpage-out", fileName, htmlContent, "text/html");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
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

        // 规范化扩展名（markdown → md）
        var ext = format == "markdown" ? "md" : format;
        if (!fileName.Contains('.'))
            fileName = $"{fileName}.{ext}";

        var content = string.Join("\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent));

        var mimeType = format switch
        {
            "csv" => "text/csv; charset=utf-8",
            "html" => "text/html; charset=utf-8",
            "md" or "markdown" => "text/markdown; charset=utf-8",
            "txt" => "text/plain; charset=utf-8",
            _ => "application/json; charset=utf-8",
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

        // 收集附件：从上游产物的 COS URL 中提取
        List<NotificationAttachment>? attachments = null;
        var attachMode = GetConfigString(node, "attachFromInput") ?? "none";
        if (attachMode == "cos" && inputArtifacts.Count > 0)
        {
            attachments = inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.CosUrl))
                .Select(a => new NotificationAttachment
                {
                    Name = a.Name,
                    Url = a.CosUrl!,
                    SizeBytes = a.SizeBytes,
                    MimeType = a.MimeType,
                })
                .ToList();
            if (attachments.Count == 0) attachments = null;
        }

        var notification = new AdminNotification
        {
            Title = title,
            Message = message,
            Level = level,
            Source = "workflow-agent",
            Attachments = attachments,
        };
        await db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);

        var artifact = MakeTextArtifact(node, "notification", "通知", JsonSerializer.Serialize(new { title, sent = true }));
        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"Notification sent: {title}");
    }

    // ═══════════════════════════════════════════════════════════
    // CDN 资源内联（网页报告用）
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// 扫描 HTML 中的外部 &lt;script src&gt; 和 &lt;link rel="stylesheet" href&gt; 标签，
    /// 通过服务器代理下载后内联到 HTML 中，使网页完全自包含。
    /// </summary>
    internal static async Task<string> InlineExternalResourcesAsync(
        IHttpClientFactory factory, string html, StringBuilder logs)
    {
        var sw = Stopwatch.StartNew();
        var inlinedCount = 0;
        var failedCount = 0;

        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);
        client.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (PrdAgent-Server) AppleWebKit/537.36");

        // 大陆 CDN 镜像映射：海外 CDN → 国内镜像，提高下载成功率
        string ResolveMirrorUrl(string url)
        {
            // jsdelivr → 国内镜像
            if (url.Contains("cdn.jsdelivr.net"))
                return url.Replace("cdn.jsdelivr.net", "cdn.jsdmirror.com");
            // unpkg → npmmirror
            if (url.Contains("unpkg.com"))
                return url.Replace("unpkg.com", "registry.npmmirror.com").Replace("/npm/", "/-/").Replace("@", "") + "/files/";
            // cdnjs → bootcdn
            if (url.Contains("cdnjs.cloudflare.com"))
                return url.Replace("cdnjs.cloudflare.com/ajax/libs", "cdn.bootcdn.net/ajax/libs");
            return url;
        }

        // 带镜像回退的下载
        async Task<string> DownloadWithMirrorAsync(string url)
        {
            try
            {
                return await client.GetStringAsync(url);
            }
            catch
            {
                var mirror = ResolveMirrorUrl(url);
                if (mirror != url)
                {
                    logs.AppendLine($"    → 原始URL失败，尝试镜像: {mirror}");
                    return await client.GetStringAsync(mirror);
                }
                throw;
            }
        }

        // ── 1. 内联外部 <script src="https://..."></script> ──
        var scriptPattern = new System.Text.RegularExpressions.Regex(
            @"<script\b[^>]*\bsrc\s*=\s*[""'](https?://[^""']+)[""'][^>]*>\s*</script>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline);

        var scriptMatches = scriptPattern.Matches(html);
        // 逆序替换以保持索引稳定
        for (int i = scriptMatches.Count - 1; i >= 0; i--)
        {
            var m = scriptMatches[i];
            var url = m.Groups[1].Value;
            logs.AppendLine($"  [CDN内联] 下载 JS: {url}");
            try
            {
                var content = await DownloadWithMirrorAsync(url);
                var inlineTag = $"<script>/* inlined: {url} */\n{content}\n</script>";
                html = string.Concat(html.AsSpan(0, m.Index), inlineTag, html.AsSpan(m.Index + m.Length));
                inlinedCount++;
                logs.AppendLine($"    → 成功 ({content.Length} chars)");
            }
            catch (Exception ex)
            {
                failedCount++;
                logs.AppendLine($"    → 失败: {ex.Message}");
                // 保留原始标签不动，浏览器仍可尝试加载
            }
        }

        // ── 2. 内联外部 <link rel="stylesheet" href="https://..."> ──
        var linkPattern = new System.Text.RegularExpressions.Regex(
            @"<link\b[^>]*\brel\s*=\s*[""']stylesheet[""'][^>]*\bhref\s*=\s*[""'](https?://[^""']+)[""'][^>]*/?\s*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline);

        var linkMatches = linkPattern.Matches(html);
        for (int i = linkMatches.Count - 1; i >= 0; i--)
        {
            var m = linkMatches[i];
            var url = m.Groups[1].Value;
            logs.AppendLine($"  [CDN内联] 下载 CSS: {url}");
            try
            {
                var content = await DownloadWithMirrorAsync(url);
                var inlineTag = $"<style>/* inlined: {url} */\n{content}\n</style>";
                html = string.Concat(html.AsSpan(0, m.Index), inlineTag, html.AsSpan(m.Index + m.Length));
                inlinedCount++;
                logs.AppendLine($"    → 成功 ({content.Length} chars)");
            }
            catch (Exception ex)
            {
                failedCount++;
                logs.AppendLine($"    → 失败: {ex.Message}");
            }
        }

        // ── 3. 也处理 href 在 rel 前面的情况 ──
        var linkPattern2 = new System.Text.RegularExpressions.Regex(
            @"<link\b[^>]*\bhref\s*=\s*[""'](https?://[^""']+)[""'][^>]*\brel\s*=\s*[""']stylesheet[""'][^>]*/?\s*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline);

        var linkMatches2 = linkPattern2.Matches(html);
        for (int i = linkMatches2.Count - 1; i >= 0; i--)
        {
            var m = linkMatches2[i];
            var url = m.Groups[1].Value;
            // 避免重复处理（如果已经被上面的 pattern 内联了，这里不会匹配到 <link> 了）
            logs.AppendLine($"  [CDN内联] 下载 CSS: {url}");
            try
            {
                var content = await DownloadWithMirrorAsync(url);
                var inlineTag = $"<style>/* inlined: {url} */\n{content}\n</style>";
                html = string.Concat(html.AsSpan(0, m.Index), inlineTag, html.AsSpan(m.Index + m.Length));
                inlinedCount++;
                logs.AppendLine($"    → 成功 ({content.Length} chars)");
            }
            catch (Exception ex)
            {
                failedCount++;
                logs.AppendLine($"    → 失败: {ex.Message}");
            }
        }

        sw.Stop();
        logs.AppendLine($"  [CDN内联] 完成: 内联 {inlinedCount} 个, 失败 {failedCount} 个, 耗时 {sw.ElapsedMilliseconds}ms");
        return html;
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

        // 自动补全文件扩展名，确保下载时带正确后缀
        var displayName = EnsureFileExtension(name, mimeType);

        return new ExecutionArtifact
        {
            Name = displayName,
            MimeType = mimeType,
            SlotId = slotId,
            InlineContent = content,
            SizeBytes = System.Text.Encoding.UTF8.GetByteCount(content),
        };
    }

    /// <summary>
    /// 确保文件名带正确扩展名（根据 mimeType 推断）
    /// </summary>
    private static string EnsureFileExtension(string name, string mimeType)
    {
        if (string.IsNullOrWhiteSpace(name)) name = "output";
        // 已有扩展名则直接返回
        if (System.IO.Path.HasExtension(name)) return name;

        var ext = mimeType switch
        {
            "text/markdown" => ".md",
            "text/html" => ".html",
            "text/css" => ".css",
            "text/csv" => ".csv",
            "application/json" => ".json",
            "application/xml" or "text/xml" => ".xml",
            "application/javascript" => ".js",
            "text/plain" => ".txt",
            _ when mimeType.Contains("markdown") => ".md",
            _ when mimeType.Contains("json") => ".json",
            _ when mimeType.Contains("csv") => ".csv",
            _ when mimeType.Contains("html") => ".html",
            _ => ".txt",
        };
        return name + ext;
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
