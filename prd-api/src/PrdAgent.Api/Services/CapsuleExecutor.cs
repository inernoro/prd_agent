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
            CapsuleTypes.EventTrigger => ExecuteEventTrigger(node, variables),

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
            CapsuleTypes.SitePublisher => await ExecuteSitePublisherAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.EmailSender => await ExecuteEmailSenderAsync(sp, node, variables, inputArtifacts),

            // ── 短视频工作流类 ──
            CapsuleTypes.DouyinParser => await ExecuteDouyinParserAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.VideoDownloader => await ExecuteVideoDownloaderAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.VideoToText => await ExecuteVideoToTextAsync(sp, node, variables, inputArtifacts, emitEvent),
            CapsuleTypes.TextToCopywriting => await ExecuteTextToCopywritingAsync(sp, node, variables, inputArtifacts, emitEvent),

            // ── CLI Agent 执行器 ──
            CapsuleTypes.CliAgentExecutor => await ExecuteCliAgentAsync(sp, node, variables, inputArtifacts, emitEvent),

            // ── 异步任务类 ──
            CapsuleTypes.VideoGeneration => await ExecuteVideoGenerationAsync(sp, node, variables, inputArtifacts, emitEvent),

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

    public static CapsuleResult ExecuteEventTrigger(WorkflowNode node, Dictionary<string, string> variables)
    {
        // 事件触发器：从 variables 中提取事件载荷（由 AutomationHub 注入）
        var eventType = variables.GetValueOrDefault("__eventType", "unknown");
        var eventTitle = variables.GetValueOrDefault("__eventTitle", "");
        var eventContent = variables.GetValueOrDefault("__eventContent", "");
        var eventSourceId = variables.GetValueOrDefault("__eventSourceId", "");

        // 构建事件变量（排除系统变量）
        var eventVariables = new Dictionary<string, string>();
        foreach (var kvp in variables)
        {
            if (kvp.Key.StartsWith("__event_"))
                eventVariables[kvp.Key["__event_".Length..]] = kvp.Value;
        }

        var payload = new
        {
            trigger = "event",
            eventType,
            title = eventTitle,
            content = eventContent,
            sourceId = eventSourceId,
            variables = eventVariables,
            timestamp = DateTime.UtcNow
        };

        var output = JsonSerializer.Serialize(payload, JsonCompact);
        var artifact = MakeTextArtifact(node, "event-out", "事件载荷", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, $"事件触发: {eventType} - {eventTitle}");
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
    /// 智能 HTTP：自动识别分页参数并翻页拉取全量数据。
    /// 支持：offset/page/cursor 分页、自定义数据路径、POST body 分页、请求间延迟、失败重试。
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
        var dataPath = GetConfigString(node, "dataPath") ?? "";
        var cursorField = GetConfigString(node, "cursorField") ?? "next_cursor";
        var cursorParam = GetConfigString(node, "cursorParam") ?? "cursor";
        var requestDelayMs = int.TryParse(GetConfigString(node, "requestDelayMs"), out var rd) ? rd : 0;
        var retryCount = int.TryParse(GetConfigString(node, "retryCount"), out var rc) ? Math.Min(rc, 3) : 0;
        var bodyPageField = GetConfigString(node, "bodyPageField") ?? "";

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
                        client.DefaultRequestHeaders.TryAddWithoutValidation(k, ReplaceVariables(v, variables));
            }
            catch { /* ignore malformed headers */ }
        }

        var allData = new System.Text.Json.Nodes.JsonArray();
        var logs = $"SmartHTTP [{paginationType}] {method} {url}\n";
        if (!string.IsNullOrWhiteSpace(dataPath)) logs += $"  dataPath: {dataPath}\n";
        var currentUrl = url;
        var currentBody = body;
        var pagesFetched = 0;

        // 分页循环
        for (var page = 0; page < maxPages; page++)
        {
            // 请求间延迟（首页不延迟）
            if (page > 0 && requestDelayMs > 0)
                await Task.Delay(Math.Min(requestDelayMs, 5000), CancellationToken.None);

            // 发送请求（含重试）
            var (responseBody, statusCode) = await SmartHttpSendWithRetry(
                client, method, currentUrl, currentBody, retryCount, logs);

            pagesFetched++;
            logs += $"  Page {pagesFetched}: {statusCode}, {responseBody.Length} bytes\n";

            if (statusCode < 200 || statusCode >= 300)
            {
                logs += $"  [WARN] Non-success status {statusCode}, stopping pagination\n";
                break;
            }

            // 解析 JSON 响应
            try
            {
                using var doc = JsonDocument.Parse(responseBody);
                var root = doc.RootElement;

                // ── 数据提取：优先用 dataPath，否则自动检测 ──
                JsonElement dataArr;
                if (!string.IsNullOrWhiteSpace(dataPath))
                {
                    dataArr = TraverseJsonPath(root, dataPath);
                }
                else if (root.ValueKind == JsonValueKind.Array)
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

                if (dataArr.ValueKind != JsonValueKind.Array)
                {
                    // dataPath 指向的不是数组，当作单条
                    allData.Add(System.Text.Json.Nodes.JsonNode.Parse(dataArr.GetRawText()));
                    break;
                }

                if (dataArr.GetArrayLength() == 0) break; // 空页，停止

                foreach (var item in dataArr.EnumerateArray())
                    allData.Add(System.Text.Json.Nodes.JsonNode.Parse(item.GetRawText()));

                // 分页检测：如果策略是 none → 不翻页
                if (paginationType == "none") break;

                // ── cursor 分页 ──
                if (paginationType == "cursor")
                {
                    var nextCursor = TraverseJsonPathString(root, cursorField);
                    if (string.IsNullOrWhiteSpace(nextCursor))
                    {
                        logs += "  cursor is empty, stopping\n";
                        break;
                    }
                    // 将 cursor 写入 URL query
                    var uri = new Uri(currentUrl);
                    var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
                    query[cursorParam] = nextCursor;
                    var builder = new UriBuilder(uri) { Query = query.ToString() };
                    currentUrl = builder.Uri.ToString();
                    // 如果有 body 分页字段也更新
                    if (!string.IsNullOrWhiteSpace(bodyPageField))
                        currentBody = SetJsonFieldValue(currentBody, bodyPageField, nextCursor);
                    continue;
                }

                // ── offset / page / auto 分页 ──
                var pUri = new Uri(currentUrl);
                var pQuery = System.Web.HttpUtility.ParseQueryString(pUri.Query);

                bool advanced = false;

                if (paginationType == "page" || (paginationType == "auto" && pQuery["page"] != null))
                {
                    var p = int.TryParse(pQuery["page"], out var pv) ? pv + 1 : 2;
                    pQuery["page"] = p.ToString();
                    advanced = true;
                    // POST body 分页
                    if (!string.IsNullOrWhiteSpace(bodyPageField))
                        currentBody = SetJsonFieldValue(currentBody, bodyPageField, p.ToString());
                }
                else if (paginationType == "offset" || (paginationType == "auto" && pQuery["offset"] != null))
                {
                    var limit = int.TryParse(pQuery["limit"], out var lv) ? lv : dataArr.GetArrayLength();
                    var offset = int.TryParse(pQuery["offset"], out var ov) ? ov + limit : limit;
                    pQuery["offset"] = offset.ToString();
                    advanced = true;
                    // POST body 分页
                    if (!string.IsNullOrWhiteSpace(bodyPageField))
                        currentBody = SetJsonFieldValue(currentBody, bodyPageField, offset.ToString());
                }
                else if (paginationType == "auto")
                {
                    // 尝试从响应中查找 next / next_url / next_page_url
                    string? nextUrl = null;
                    foreach (var field in new[] { "next", "next_url", "next_page_url" })
                    {
                        if (root.TryGetProperty(field, out var nv) && nv.ValueKind == JsonValueKind.String)
                        {
                            nextUrl = nv.GetString();
                            break;
                        }
                    }
                    if (!string.IsNullOrWhiteSpace(nextUrl))
                    {
                        currentUrl = nextUrl;
                        continue;
                    }
                    // 尝试 cursor 自动检测
                    var autoCursor = TraverseJsonPathString(root, "next_cursor")
                                  ?? TraverseJsonPathString(root, "paging.next_cursor")
                                  ?? TraverseJsonPathString(root, "cursor");
                    if (!string.IsNullOrWhiteSpace(autoCursor))
                    {
                        var aUri = new Uri(currentUrl);
                        var aQuery = System.Web.HttpUtility.ParseQueryString(aUri.Query);
                        aQuery["cursor"] = autoCursor;
                        var aBuilder = new UriBuilder(aUri) { Query = aQuery.ToString() };
                        currentUrl = aBuilder.Uri.ToString();
                        logs += $"  auto-detected cursor: {autoCursor[..Math.Min(autoCursor.Length, 20)]}...\n";
                        continue;
                    }
                    break; // 无法检测分页，停止
                }

                if (advanced)
                {
                    var builder = new UriBuilder(pUri) { Query = pQuery.ToString() };
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
    /// 发送 HTTP 请求并在失败时重试（指数退避）
    /// </summary>
    private static async Task<(string body, int statusCode)> SmartHttpSendWithRetry(
        HttpClient client, string method, string url, string body, int maxRetries, string logs)
    {
        for (var attempt = 0; attempt <= maxRetries; attempt++)
        {
            try
            {
                HttpResponseMessage response;
                if (method.Equals("POST", StringComparison.OrdinalIgnoreCase))
                {
                    var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
                    response = await client.PostAsync(url, content, CancellationToken.None);
                }
                else
                {
                    response = await client.GetAsync(url, CancellationToken.None);
                }

                var responseBody = await response.Content.ReadAsStringAsync(CancellationToken.None);
                return (responseBody, (int)response.StatusCode);
            }
            catch (Exception ex) when (attempt < maxRetries)
            {
                var delayMs = (int)Math.Pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
                logs += $"  [RETRY] Attempt {attempt + 1} failed: {ex.Message}, retrying in {delayMs}ms\n";
                await Task.Delay(delayMs, CancellationToken.None);
            }
            catch (Exception ex)
            {
                return ($"{{\"error\": \"{ex.Message.Replace("\"", "'")}\"}}", 0);
            }
        }
        return ("{\"error\": \"unreachable\"}", 0);
    }

    /// <summary>
    /// 按点号路径遍历 JSON 元素（如 "result.list" → root["result"]["list"]）
    /// </summary>
    private static JsonElement TraverseJsonPath(JsonElement root, string dotPath)
    {
        var current = root;
        foreach (var segment in dotPath.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (current.ValueKind == JsonValueKind.Object && current.TryGetProperty(segment, out var child))
                current = child;
            else
                return default;
        }
        return current;
    }

    /// <summary>
    /// 按点号路径遍历 JSON 并返回字符串值（如提取 cursor 值）
    /// </summary>
    private static string? TraverseJsonPathString(JsonElement root, string dotPath)
    {
        var el = TraverseJsonPath(root, dotPath);
        return el.ValueKind == JsonValueKind.String ? el.GetString()
             : el.ValueKind == JsonValueKind.Number ? el.GetRawText()
             : null;
    }

    /// <summary>
    /// 设置 JSON 字符串中指定字段的值（用于 POST body 分页）
    /// </summary>
    private static string SetJsonFieldValue(string json, string fieldPath, string value)
    {
        if (string.IsNullOrWhiteSpace(json)) return json;
        try
        {
            var node = System.Text.Json.Nodes.JsonNode.Parse(json);
            if (node is not System.Text.Json.Nodes.JsonObject obj) return json;

            var segments = fieldPath.Split('.', StringSplitOptions.RemoveEmptyEntries);
            var current = obj;
            for (var i = 0; i < segments.Length - 1; i++)
            {
                if (current[segments[i]] is System.Text.Json.Nodes.JsonObject child)
                    current = child;
                else
                    return json; // 路径不存在，不修改
            }
            var lastKey = segments[^1];
            // 尝试写入为数字，否则写入为字符串
            if (int.TryParse(value, out var intVal))
                current[lastKey] = intVal;
            else
                current[lastKey] = value;

            return node.ToJsonString();
        }
        catch
        {
            return json;
        }
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

            // 根据实际内容推断 MIME 类型，而非始终用 application/json
            var outputMime = InferMimeType(outputJson);
            var artifact = MakeTextArtifact(node, "script-out", "脚本输出", outputJson, outputMime);
            var artifacts = new List<ExecutionArtifact> { artifact };

            // ── 5. 自动透传源数据引用（精简版：仅保留 ID/标题/URL，供下游 LLM 生成带链接的报告）──
            var sourceRef = BuildSourceDataReference(allItems);
            if (!string.IsNullOrEmpty(sourceRef))
            {
                var refArtifact = MakeTextArtifact(node, "script-out", "源数据引用", sourceRef, "application/json");
                refArtifact.Tags = new List<string> { "auto-generated" };
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

        // ── stored 模式：从外部授权中心解析凭证 ──
        if (authMode == "stored")
        {
            var authId = GetConfigString(node, "authId") ?? throw new InvalidOperationException("authMode=stored 需要配置 authId");
            variables.TryGetValue("__triggeredBy", out var userId);
            if (string.IsNullOrWhiteSpace(userId))
                throw new InvalidOperationException("无法确定工作流发起人，无法解析授权凭证");

            var authService = sp.GetRequiredService<PrdAgent.Core.Interfaces.IExternalAuthorizationService>();
            var credentials = await authService.ResolveCredentialsAsync(userId, authId, "tapd-collector", CancellationToken.None)
                ?? throw new InvalidOperationException($"授权 {authId} 不存在或已撤销");

            // 通过 variables 传递凭证（仅内存，不写入 node.Config 避免明文持久化）
            if (credentials.TryGetValue("cookie", out var cookie))
                variables["__resolved_tapd_cookie"] = cookie;
            authMode = "cookie";
        }

        if (string.IsNullOrWhiteSpace(workspaceId))
            throw new InvalidOperationException("TAPD 工作空间 ID 未配置");

        var factory = sp.GetRequiredService<IHttpClientFactory>();

        // ── 趋势模式：多月循环采集 total_count ──
        var trendMode = GetConfigString(node, "trendMode") ?? "false";
        if (trendMode == "true" && authMode == "cookie")
            return await ExecuteTapdTrendModeAsync(factory, node, variables, workspaceId, dataType);

        if (authMode == "cookie")
            return await ExecuteTapdCookieModeAsync(factory, node, variables, workspaceId, dataType, dateRange);
        else
            return await ExecuteTapdBasicAuthModeAsync(factory, node, variables, workspaceId, dataType, dateRange);
    }

    /// <summary>
    /// 趋势模式：从当前月往回追溯 N 个月，每月仅发 1 次搜索请求（perpage=1）读取 total_count，
    /// 输出 JSON 数组 [{month, totalBugs}]，适合下游 ScriptExecutor 画折线图。
    /// </summary>
    private static async Task<CapsuleResult> ExecuteTapdTrendModeAsync(
        IHttpClientFactory factory, WorkflowNode node, Dictionary<string, string> variables,
        string workspaceId, string dataType)
    {
        var trendMonths = int.TryParse(GetConfigString(node, "trendMonths"), out var tm) ? Math.Clamp(tm, 1, 24) : 6;
        var cookieStr = ReplaceVariables(GetConfigString(node, "cookie") ?? "", variables);
        // stored authMode 通过 variables 传递凭证，避免明文写入 node.Config
        if (string.IsNullOrWhiteSpace(cookieStr) && variables.TryGetValue("__resolved_tapd_cookie", out var resolvedCookie))
            cookieStr = resolvedCookie;
        var dscToken = GetConfigString(node, "dscToken") ?? GetConfigString(node, "dsc_token") ?? "";

        if (string.IsNullOrWhiteSpace(cookieStr))
            throw new InvalidOperationException("Cookie 未配置。趋势模式需要 Cookie 认证");

        // 尝试从 cookie 中提取 dsc-token
        if (string.IsNullOrWhiteSpace(dscToken))
        {
            var match = System.Text.RegularExpressions.Regex.Match(cookieStr, @"dsc-token=([^;\s]+)");
            if (match.Success) dscToken = match.Groups[1].Value;
        }

        var logs = new StringBuilder();
        logs.AppendLine($"[TAPD 趋势模式] workspace={workspaceId} dataType={dataType} months={trendMonths}");

        var trendData = new JsonArray();
        var now = DateTime.Now;

        for (var i = trendMonths - 1; i >= 0; i--)
        {
            var targetMonth = now.AddMonths(-i);
            var monthStr = targetMonth.ToString("yyyy-MM");

            using var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            var searchUrl = "https://www.tapd.cn/api/search_filter/search_filter/search";
            var entityType = dataType == "bugs" ? "bug" : dataType.TrimEnd('s');

            var filterData = new JsonArray
            {
                new JsonObject
                {
                    ["entity"] = entityType,
                    ["fieldDisplayName"] = "反馈时间",
                    ["fieldSubEntityType"] = "",
                    ["fieldIsSystem"] = "0",
                    ["fieldOption"] = "like",
                    ["fieldSystemName"] = "反馈时间",
                    ["fieldType"] = "text",
                    ["selectOption"] = new JsonArray(),
                    ["value"] = monthStr,
                    ["id"] = "4",
                }
            };

            var searchData = new JsonObject
            {
                ["workspace_ids"] = workspaceId,
                ["search_data"] = JsonSerializer.Serialize(new
                {
                    data = filterData,
                    optionType = "AND",
                    needInit = "1",
                }),
                ["obj_type"] = entityType,
                ["search_type"] = "advanced",
                ["page"] = 1,
                ["perpage"] = "1", // 只需要 total_count，不需要实际数据
                ["block_size"] = 50,
                ["parallel_token"] = "",
                ["order_field"] = "created",
                ["order_value"] = "desc",
                ["show_fields"] = new JsonArray(),
                ["extra_fields"] = new JsonArray(),
                ["display_mode"] = "list",
                ["version"] = "1.1.0",
                ["only_gen_token"] = 0,
                ["exclude_workspace_configs"] = new JsonArray(),
                ["from_pro_dashboard"] = 1,
            };
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

            try
            {
                var response = await client.SendAsync(request, CancellationToken.None);
                var body = await response.Content.ReadAsStringAsync(CancellationToken.None);

                if (!response.IsSuccessStatusCode)
                {
                    logs.AppendLine($"  {monthStr}: HTTP {(int)response.StatusCode} failed");
                    trendData.Add(new JsonObject { ["month"] = monthStr, ["totalBugs"] = 0, ["error"] = true });
                    continue;
                }

                var trimmedBody = body.TrimStart();
                if (trimmedBody.Length == 0 || (trimmedBody[0] != '{' && trimmedBody[0] != '['))
                {
                    logs.AppendLine($"  {monthStr}: 非 JSON 响应（Cookie 可能已过期）");
                    throw new InvalidOperationException("TAPD Cookie 可能已过期，请重新从浏览器复制 Cookie。");
                }

                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;

                var totalCount = 0;
                if (root.TryGetProperty("data", out var dataEl) &&
                    dataEl.ValueKind == JsonValueKind.Object &&
                    dataEl.TryGetProperty("total_count", out var totalEl))
                {
                    var totalStr = totalEl.ValueKind == JsonValueKind.Number
                        ? totalEl.GetInt32().ToString()
                        : totalEl.GetString() ?? "0";
                    totalCount = int.TryParse(totalStr, out var tc) ? tc : 0;
                }

                // 月份显示标签：取月份数字 + "月"
                var monthLabel = $"{targetMonth.Month}月";
                trendData.Add(new JsonObject
                {
                    ["month"] = monthStr,
                    ["monthLabel"] = monthLabel,
                    ["totalBugs"] = totalCount,
                });

                logs.AppendLine($"  {monthStr} ({monthLabel}): {totalCount} 条");
            }
            catch (InvalidOperationException) { throw; }
            catch (Exception ex)
            {
                logs.AppendLine($"  {monthStr}: 请求异常 - {ex.Message}");
                trendData.Add(new JsonObject { ["month"] = monthStr, ["totalBugs"] = 0, ["error"] = true });
            }

            // 避免请求过快
            if (i > 0)
                await Task.Delay(300, CancellationToken.None);
        }

        logs.AppendLine($"趋势采集完成: {trendData.Count} 个月");

        var resultJson = trendData.ToJsonString(JsonCompact);
        var artifact = MakeTextArtifact(node, "tapd-out", $"TAPD {dataType} 趋势数据", resultJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs.ToString());
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
        if (string.IsNullOrWhiteSpace(cookieStr) && variables.TryGetValue("__resolved_tapd_cookie", out var resolvedCookie2))
            cookieStr = resolvedCookie2;
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
            logs.AppendLine($"  [DEBUG] custom_field_one={Get("custom_field_one")} | custom_field_three={Get("custom_field_three")} | custom_field_11={Get("custom_field_11")} | custom_field_13={Get("custom_field_13")}");
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
            ["逻辑归因"] = Get("custom_field_three"),
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
            ["逻辑归因"] = Get("custom_field_three"),
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
        var validArtifacts = inputArtifacts.Where(a => !string.IsNullOrWhiteSpace(a.InlineContent)).ToList();

        switch (strategy)
        {
            case "object":
            {
                // 合并为对象 { input1: ..., input2: ..., input3: ... }
                // 按输入产物名称或序号作为 key，解析 JSON 值
                var obj = new System.Text.Json.Nodes.JsonObject();
                for (var i = 0; i < validArtifacts.Count; i++)
                {
                    var key = !string.IsNullOrWhiteSpace(validArtifacts[i].Name)
                        ? validArtifacts[i].Name
                        : $"input{i + 1}";
                    try
                    {
                        var parsed = System.Text.Json.Nodes.JsonNode.Parse(validArtifacts[i].InlineContent!);
                        obj[key] = parsed;
                    }
                    catch
                    {
                        obj[key] = validArtifacts[i].InlineContent;
                    }
                }
                merged = obj.ToJsonString(JsonPretty);
                break;
            }
            case "array":
            {
                // 合并为数组 [ a, b, c ]
                var arr = new System.Text.Json.Nodes.JsonArray();
                foreach (var a in validArtifacts)
                {
                    try
                    {
                        var parsed = System.Text.Json.Nodes.JsonNode.Parse(a.InlineContent!);
                        arr.Add(parsed);
                    }
                    catch
                    {
                        arr.Add(a.InlineContent);
                    }
                }
                merged = arr.ToJsonString(JsonPretty);
                break;
            }
            case "concat":
            {
                // 拼接数组元素 [ ...a, ...b ]
                var arr = new System.Text.Json.Nodes.JsonArray();
                foreach (var a in validArtifacts)
                {
                    try
                    {
                        var parsed = System.Text.Json.Nodes.JsonNode.Parse(a.InlineContent!);
                        if (parsed is System.Text.Json.Nodes.JsonArray jsonArr)
                        {
                            foreach (var item in jsonArr)
                                arr.Add(item?.DeepClone());
                        }
                        else
                        {
                            arr.Add(parsed);
                        }
                    }
                    catch
                    {
                        arr.Add(a.InlineContent);
                    }
                }
                merged = arr.ToJsonString(JsonPretty);
                break;
            }
            case "json-array":
            {
                var items = validArtifacts.Select(a => a.InlineContent!).ToList();
                merged = JsonSerializer.Serialize(items, JsonCompact);
                break;
            }
            default:
            {
                // 旧兼容：纯文本拼接
                merged = string.Join("\n---\n", validArtifacts.Select(a => a.InlineContent));
                break;
            }
        }

        var logs = $"Data merger: strategy={strategy}, sources={validArtifacts.Count}\n";
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

        // 收集附件：优先 COS URL，回退到 inline content（生成 data URI）
        List<NotificationAttachment>? attachments = null;
        var attachMode = GetConfigString(node, "attachFromInput") ?? "none";
        if (attachMode == "cos" && inputArtifacts.Count > 0)
        {
            attachments = new List<NotificationAttachment>();
            foreach (var a in inputArtifacts)
            {
                if (!string.IsNullOrWhiteSpace(a.CosUrl))
                {
                    attachments.Add(new NotificationAttachment
                    {
                        Name = a.Name,
                        Url = a.CosUrl!,
                        SizeBytes = a.SizeBytes,
                        MimeType = a.MimeType,
                    });
                }
                else if (!string.IsNullOrWhiteSpace(a.InlineContent))
                {
                    // 内联内容 → data URI，确保通知附件可下载
                    var mime = a.MimeType ?? "text/plain";
                    var base64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(a.InlineContent));
                    attachments.Add(new NotificationAttachment
                    {
                        Name = a.Name,
                        Url = $"data:{mime};base64,{base64}",
                        SizeBytes = a.SizeBytes,
                        MimeType = mime,
                    });
                }
            }
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

    /// <summary>
    /// 根据内容推断 MIME 类型：Markdown 特征 → text/markdown，JSON 对象/数组 → application/json，否则 text/plain
    /// </summary>
    private static string InferMimeType(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return "text/plain";
        var trimmed = content.TrimStart();

        // HTML 文档（高置信度：DOCTYPE 或 <html 开头）
        if (trimmed.StartsWith("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("<html", StringComparison.OrdinalIgnoreCase))
            return "text/html";

        // JSON 对象或数组
        if (trimmed.StartsWith('{') || trimmed.StartsWith('['))
            return "application/json";

        // CSV：非 JSON/HTML/Markdown，前两行逗号数一致且 >= 2
        if (!trimmed.StartsWith('#') && !trimmed.StartsWith('<'))
        {
            var lines = trimmed.Split('\n', 3);
            if (lines.Length >= 2)
            {
                var c1 = lines[0].Count(c => c == ',');
                var c2 = lines[1].Count(c => c == ',');
                if (c1 >= 2 && c1 == c2)
                    return "text/csv";
            }
        }

        // Markdown 特征：标题、列表、表格
        if (trimmed.StartsWith('#') || trimmed.Contains("\n# ") || trimmed.Contains("\n| ") || trimmed.Contains("\n- "))
            return "text/markdown";

        return "text/plain";
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

    /// <summary>
    /// 运行时往节点 config 里回填字段（用于 stored authMode 解析出的凭证注入）。
    /// </summary>
    public static void SetConfigValue(WorkflowNode node, string key, object value)
    {
        node.Config[key] = value;
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

    // ── 站点发布 ──────────────────────────────────────────────

    public static async Task<CapsuleResult> ExecuteSitePublisherAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        var siteService = sp.GetRequiredService<PrdAgent.Core.Interfaces.IHostedSiteService>();
        var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("CapsuleExecutor.SitePublisher");
        var sb = new StringBuilder();

        // 1. 从上游产物中提取 HTML 内容
        var htmlContent = "";
        foreach (var input in inputArtifacts)
        {
            var content = input.InlineContent ?? "";
            if (string.IsNullOrWhiteSpace(content)) continue;
            // 优先选择 HTML MIME 类型的产物
            if (input.MimeType == "text/html" || content.Contains("<!DOCTYPE html", StringComparison.OrdinalIgnoreCase)
                                               || content.Contains("<html", StringComparison.OrdinalIgnoreCase))
            {
                htmlContent = content;
                sb.AppendLine($"[输入] 使用产物 '{input.Name}' ({input.SizeBytes} bytes) 作为 HTML 源");
                break;
            }
        }

        // 如果没找到 HTML 产物，取第一个有内容的产物包装为 HTML
        if (string.IsNullOrWhiteSpace(htmlContent))
        {
            var firstContent = inputArtifacts
                .FirstOrDefault(a => !string.IsNullOrWhiteSpace(a.InlineContent));
            if (firstContent != null)
            {
                htmlContent = $"<!DOCTYPE html><html><head><meta charset='utf-8'><title>Auto Generated</title></head><body><pre>{System.Net.WebUtility.HtmlEncode(firstContent.InlineContent!)}</pre></body></html>";
                sb.AppendLine($"[输入] 无 HTML 产物，将 '{firstContent.Name}' 包装为纯文本 HTML");
            }
        }

        if (string.IsNullOrWhiteSpace(htmlContent))
            throw new InvalidOperationException("站点发布失败：上游无可用的 HTML 内容。请在此节点前连接一个「网页报告」或其他生成 HTML 的节点。");

        // 2. 解析配置
        var title = ReplaceVariables(GetConfigString(node, "title") ?? "", variables);
        var description = ReplaceVariables(GetConfigString(node, "description") ?? "", variables);
        var folder = ReplaceVariables(GetConfigString(node, "folder") ?? "", variables);
        var tagsStr = ReplaceVariables(GetConfigString(node, "tags") ?? "", variables);
        var autoShare = GetConfigString(node, "autoShare") ?? "false";
        var shareExpiryDays = int.TryParse(GetConfigString(node, "shareExpiryDays"), out var days) ? days : 30;

        var tags = string.IsNullOrWhiteSpace(tagsStr)
            ? new List<string> { "auto-gen", "workflow" }
            : tagsStr.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

        if (string.IsNullOrWhiteSpace(title))
            title = $"工作流自动发布 - {DateTime.Now:yyyy-MM-dd HH:mm}";

        // 3. 确定 userId（从执行上下文变量中获取）
        var userId = variables.GetValueOrDefault("__triggeredBy") ?? "system";
        var executionId = variables.GetValueOrDefault("__executionId") ?? "";

        sb.AppendLine($"[配置] 标题={title}, 文件夹={folder}, 标签=[{string.Join(", ", tags)}]");
        sb.AppendLine($"[配置] 自动分享={autoShare}, 有效期={shareExpiryDays}天");

        // 4. 调用 IHostedSiteService 发布
        logger.LogInformation("SitePublisher: Publishing HTML ({Length} chars) for user {UserId}",
            htmlContent.Length, userId);

        var site = await siteService.CreateFromContentAsync(
            userId: userId,
            htmlContent: htmlContent,
            title: title,
            description: string.IsNullOrWhiteSpace(description) ? null : description,
            sourceType: "workflow",
            sourceRef: executionId,
            tags: tags,
            folder: string.IsNullOrWhiteSpace(folder) ? null : folder,
            ct: CancellationToken.None);

        sb.AppendLine($"[发布] 站点已创建: id={site.Id}");
        sb.AppendLine($"[发布] 访问地址: {site.SiteUrl}");
        sb.AppendLine($"[发布] 文件数: {site.Files.Count}, 总大小: {site.TotalSize} bytes");

        // 5. 构建输出
        var result = new Dictionary<string, object?>
        {
            ["siteId"] = site.Id,
            ["siteUrl"] = site.SiteUrl,
            ["title"] = site.Title,
            ["fileCount"] = site.Files.Count,
            ["totalSize"] = site.TotalSize,
            ["folder"] = site.Folder,
            ["tags"] = site.Tags,
        };

        // 6. 自动创建分享链接（可选）
        if (autoShare is "public" or "password")
        {
            try
            {
                var displayName = variables.GetValueOrDefault("__triggeredByName") ?? "系统";
                var password = autoShare == "password"
                    ? Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6))
                        .Replace("+", "").Replace("/", "")[..8]
                    : null;

                var shareLink = await siteService.CreateShareAsync(
                    userId: userId,
                    displayName: displayName,
                    siteId: site.Id,
                    siteIds: null,
                    shareType: "single",
                    title: title,
                    description: description,
                    password: password,
                    expiresInDays: shareExpiryDays,
                    ct: CancellationToken.None);

                var shareUrl = $"/share/web/{shareLink.Token}";
                result["shareUrl"] = shareUrl;
                result["shareToken"] = shareLink.Token;
                result["sharePassword"] = password;
                result["shareExpiresAt"] = shareLink.ExpiresAt?.ToString("O");

                sb.AppendLine($"[分享] 链接已创建: token={shareLink.Token}");
                if (password != null)
                    sb.AppendLine($"[分享] 访问密码: {password}");
                sb.AppendLine($"[分享] 有效期至: {shareLink.ExpiresAt:yyyy-MM-dd}");
            }
            catch (Exception ex)
            {
                sb.AppendLine($"[分享] 创建分享链接失败: {ex.Message}");
                logger.LogWarning(ex, "SitePublisher: Failed to create share link for site {SiteId}", site.Id);
            }
        }

        var outputJson = JsonSerializer.Serialize(result, JsonPretty);
        var artifact = MakeTextArtifact(node, "site-out", "站点发布结果", outputJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
    }

    // ── 邮件发送 ──────────────────────────────────────────────

    public static async Task<CapsuleResult> ExecuteEmailSenderAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        var emailService = sp.GetRequiredService<PrdAgent.Infrastructure.Services.ITutorialEmailService>();
        var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("CapsuleExecutor.EmailSender");
        var sb = new StringBuilder();

        var toEmail = ReplaceVariables(GetConfigString(node, "toEmail") ?? "", variables).Trim();
        var toName = ReplaceVariables(GetConfigString(node, "toName") ?? "", variables).Trim();
        var subject = ReplaceVariables(GetConfigString(node, "subject") ?? "", variables).Trim();
        var bodyTemplate = ReplaceVariables(GetConfigString(node, "bodyTemplate") ?? "", variables);
        var useHtml = GetConfigString(node, "useHtml") != "false";

        if (string.IsNullOrWhiteSpace(toEmail))
        {
            return new CapsuleResult(
                new List<ExecutionArtifact> { MakeTextArtifact(node, "email-out", "错误", "{\"success\":false,\"error\":\"收件人邮箱为空\"}") },
                "收件人邮箱为空，跳过发送");
        }

        if (string.IsNullOrWhiteSpace(subject))
            subject = "工作流自动邮件";

        // 邮件正文：优先使用配置模板，否则使用上游产物内容
        string htmlBody;
        if (!string.IsNullOrWhiteSpace(bodyTemplate))
        {
            htmlBody = bodyTemplate;
        }
        else
        {
            // 从上游产物获取内容
            var inputContent = inputArtifacts
                .FirstOrDefault(a => a.SlotId == "email-in")?.InlineContent;
            if (string.IsNullOrWhiteSpace(inputContent))
                inputContent = inputArtifacts.FirstOrDefault()?.InlineContent;

            if (string.IsNullOrWhiteSpace(inputContent))
            {
                return new CapsuleResult(
                    new List<ExecutionArtifact> { MakeTextArtifact(node, "email-out", "错误", "{\"success\":false,\"error\":\"邮件正文为空（无模板且无上游内容）\"}") },
                    "邮件正文为空，跳过发送");
            }

            htmlBody = inputContent;
        }

        // 如果内容不是 HTML 且开启了 HTML 模式，做简单包装
        if (useHtml && !htmlBody.TrimStart().StartsWith("<", StringComparison.Ordinal))
        {
            htmlBody = $"<div style=\"font-family:sans-serif;line-height:1.6;white-space:pre-wrap\">{System.Net.WebUtility.HtmlEncode(htmlBody)}</div>";
        }

        if (string.IsNullOrWhiteSpace(toName))
            toName = toEmail;

        sb.AppendLine($"[邮件] 发送至: {toEmail}");
        sb.AppendLine($"[邮件] 主题: {subject}");

        logger.LogInformation("EmailSender: Sending email to {ToEmail}, subject={Subject}", toEmail, subject);

        var success = await emailService.SendEmailAsync(toEmail, toName, subject, htmlBody, CancellationToken.None);

        var result = new
        {
            success,
            toEmail,
            toName,
            subject,
            sentAt = DateTime.UtcNow.ToString("o"),
            bodyLength = htmlBody.Length,
        };

        if (success)
        {
            sb.AppendLine("[邮件] ✅ 发送成功");
            logger.LogInformation("EmailSender: Email sent successfully to {ToEmail}", toEmail);
        }
        else
        {
            sb.AppendLine("[邮件] ❌ 发送失败（请检查系统 SMTP 配置）");
            logger.LogWarning("EmailSender: Failed to send email to {ToEmail}", toEmail);
        }

        var outputJson = JsonSerializer.Serialize(result, JsonPretty);
        var artifact = MakeTextArtifact(node, "email-out", "邮件发送结果", outputJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
    }

    // ── CLI Agent 执行器（多执行器分发） ────────────────────────

    /// <summary>多轮迭代上下文，所有执行器共享</summary>
    private class CliAgentContext
    {
        public string Spec { get; init; } = "none";
        public string Framework { get; init; } = "html";
        public string Style { get; init; } = "ui-ux-pro-max";
        public string Prompt { get; init; } = "";
        public string SpecInput { get; init; } = "";
        public string PreviousOutput { get; init; } = "";
        public string UserFeedback { get; init; } = "";
        public bool IsIteration { get; init; }
        public int TimeoutSeconds { get; init; } = 300;
        public Dictionary<string, string> EnvVars { get; init; } = new();
    }

    /// <summary>
    /// CLI Agent 执行器入口：按 executorType 分发到具体执行器。
    /// 支持 builtin-llm / docker / api / script 四种模式，可自由扩展。
    /// </summary>
    public static async Task<CapsuleResult> ExecuteCliAgentAsync(
        IServiceProvider sp, WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts,
        EmitEventDelegate? emitEvent = null)
    {
        var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("CapsuleExecutor.CliAgent");
        var sb = new StringBuilder();
        sb.AppendLine($"[CLI Agent] 节点: {node.Name}");

        // ── 1. 提取公共上下文 ──
        var ctx = ExtractCliAgentContext(node, variables, inputArtifacts, sb);
        var executorType = GetConfigString(node, "executorType") ?? "builtin-llm";
        sb.AppendLine($"  执行器: {executorType}");
        sb.AppendLine($"  框架: {ctx.Framework}, 风格: {ctx.Style}, 规范: {ctx.Spec}");
        sb.AppendLine($"  迭代: {(ctx.IsIteration ? $"是（上轮 {ctx.PreviousOutput.Length}c, 反馈 {ctx.UserFeedback.Length}c）" : "否")}");

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "preparing", executorType, message = $"准备 {executorType} 执行器…" });

        // ── 2. 按类型分发 ──
        try
        {
            return executorType switch
            {
                "builtin-llm" => await ExecuteCliAgent_BuiltinLlmAsync(sp, node, variables, ctx, sb, emitEvent),
                "docker" => await ExecuteCliAgent_DockerAsync(sp, node, variables, ctx, sb, logger, emitEvent),
                "api" => await ExecuteCliAgent_ApiAsync(sp, node, variables, ctx, sb, logger, emitEvent),
                "script" => ExecuteCliAgent_Script(node, ctx, sb),
                "lobster" => await ExecuteCliAgent_LobsterAsync(sp, node, variables, ctx, sb, logger, emitEvent),
                _ => throw new InvalidOperationException($"未知执行器类型: {executorType}，支持: builtin-llm, docker, api, script"),
            };
        }
        catch (Exception ex) when (ex is not InvalidOperationException)
        {
            sb.AppendLine($"[CLI Agent] ❌ 执行异常: {ex.Message}");
            logger.LogError(ex, "CliAgent executor {Type} failed", executorType);
            var errHtml = $"<!DOCTYPE html><html><body><h1>CLI Agent 执行失败</h1><p>执行器: {executorType}</p><pre>{System.Net.WebUtility.HtmlEncode(ex.Message)}</pre></body></html>";
            return new CapsuleResult(new List<ExecutionArtifact>
            {
                MakeTextArtifact(node, "cli-html-out", "错误", errHtml, "text/html"),
                MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
            }, sb.ToString());
        }
    }

    /// <summary>从节点配置和输入产物中提取公共上下文</summary>
    private static CliAgentContext ExtractCliAgentContext(
        WorkflowNode node, Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts, StringBuilder sb)
    {
        var specInput = inputArtifacts.FirstOrDefault(a => a.SlotId == "cli-spec-in")?.InlineContent ?? "";
        var prevOutput = inputArtifacts.FirstOrDefault(a => a.SlotId == "cli-prev-in")?.InlineContent ?? "";
        var feedback = inputArtifacts.FirstOrDefault(a => a.SlotId == "cli-feedback-in")?.InlineContent ?? "";

        // fallback: 按名称匹配
        if (string.IsNullOrWhiteSpace(specInput))
            specInput = inputArtifacts.FirstOrDefault(a => a.Name?.Contains("spec", StringComparison.OrdinalIgnoreCase) == true)?.InlineContent ?? "";
        if (string.IsNullOrWhiteSpace(prevOutput))
            prevOutput = inputArtifacts.FirstOrDefault(a => a.Name?.Contains("previous", StringComparison.OrdinalIgnoreCase) == true)?.InlineContent ?? "";
        if (string.IsNullOrWhiteSpace(feedback))
            feedback = inputArtifacts.FirstOrDefault(a => a.Name?.Contains("feedback", StringComparison.OrdinalIgnoreCase) == true)?.InlineContent ?? "";

        var envVars = new Dictionary<string, string>();
        var envJson = ReplaceVariables(GetConfigString(node, "envVars") ?? "", variables).Trim();
        if (!string.IsNullOrWhiteSpace(envJson))
        {
            try { envVars = JsonSerializer.Deserialize<Dictionary<string, string>>(envJson) ?? new(); }
            catch (Exception ex) { sb.AppendLine($"  ⚠️ envVars 解析失败: {ex.Message}"); }
        }

        return new CliAgentContext
        {
            Spec = GetConfigString(node, "spec") ?? "none",
            Framework = GetConfigString(node, "framework") ?? "html",
            Style = GetConfigString(node, "style") ?? "ui-ux-pro-max",
            Prompt = ReplaceVariables(GetConfigString(node, "prompt") ?? "", variables).Trim(),
            SpecInput = specInput,
            PreviousOutput = prevOutput,
            UserFeedback = feedback,
            IsIteration = !string.IsNullOrWhiteSpace(prevOutput) || !string.IsNullOrWhiteSpace(feedback),
            TimeoutSeconds = int.TryParse(GetConfigString(node, "timeoutSeconds"), out var t) ? t : 300,
            EnvVars = envVars,
        };
    }

    // ── 执行器 A: builtin-llm（内置 LLM 生成，无需 Docker） ──

    private static async Task<CapsuleResult> ExecuteCliAgent_BuiltinLlmAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        CliAgentContext ctx, StringBuilder sb, EmitEventDelegate? emitEvent)
    {
        var gateway = sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        sb.AppendLine("[builtin-llm] 使用内置 LLM 生成页面");

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "running", message = "LLM 生成中…" });

        // 构建 system prompt
        var systemPrompt = BuildPageGenSystemPrompt(ctx);

        // 构建 user prompt
        var userPrompt = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(ctx.SpecInput))
            userPrompt.AppendLine($"## 产品规格\n{ctx.SpecInput}\n");
        if (!string.IsNullOrWhiteSpace(ctx.Prompt))
            userPrompt.AppendLine($"## 用户需求\n{ctx.Prompt}\n");
        if (ctx.IsIteration)
        {
            if (!string.IsNullOrWhiteSpace(ctx.PreviousOutput))
                userPrompt.AppendLine($"## 上一轮生成结果\n```html\n{TruncateLog(ctx.PreviousOutput, 30000)}\n```\n");
            if (!string.IsNullOrWhiteSpace(ctx.UserFeedback))
                userPrompt.AppendLine($"## 用户修改意见\n{ctx.UserFeedback}\n");
            userPrompt.AppendLine("请根据用户的修改意见，在上一轮结果的基础上进行增量修改。保留用户满意的部分，只改需要改的。");
        }
        else
        {
            userPrompt.AppendLine("请根据上述需求生成完整的 HTML 页面。");
        }

        sb.AppendLine($"  System prompt: {systemPrompt.Length} chars");
        sb.AppendLine($"  User prompt: {userPrompt.Length} chars");

        var messages = new System.Text.Json.Nodes.JsonArray
        {
            new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
            new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userPrompt.ToString() },
        };
        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = "page-agent.generate::chat",
            ModelType = "chat",
            TimeoutSeconds = ctx.TimeoutSeconds,
            RequestBody = new System.Text.Json.Nodes.JsonObject { ["messages"] = messages },
        };

        var sw = Stopwatch.StartNew();
        var response = await gateway.SendAsync(request, CancellationToken.None);
        sw.Stop();

        var content = response?.Content ?? "";
        sb.AppendLine($"  LLM 响应: {content.Length} chars, 耗时: {sw.ElapsedMilliseconds}ms");

        // 清理 markdown 代码块
        content = CleanHtmlFromLlmResponse(content);

        if (string.IsNullOrWhiteSpace(content))
        {
            content = "<!DOCTYPE html><html><body><h1>LLM 未返回内容</h1></body></html>";
            sb.AppendLine("  ⚠️ LLM 返回空内容");
        }

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "completed", message = $"完成，{sw.ElapsedMilliseconds}ms" });

        return new CapsuleResult(new List<ExecutionArtifact>
        {
            MakeTextArtifact(node, "cli-html-out", "生成页面", content, "text/html"),
            MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
        }, sb.ToString());
    }

    /// <summary>构建页面生成的 system prompt</summary>
    private static string BuildPageGenSystemPrompt(CliAgentContext ctx)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一位资深全栈开发专家，擅长生成精美的自包含 HTML 页面。");
        sb.AppendLine();
        sb.AppendLine("## 输出要求");
        sb.AppendLine("1. 输出一个完整的 HTML 文件（<!DOCTYPE html> 到 </html>）");
        sb.AppendLine("2. 所有 CSS 和 JS 必须内嵌，不依赖外部文件");
        sb.AppendLine("3. 不要输出 markdown 代码块标记，直接输出 HTML");
        sb.AppendLine("4. HTML 前后不要有多余文字");

        // 框架提示
        if (ctx.Framework != "html" && ctx.Framework != "custom")
            sb.AppendLine($"\n## 框架\n使用 {ctx.Framework} 风格的组件化结构，但仍以单 HTML 文件输出（内嵌 CDN 引用可接受）。");

        // 风格提示
        var styleDesc = ctx.Style switch
        {
            "ui-ux-pro-max" => "高端 UI/UX 设计：大量留白、优雅动画、玻璃拟态或渐变、精致的排版层次、响应式布局。配色专业但有视觉冲击力。",
            "minimal" => "极简风格：大量留白、单色或双色调、无装饰、内容优先。",
            "dashboard" => "数据看板风格：深色背景、KPI 卡片网格、图表区域、类似 Grafana 布局。",
            "landing" => "着陆页风格：Hero 大图、CTA 按钮、功能区块、社会证明、页脚。",
            "doc" => "文档站风格：侧边导航、清晰的标题层次、代码块高亮、目录。",
            _ => "",
        };
        if (!string.IsNullOrWhiteSpace(styleDesc))
            sb.AppendLine($"\n## 视觉风格\n{styleDesc}");

        // 规范提示
        if (ctx.Spec != "none")
        {
            var specDesc = ctx.Spec switch
            {
                "spec" => "产品规格文档：按功能模块组织，包含用户故事、验收标准、界面原型描述。",
                "dri" => "DRI 方案：包含背景、目标、里程碑、决策点、风险评估。",
                "dev" => "开发设计文档：包含 API 设计、数据模型、技术选型、接口定义。",
                "sdd" => "软件设计文档（SDD）：含架构图描述、模块划分、接口规约、测试方案。",
                _ => "",
            };
            if (!string.IsNullOrWhiteSpace(specDesc))
                sb.AppendLine($"\n## 文档规范\n页面内容应按照「{specDesc}」的结构组织。");
        }

        if (ctx.IsIteration)
            sb.AppendLine("\n## 迭代模式\n你正在修改已有页面。仔细阅读用户反馈，精确修改对应部分，不要重写没问题的内容。");

        return sb.ToString();
    }

    /// <summary>清理 LLM 响应中的 markdown 代码块</summary>
    private static string CleanHtmlFromLlmResponse(string content)
    {
        content = content.Trim();
        if (content.StartsWith("```html", StringComparison.OrdinalIgnoreCase))
            content = content[7..];
        else if (content.StartsWith("```"))
            content = content[3..];
        if (content.EndsWith("```"))
            content = content[..^3];
        content = content.Trim();

        // 提取 <!DOCTYPE 到 </html> 范围
        var docIdx = content.IndexOf("<!DOCTYPE", StringComparison.OrdinalIgnoreCase);
        var endIdx = content.LastIndexOf("</html>", StringComparison.OrdinalIgnoreCase);
        if (docIdx >= 0 && endIdx > docIdx)
            content = content[docIdx..(endIdx + 7)];

        return content;
    }

    // ── 执行器 B: Docker 容器 ──

    private static async Task<CapsuleResult> ExecuteCliAgent_DockerAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        CliAgentContext ctx, StringBuilder sb, ILogger logger, EmitEventDelegate? emitEvent)
    {
        var image = ReplaceVariables(GetConfigString(node, "image") ?? "node:20-slim", variables).Trim();
        var setupCmd = ReplaceVariables(GetConfigString(node, "setupCommand") ?? "", variables).Trim();
        var genCmd = ReplaceVariables(GetConfigString(node, "generateCommand") ?? "", variables).Trim();

        if (string.IsNullOrWhiteSpace(image))
            throw new InvalidOperationException("Docker 执行器需要配置镜像（image）");

        sb.AppendLine($"[docker] 镜像: {image}");

        // 创建临时目录
        var runId = Guid.NewGuid().ToString("N")[..12];
        var workDir = Path.Combine(Path.GetTempPath(), "cli-agent", runId);
        var outputDir = Path.Combine(workDir, "output");
        var contextDir = Path.Combine(workDir, "context");
        Directory.CreateDirectory(outputDir);
        Directory.CreateDirectory(contextDir);

        // 写入上下文文件
        var contextObj = new { ctx.Spec, ctx.Framework, ctx.Style, ctx.Prompt, ctx.SpecInput, ctx.PreviousOutput, ctx.UserFeedback, ctx.IsIteration };
        await File.WriteAllTextAsync(Path.Combine(contextDir, "context.json"), JsonSerializer.Serialize(contextObj, JsonPretty));
        if (!string.IsNullOrWhiteSpace(ctx.PreviousOutput))
            await File.WriteAllTextAsync(Path.Combine(contextDir, "previous.html"), ctx.PreviousOutput);
        if (!string.IsNullOrWhiteSpace(ctx.UserFeedback))
            await File.WriteAllTextAsync(Path.Combine(contextDir, "feedback.txt"), ctx.UserFeedback);

        // 构建 run.sh
        var script = new StringBuilder("set -e\n");
        if (!ctx.IsIteration && !string.IsNullOrWhiteSpace(setupCmd))
            script.AppendLine(setupCmd);
        if (!string.IsNullOrWhiteSpace(genCmd))
            script.AppendLine(genCmd);
        else
            script.AppendLine("ls -la /output/ 2>/dev/null || echo 'No output'");
        await File.WriteAllTextAsync(Path.Combine(contextDir, "run.sh"), script.ToString());

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "running", message = $"启动 {image}…" });

        // docker run
        var args = $"run --rm --memory=512m --cpus=1 -v \"{contextDir}:/context:ro\" -v \"{outputDir}:/output\" -w /workspace";
        foreach (var (k, v) in ctx.EnvVars)
            args += $" -e \"{k}={v.Replace("\"", "\\\"")}\"";
        args += $" {image} sh /context/run.sh";

        var sw = Stopwatch.StartNew();
        string stdOut, stdErr;
        int exitCode;

        using var proc = new Process();
        proc.StartInfo = new ProcessStartInfo
        {
            FileName = "docker", Arguments = args,
            RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
        };
        proc.Start();
        var outTask = proc.StandardOutput.ReadToEndAsync();
        var errTask = proc.StandardError.ReadToEndAsync();
        if (!proc.WaitForExit(ctx.TimeoutSeconds * 1000))
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            sb.AppendLine($"[docker] ⚠️ 超时 {ctx.TimeoutSeconds}s");
        }
        stdOut = await outTask;
        stdErr = await errTask;
        exitCode = proc.ExitCode;
        sw.Stop();

        sb.AppendLine($"[docker] exit={exitCode}, {sw.ElapsedMilliseconds}ms");
        if (!string.IsNullOrWhiteSpace(stdErr))
            sb.AppendLine($"[docker] stderr: {TruncateLog(stdErr, 500)}");

        // 收集产物
        var html = CollectOutputHtml(outputDir, stdOut, sb);

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "completed", message = $"完成 {sw.ElapsedMilliseconds}ms" });

        CleanupWorkDir(workDir, logger);
        return new CapsuleResult(new List<ExecutionArtifact>
        {
            MakeTextArtifact(node, "cli-html-out", "生成页面", html, "text/html"),
            MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
        }, sb.ToString());
    }

    // ── 执行器 C: 外部 API ──

    private static async Task<CapsuleResult> ExecuteCliAgent_ApiAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        CliAgentContext ctx, StringBuilder sb, ILogger logger, EmitEventDelegate? emitEvent)
    {
        var endpoint = ReplaceVariables(GetConfigString(node, "apiEndpoint") ?? "", variables).Trim();
        var apiKey = ReplaceVariables(GetConfigString(node, "apiKey") ?? "", variables).Trim();

        if (string.IsNullOrWhiteSpace(endpoint))
            throw new InvalidOperationException("API 执行器需要配置 apiEndpoint");

        sb.AppendLine($"[api] 端点: {endpoint}");

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "running", message = $"调用 {endpoint}…" });

        var payload = new { ctx.Spec, ctx.Framework, ctx.Style, ctx.Prompt, ctx.SpecInput, ctx.PreviousOutput, ctx.UserFeedback, ctx.IsIteration };
        var httpFactory = sp.GetRequiredService<IHttpClientFactory>();
        using var http = httpFactory.CreateClient();
        if (!string.IsNullOrWhiteSpace(apiKey))
            http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        http.Timeout = TimeSpan.FromSeconds(ctx.TimeoutSeconds);

        var sw = Stopwatch.StartNew();
        var resp = await http.PostAsync(endpoint,
            new StringContent(JsonSerializer.Serialize(payload, JsonCompact), System.Text.Encoding.UTF8, "application/json"));
        var body = await resp.Content.ReadAsStringAsync();
        sw.Stop();

        sb.AppendLine($"[api] status={resp.StatusCode}, {sw.ElapsedMilliseconds}ms, body={body.Length}c");

        // 尝试从 JSON 响应中提取 html 字段
        var html = body;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("html", out var h))
                html = h.GetString() ?? body;
            else if (doc.RootElement.TryGetProperty("content", out var c))
                html = c.GetString() ?? body;
            else if (doc.RootElement.TryGetProperty("output", out var o))
                html = o.GetString() ?? body;
        }
        catch { /* 非 JSON，直接用 body */ }

        html = CleanHtmlFromLlmResponse(html);

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "completed", message = $"完成 {sw.ElapsedMilliseconds}ms" });

        return new CapsuleResult(new List<ExecutionArtifact>
        {
            MakeTextArtifact(node, "cli-html-out", "生成页面", html, "text/html"),
            MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
        }, sb.ToString());
    }

    // ── 执行器 D: Jint 脚本沙箱 ──

    private static CapsuleResult ExecuteCliAgent_Script(
        WorkflowNode node, CliAgentContext ctx, StringBuilder sb)
    {
        var code = GetConfigString(node, "scriptCode") ?? "";
        if (string.IsNullOrWhiteSpace(code))
            throw new InvalidOperationException("脚本执行器需要配置 scriptCode");

        sb.AppendLine($"[script] 脚本: {code.Length} chars");

        var engine = new Engine(options => options
            .LimitMemory(16_000_000)
            .LimitRecursion(256)
            .TimeoutInterval(TimeSpan.FromSeconds(Math.Min(ctx.TimeoutSeconds, 60))));

        var contextObj = JsonSerializer.Serialize(new { ctx.Spec, ctx.Framework, ctx.Style, ctx.Prompt, ctx.SpecInput, ctx.PreviousOutput, ctx.UserFeedback, ctx.IsIteration }, JsonCompact);
        engine.Execute($"var context = JSON.parse({JsonSerializer.Serialize(contextObj)}); var result = '';");

        engine.Execute(code);
        var result = engine.GetValue("result").AsString();
        sb.AppendLine($"[script] result: {result.Length} chars");

        if (!result.Contains("<html", StringComparison.OrdinalIgnoreCase))
            result = $"<!DOCTYPE html><html><head><meta charset='utf-8'></head><body>{result}</body></html>";

        return new CapsuleResult(new List<ExecutionArtifact>
        {
            MakeTextArtifact(node, "cli-html-out", "生成页面", result, "text/html"),
            MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
        }, sb.ToString());
    }

    // ── 执行器 E: Lobster（龙虾测试执行器，LLM 策略型） ──

    private static async Task<CapsuleResult> ExecuteCliAgent_LobsterAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
        CliAgentContext ctx, StringBuilder sb, ILogger logger, EmitEventDelegate? emitEvent)
    {
        var gateway = sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        var lobsterStyle = ReplaceVariables(GetConfigString(node, "lobsterStyle") ?? "professional", variables).Trim();
        sb.AppendLine($"[lobster] 龙虾执行器启动, style={lobsterStyle}");

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "running", message = "龙虾正在生成页面…" });

        // 龙虾策略：分阶段 prompt，先规划结构再生成代码
        var planPrompt = $@"你是一个产品着陆页架构师。根据以下需求，输出页面的章节结构（JSON 数组），每个元素包含 section（章节名）和 description（内容描述）。

需求：{(string.IsNullOrWhiteSpace(ctx.Prompt) ? "一个通用产品展示页" : ctx.Prompt)}
框架：{ctx.Framework}
风格：{lobsterStyle}

{(ctx.IsIteration ? $"用户反馈：{ctx.UserFeedback}\n请在已有结构基础上调整。" : "")}

只输出 JSON 数组，不要其他文字。";

        sb.AppendLine("[lobster] Phase 1: 规划结构");
        var planMessages = new System.Text.Json.Nodes.JsonArray
        {
            new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = planPrompt },
        };
        var planReq = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = "page-agent.generate::chat",
            ModelType = "chat",
            RequestBody = new System.Text.Json.Nodes.JsonObject { ["messages"] = planMessages },
        };
        var planResp = await gateway.SendAsync(planReq, CancellationToken.None);
        var plan = planResp?.Content ?? "[]";
        sb.AppendLine($"[lobster] 结构规划: {plan.Length} chars");

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "generating", message = "根据结构生成页面…" });

        // Phase 2: 根据结构生成完整 HTML
        var genSystemPrompt = BuildPageGenSystemPrompt(ctx);
        var genUserPrompt = new StringBuilder();
        genUserPrompt.AppendLine($"## 页面结构规划\n{plan}\n");
        if (!string.IsNullOrWhiteSpace(ctx.SpecInput))
            genUserPrompt.AppendLine($"## 产品规格\n{ctx.SpecInput}\n");
        if (!string.IsNullOrWhiteSpace(ctx.Prompt))
            genUserPrompt.AppendLine($"## 用户需求\n{ctx.Prompt}\n");
        if (ctx.IsIteration && !string.IsNullOrWhiteSpace(ctx.PreviousOutput))
        {
            genUserPrompt.AppendLine($"## 上轮结果\n```html\n{TruncateLog(ctx.PreviousOutput, 20000)}\n```\n");
            genUserPrompt.AppendLine($"## 修改意见\n{ctx.UserFeedback}\n");
            genUserPrompt.AppendLine("在上轮结果基础上增量修改，保留满意部分。");
        }
        else
        {
            genUserPrompt.AppendLine("根据结构规划和需求，生成完整的自包含 HTML 页面。");
        }

        sb.AppendLine("[lobster] Phase 2: 生成 HTML");
        var genMessages = new System.Text.Json.Nodes.JsonArray
        {
            new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = genSystemPrompt },
            new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = genUserPrompt.ToString() },
        };
        var genReq = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = "page-agent.generate::chat",
            ModelType = "chat",
            TimeoutSeconds = 300,
            RequestBody = new System.Text.Json.Nodes.JsonObject { ["messages"] = genMessages },
        };

        var sw = Stopwatch.StartNew();
        var genResp = await gateway.SendAsync(genReq, CancellationToken.None);
        sw.Stop();

        var html = CleanHtmlFromLlmResponse(genResp?.Content ?? "");
        sb.AppendLine($"[lobster] 生成完成: {html.Length} chars, {sw.ElapsedMilliseconds}ms");

        if (string.IsNullOrWhiteSpace(html) || !html.Contains("<html", StringComparison.OrdinalIgnoreCase))
            html = "<!DOCTYPE html><html><body><h1>龙虾执行器：LLM 未返回有效 HTML</h1></body></html>";

        if (emitEvent != null)
            await emitEvent("cli-agent-phase", new { phase = "completed", message = $"龙虾完成, {sw.ElapsedMilliseconds}ms" });

        return new CapsuleResult(new List<ExecutionArtifact>
        {
            MakeTextArtifact(node, "cli-html-out", "生成页面", html, "text/html"),
            MakeTextArtifact(node, "cli-files-out", "结构规划", plan, "application/json"),
            MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
        }, sb.ToString());
    }

    // ── CLI Agent 工具方法 ──

    /// <summary>从 output 目录收集 HTML，fallback 到 stdout</summary>
    private static string CollectOutputHtml(string outputDir, string stdOut, StringBuilder sb)
    {
        if (Directory.Exists(outputDir))
        {
            var files = Directory.GetFiles(outputDir, "*.html", SearchOption.AllDirectories);
            if (files.Length > 0)
            {
                var main = files.FirstOrDefault(f => Path.GetFileName(f) == "index.html") ?? files[0];
                sb.AppendLine($"  主入口: {Path.GetRelativePath(outputDir, main)}");
                return File.ReadAllText(main);
            }
        }
        if (!string.IsNullOrWhiteSpace(stdOut) && stdOut.Contains("<html", StringComparison.OrdinalIgnoreCase))
            return stdOut;
        return $"<!DOCTYPE html><html><body><pre>{System.Net.WebUtility.HtmlEncode(stdOut)}</pre></body></html>";
    }

    private static string TruncateLog(string log, int maxLength)
    {
        if (log.Length <= maxLength) return log;
        var half = maxLength / 2;
        return log[..half] + $"\n... [{log.Length - maxLength} truncated] ...\n" + log[^half..];
    }

    private static void CleanupWorkDir(string workDir, ILogger logger)
    {
        try { if (Directory.Exists(workDir)) Directory.Delete(workDir, true); }
        catch (Exception ex) { logger.LogWarning(ex, "CliAgent: cleanup failed {Dir}", workDir); }
    }

    // ── 短视频工作流 ──────────────────────────────────────────

    /// <summary>
    /// 短视频解析：调用 TikHub API 解析抖音/TikTok 链接，提取无水印视频地址和元数据。
    /// 自动识别链接特征：v.douyin.com, douyin.com, vm.tiktok.com, tiktok.com 等。
    /// </summary>
    public static async Task<CapsuleResult> ExecuteDouyinParserAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        var sb = new StringBuilder();
        var apiBaseUrl = ReplaceVariables(GetConfigString(node, "apiBaseUrl") ?? "https://tikhub.io/api/douyin", variables).TrimEnd('/');
        var apiKey = ReplaceVariables(GetConfigString(node, "apiKey") ?? "", variables).Trim();

        // 从配置或上游获取视频链接
        var videoUrl = ReplaceVariables(GetConfigString(node, "videoUrl") ?? "", variables).Trim();
        if (string.IsNullOrWhiteSpace(videoUrl))
        {
            var inputContent = inputArtifacts.FirstOrDefault(a => a.SlotId == "dp-in")?.InlineContent
                ?? inputArtifacts.FirstOrDefault()?.InlineContent;
            if (!string.IsNullOrWhiteSpace(inputContent))
            {
                // 尝试从 JSON 中提取 videoUrl 字段
                try
                {
                    using var doc = JsonDocument.Parse(inputContent);
                    videoUrl = doc.RootElement.TryGetProperty("videoUrl", out var vu) ? vu.GetString() ?? "" :
                               doc.RootElement.TryGetProperty("url", out var u) ? u.GetString() ?? "" :
                               doc.RootElement.TryGetProperty("link", out var l) ? l.GetString() ?? "" : "";
                    // 如果 JSON 解析出的还是空，尝试把整个输入当作 URL
                    if (string.IsNullOrWhiteSpace(videoUrl) && doc.RootElement.ValueKind == JsonValueKind.String)
                        videoUrl = doc.RootElement.GetString() ?? "";
                }
                catch
                {
                    // 非 JSON 格式，尝试从分享文本中提取视频链接
                    videoUrl = ExtractVideoUrlFromShareText(inputContent) ?? inputContent.Trim();
                }
            }
        }

        if (string.IsNullOrWhiteSpace(videoUrl))
            throw new InvalidOperationException("视频链接为空，请在配置或上游输入中提供 videoUrl");

        // 如果 videoUrl 不是有效 URL（可能是抖音分享文本），尝试提取其中的链接
        if (!videoUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            var extracted = ExtractVideoUrlFromShareText(videoUrl);
            if (!string.IsNullOrWhiteSpace(extracted))
            {
                sb.AppendLine($"[DouyinParser] 从分享文本中提取链接: {extracted}");
                videoUrl = extracted;
            }
        }

        // 识别链接平台特征
        var platform = DetectVideoPlatform(videoUrl);
        sb.AppendLine($"[DouyinParser] 链接: {videoUrl}");
        sb.AppendLine($"[DouyinParser] 识别平台: {platform}");

        if (string.IsNullOrWhiteSpace(apiKey))
            throw new InvalidOperationException("TikHub API 密钥未配置（apiKey）");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        if (apiKey.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", apiKey);
        else
            client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", $"Bearer {apiKey}");

        // 调用 TikHub 解析接口
        var requestUrl = $"{apiBaseUrl}/video_data?video_url={Uri.EscapeDataString(videoUrl)}";
        sb.AppendLine($"[DouyinParser] 请求: GET {requestUrl}");

        var response = await client.GetAsync(requestUrl, CancellationToken.None);
        var responseBody = await response.Content.ReadAsStringAsync(CancellationToken.None);

        sb.AppendLine($"[DouyinParser] 状态: {(int)response.StatusCode}");

        if (!response.IsSuccessStatusCode)
        {
            sb.AppendLine($"[DouyinParser] 错误响应: {responseBody[..Math.Min(500, responseBody.Length)]}");
            throw new InvalidOperationException($"TikHub API 请求失败 (HTTP {(int)response.StatusCode}): {responseBody[..Math.Min(200, responseBody.Length)]}");
        }

        // 解析响应，提取关键字段并标准化输出
        using var respDoc = JsonDocument.Parse(responseBody);
        var root = respDoc.RootElement;

        // TikHub API 响应结构可能嵌套在 data 里
        var dataElem = root.TryGetProperty("data", out var d) ? d : root;

        var outputObj = new
        {
            platform,
            originalUrl = videoUrl,
            videoUrl = TryGetJsonString(dataElem, "video_url", "video", "play_addr", "nwm_video_url"),
            coverUrl = TryGetJsonString(dataElem, "cover_url", "cover", "origin_cover"),
            title = TryGetJsonString(dataElem, "title", "desc", "description"),
            author = TryGetJsonString(dataElem, "author", "author_name", "nickname"),
            authorId = TryGetJsonString(dataElem, "author_id", "author_uid", "uid"),
            duration = TryGetJsonString(dataElem, "duration", "video_duration"),
            musicTitle = TryGetJsonString(dataElem, "music_title", "music"),
            statistics = TryGetJsonString(dataElem, "statistics", "stats"),
            hashtags = TryGetJsonString(dataElem, "hashtags", "text_extra"),
            rawResponse = responseBody,
        };

        sb.AppendLine($"[DouyinParser] 标题: {outputObj.title}");
        sb.AppendLine($"[DouyinParser] 作者: {outputObj.author}");
        sb.AppendLine($"[DouyinParser] 视频地址已提取: {(string.IsNullOrWhiteSpace(outputObj.videoUrl) ? "❌ 未找到" : "✅")}");

        var outputJson = JsonSerializer.Serialize(outputObj, JsonPretty);
        var artifact = MakeTextArtifact(node, "dp-out", "视频信息", outputJson, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
    }

    /// <summary>
    /// 视频下载到 COS：将视频 URL 下载并上传到对象存储，返回 COS 地址。
    /// </summary>
    public static async Task<CapsuleResult> ExecuteVideoDownloaderAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        var sb = new StringBuilder();

        // 获取视频 URL：优先配置，否则从上游 videoInfo 中提取
        var videoUrl = ReplaceVariables(GetConfigString(node, "videoUrl") ?? "", variables).Trim();
        if (string.IsNullOrWhiteSpace(videoUrl))
        {
            var inputContent = inputArtifacts.FirstOrDefault(a => a.SlotId == "vd-in")?.InlineContent
                ?? inputArtifacts.FirstOrDefault()?.InlineContent;
            if (!string.IsNullOrWhiteSpace(inputContent))
            {
                try
                {
                    using var doc = JsonDocument.Parse(inputContent);
                    videoUrl = TryGetJsonString(doc.RootElement, "videoUrl", "video_url", "play_addr", "nwm_video_url");
                }
                catch
                {
                    videoUrl = inputContent.Trim();
                }
            }
        }

        if (string.IsNullOrWhiteSpace(videoUrl))
            throw new InvalidOperationException("视频 URL 为空，无法下载");

        var timeoutSeconds = int.TryParse(GetConfigString(node, "timeoutSeconds"), out var ts) ? ts : 120;

        sb.AppendLine($"[VideoDownloader] 下载: {videoUrl}");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(timeoutSeconds);

        // 下载视频
        byte[] videoBytes;
        string? contentType;
        try
        {
            var response = await client.GetAsync(videoUrl, CancellationToken.None);
            response.EnsureSuccessStatusCode();
            videoBytes = await response.Content.ReadAsByteArrayAsync(CancellationToken.None);
            contentType = response.Content.Headers.ContentType?.MediaType ?? "video/mp4";
            sb.AppendLine($"[VideoDownloader] 下载完成: {videoBytes.Length} bytes, type={contentType}");
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"视频下载失败: {ex.Message}");
        }

        // 上传到 COS
        var assetStorage = sp.GetRequiredService<PrdAgent.Infrastructure.Services.AssetStorage.IAssetStorage>();
        var stored = await assetStorage.SaveAsync(videoBytes, contentType ?? "video/mp4", CancellationToken.None, domain: "workflow", type: "video-download");

        sb.AppendLine($"[VideoDownloader] ✅ COS 上传成功: {stored.Url}");
        sb.AppendLine($"[VideoDownloader] SHA256: {stored.Sha256}, 大小: {stored.SizeBytes} bytes");

        var output = JsonSerializer.Serialize(new
        {
            cosUrl = stored.Url,
            sha256 = stored.Sha256,
            fileSize = stored.SizeBytes,
            mimeType = stored.Mime,
            originalUrl = videoUrl,
        }, JsonPretty);

        var artifact = MakeTextArtifact(node, "vd-out", "下载结果", output, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
    }

    /// <summary>
    /// 视频内容转文本：从视频元数据提取或使用 LLM 分析视频内容。
    /// </summary>
    public static async Task<CapsuleResult> ExecuteVideoToTextAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts,
        EmitEventDelegate? emitEvent)
    {
        var sb = new StringBuilder();
        var extractMode = GetConfigString(node, "extractMode") ?? "metadata";

        var inputContent = inputArtifacts.FirstOrDefault(a => a.SlotId == "vt-in")?.InlineContent
            ?? inputArtifacts.FirstOrDefault()?.InlineContent;

        if (string.IsNullOrWhiteSpace(inputContent))
            throw new InvalidOperationException("上游视频信息为空");

        // 解析上游数据
        string title = "", description = "", author = "", duration = "", hashtags = "", rawTranscript = "";
        try
        {
            using var doc = JsonDocument.Parse(inputContent);
            var root = doc.RootElement;
            title = TryGetJsonString(root, "title", "desc") ?? "";
            description = TryGetJsonString(root, "description", "desc", "title") ?? "";
            author = TryGetJsonString(root, "author", "author_name", "nickname") ?? "";
            duration = TryGetJsonString(root, "duration", "video_duration") ?? "";
            hashtags = TryGetJsonString(root, "hashtags", "text_extra") ?? "";
            rawTranscript = TryGetJsonString(root, "transcript", "subtitles", "caption") ?? "";
        }
        catch
        {
            description = inputContent;
        }

        sb.AppendLine($"[VideoToText] 模式: {extractMode}");
        sb.AppendLine($"[VideoToText] 标题: {title}");

        if (extractMode == "llm")
        {
            // LLM 深度分析模式
            var systemPrompt = ReplaceVariables(GetConfigString(node, "systemPrompt") ?? "", variables);
            if (string.IsNullOrWhiteSpace(systemPrompt))
                systemPrompt = "你是一个短视频内容分析专家。请根据视频的标题、描述和其他元数据，输出结构化的内容分析。输出 JSON 格式，包含 title、transcript（推断的视频旁白/内容文字稿）、keyPoints（关键要点数组）、tags（话题标签数组）。";

            var userPrompt = $"请分析以下短视频内容：\n\n标题：{title}\n描述：{description}\n作者：{author}\n时长：{duration}\n话题标签：{hashtags}\n字幕/文字稿：{rawTranscript}";

            if (emitEvent != null)
                await emitEvent("capsule-progress", new { message = "使用 LLM 分析视频内容…" });

            var gateway = sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
            var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
            {
                AppCallerCode = "video-agent.video-to-text::chat",
                ModelType = "chat",
                RequestBody = new System.Text.Json.Nodes.JsonObject
                {
                    ["messages"] = new System.Text.Json.Nodes.JsonArray
                    {
                        new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                        new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userPrompt },
                    }
                }
            };

            var llmResponse = await gateway.SendAsync(request, CancellationToken.None);
            var llmContent = llmResponse.Content ?? "";
            sb.AppendLine($"[VideoToText] LLM 分析完成，输出长度: {llmContent.Length}");

            var artifact = MakeTextArtifact(node, "vt-out", "视频文本", llmContent, "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
        }
        else
        {
            // metadata 模式：直接结构化元数据
            var textContent = new
            {
                title,
                transcript = !string.IsNullOrWhiteSpace(rawTranscript) ? rawTranscript : description,
                description,
                author,
                duration,
                tags = hashtags,
            };

            sb.AppendLine($"[VideoToText] 元数据提取完成");

            var outputJson = JsonSerializer.Serialize(textContent, JsonPretty);
            var artifact = MakeTextArtifact(node, "vt-out", "视频文本", outputJson, "application/json");
            return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
        }
    }

    /// <summary>
    /// 文本转文案：使用 LLM 将视频文本改写为指定风格的文案。
    /// </summary>
    public static async Task<CapsuleResult> ExecuteTextToCopywritingAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts,
        EmitEventDelegate? emitEvent)
    {
        var sb = new StringBuilder();

        var style = GetConfigString(node, "style") ?? "share";
        var customPrompt = ReplaceVariables(GetConfigString(node, "customPrompt") ?? "", variables);
        var maxLengthStr = GetConfigString(node, "maxLength") ?? "500";
        var includeHashtags = GetConfigString(node, "includeHashtags") != "false";

        var inputContent = inputArtifacts.FirstOrDefault(a => a.SlotId == "tc-in")?.InlineContent
            ?? inputArtifacts.FirstOrDefault()?.InlineContent;

        if (string.IsNullOrWhiteSpace(inputContent))
            throw new InvalidOperationException("上游文本内容为空");

        // 构建 LLM 提示词
        var stylePrompts = new Dictionary<string, string>
        {
            ["share"] = "请将以下视频内容改写为轻松的分享推荐文案，口语化、有感染力，适合发朋友圈或微信群分享。",
            ["marketing"] = "请将以下视频内容改写为吸引点击的营销文案，制造好奇心，引导用户观看。使用数字、对比、设问等技巧。",
            ["summary"] = "请将以下视频内容改写为简洁客观的内容摘要，提取核心信息，结构清晰。",
            ["xiaohongshu"] = "请将以下视频内容改写为小红书种草风格的文案，多用 emoji 表情、感叹句，语气活泼可爱，加入种草推荐。",
            ["professional"] = "请将以下视频内容改写为专业分析文案，逻辑清晰，适合工作汇报或行业分析。",
        };

        var systemPrompt = style == "custom" && !string.IsNullOrWhiteSpace(customPrompt)
            ? customPrompt
            : stylePrompts.GetValueOrDefault(style, stylePrompts["share"]);

        systemPrompt += $"\n\n要求：\n- 文案不超过 {maxLengthStr} 字";
        if (includeHashtags)
            systemPrompt += "\n- 在文案末尾附上 3-5 个相关话题标签（格式：#标签#）";
        systemPrompt += "\n- 输出 JSON 格式：{\"title\": \"标题\", \"body\": \"正文内容\", \"hashtags\": [\"标签1\", \"标签2\"]}";

        sb.AppendLine($"[TextToCopywriting] 风格: {style}");

        if (emitEvent != null)
            await emitEvent("capsule-progress", new { message = $"使用 LLM 生成 {style} 风格文案…" });

        var gateway = sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = "video-agent.text-to-copy::chat",
            ModelType = "chat",
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = inputContent },
                }
            }
        };

        var llmResponse = await gateway.SendAsync(request, CancellationToken.None);
        var resultContent = llmResponse.Content ?? "";

        sb.AppendLine($"[TextToCopywriting] ✅ 文案生成完成，长度: {resultContent.Length}");

        var artifact = MakeTextArtifact(node, "tc-out", "文案", resultContent, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, sb.ToString());
    }

    // ── 短视频辅助方法 ──

    /// <summary>
    /// 识别视频链接所属平台。
    /// </summary>
    private static string DetectVideoPlatform(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return "unknown";
        var lower = url.ToLowerInvariant();

        // 抖音
        if (lower.Contains("douyin.com") || lower.Contains("v.douyin.com") || lower.Contains("iesdouyin.com"))
            return "douyin";
        // TikTok
        if (lower.Contains("tiktok.com") || lower.Contains("vm.tiktok.com"))
            return "tiktok";
        // 快手
        if (lower.Contains("kuaishou.com") || lower.Contains("v.kuaishou.com") || lower.Contains("gifshow.com"))
            return "kuaishou";
        // B站
        if (lower.Contains("bilibili.com") || lower.Contains("b23.tv"))
            return "bilibili";
        // 小红书
        if (lower.Contains("xiaohongshu.com") || lower.Contains("xhslink.com"))
            return "xiaohongshu";
        // 微博
        if (lower.Contains("weibo.com") || lower.Contains("weibo.cn"))
            return "weibo";
        // YouTube
        if (lower.Contains("youtube.com") || lower.Contains("youtu.be"))
            return "youtube";
        // 西瓜视频
        if (lower.Contains("ixigua.com"))
            return "xigua";

        return "unknown";
    }

    /// <summary>
    /// 从分享文本中提取视频平台链接。
    /// 支持抖音、TikTok、快手、B站、小红书等平台的分享口令文本。
    /// 例如："4.84 复制打开抖音...https://v.douyin.com/tLiSIq6JnNc/ aaa:/"
    /// </summary>
    private static string? ExtractVideoUrlFromShareText(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        // 视频平台域名关键词（按优先级排列）
        string[] videoDomains =
        [
            "douyin.com", "v.douyin.com", "iesdouyin.com",
            "tiktok.com", "vm.tiktok.com",
            "kuaishou.com", "v.kuaishou.com", "gifshow.com",
            "bilibili.com", "b23.tv",
            "xiaohongshu.com", "xhslink.com",
            "weibo.com", "weibo.cn",
            "youtube.com", "youtu.be",
            "ixigua.com",
        ];

        // 从文本中提取所有 URL
        var urlMatches = System.Text.RegularExpressions.Regex.Matches(text,
            @"https?://[^\s""'<>\]）》]+",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        foreach (System.Text.RegularExpressions.Match m in urlMatches)
        {
            var url = m.Value.TrimEnd('.', ',', ')', '>', '）', '》', ';', '/', ' ');
            // 补回被 TrimEnd 移除的必要尾部斜杠
            if (!url.EndsWith('/') && m.Value.TrimEnd().EndsWith('/'))
                url += '/';

            var lower = url.ToLowerInvariant();
            if (Array.Exists(videoDomains, d => lower.Contains(d)))
                return url;
        }

        return null;
    }

    /// <summary>
    /// 从 JsonElement 中尝试按多个候选 key 取字符串值。
    /// </summary>
    private static string TryGetJsonString(JsonElement element, params string[] candidateKeys)
    {
        foreach (var key in candidateKeys)
        {
            if (element.TryGetProperty(key, out var prop))
            {
                if (prop.ValueKind == JsonValueKind.String)
                    return prop.GetString() ?? "";
                if (prop.ValueKind != JsonValueKind.Null && prop.ValueKind != JsonValueKind.Undefined)
                    return prop.GetRawText();
            }
        }
        return "";
    }

    // ── 视频生成 ──────────────────────────────────────────────

    private static async Task<CapsuleResult> ExecuteVideoGenerationAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts,
        EmitEventDelegate? emitEvent)
    {
        var videoGenService = sp.GetRequiredService<PrdAgent.Core.Interfaces.IVideoGenService>();
        var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("CapsuleExecutor.VideoGeneration");
        var sb = new StringBuilder();

        // 从配置或上游输入获取文章内容
        var articleMarkdown = ReplaceVariables(GetConfigString(node, "articleMarkdown") ?? "", variables);
        var articleTitle = ReplaceVariables(GetConfigString(node, "articleTitle") ?? "", variables);
        var systemPrompt = ReplaceVariables(GetConfigString(node, "systemPrompt") ?? "", variables);
        var styleDescription = ReplaceVariables(GetConfigString(node, "styleDescription") ?? "", variables);
        var timeoutMinutesStr = GetConfigString(node, "timeoutMinutes") ?? "30";

        // 上游输入可覆盖 articleMarkdown
        var inputText = inputArtifacts.FirstOrDefault(a => a.SlotId == "vg-in")?.InlineContent;
        if (!string.IsNullOrWhiteSpace(inputText))
            articleMarkdown = inputText;

        if (string.IsNullOrWhiteSpace(articleMarkdown))
        {
            return new CapsuleResult(
                new List<ExecutionArtifact> { MakeTextArtifact(node, "vg-out", "错误", "{\"error\":\"文章内容为空\"}") },
                "文章内容为空，跳过视频生成");
        }

        if (!int.TryParse(timeoutMinutesStr, out var timeoutMinutes) || timeoutMinutes < 1)
            timeoutMinutes = 30;

        // 从工作流上下文获取真实用户 ID（由 WorkflowRunWorker 注入）
        var ownerAdminId = variables.GetValueOrDefault("__triggeredBy") ?? "workflow-system";
        var outputFormat = GetConfigString(node, "outputFormat") ?? "mp4";

        sb.AppendLine($"[VideoGeneration] 开始，文章长度={articleMarkdown.Length}，超时={timeoutMinutes}分钟，格式={outputFormat}，owner={ownerAdminId}");
        if (emitEvent != null)
            await emitEvent("capsule-progress", new { message = "创建视频生成任务…" });

        // 创建 run：AutoRender=true 跳过 Editing 直接渲染
        var request = new PrdAgent.Core.Models.CreateVideoGenRunRequest
        {
            ArticleMarkdown = articleMarkdown,
            ArticleTitle = articleTitle,
            SystemPrompt = systemPrompt,
            StyleDescription = styleDescription,
            AutoRender = true,
            OutputFormat = outputFormat,
        };

        string runId;
        try
        {
            runId = await videoGenService.CreateRunAsync("video-agent", ownerAdminId, request);
        }
        catch (ArgumentException ex)
        {
            sb.AppendLine($"[VideoGeneration] 创建失败: {ex.Message}");
            var errResult = JsonSerializer.Serialize(new { error = ex.Message }, JsonCompact);
            return new CapsuleResult(
                new List<ExecutionArtifact> { MakeTextArtifact(node, "vg-out", "错误", errResult) },
                sb.ToString());
        }

        sb.AppendLine($"[VideoGeneration] Run 已创建: {runId}");
        if (emitEvent != null)
            await emitEvent("capsule-progress", new { message = $"视频生成任务已创建: {runId}，等待完成…" });

        // 等待视频生成完成（轮询）
        var completedRun = await videoGenService.WaitForCompletionAsync(
            runId, TimeSpan.FromMinutes(timeoutMinutes), CancellationToken.None);

        if (completedRun == null)
        {
            sb.AppendLine("[VideoGeneration] 等待超时，任务未完成");
            var timeoutResult = JsonSerializer.Serialize(new { runId, status = "timeout", error = "等待超时" }, JsonCompact);
            return new CapsuleResult(
                new List<ExecutionArtifact> { MakeTextArtifact(node, "vg-out", "超时", timeoutResult) },
                sb.ToString());
        }

        sb.AppendLine($"[VideoGeneration] 任务完成: status={completedRun.Status}");

        var output = JsonSerializer.Serialize(new
        {
            runId = completedRun.Id,
            status = completedRun.Status,
            videoUrl = completedRun.VideoAssetUrl,
            totalDurationSeconds = completedRun.TotalDurationSeconds,
            scenesCount = completedRun.Scenes.Count,
            srtContent = completedRun.SrtContent,
            articleTitle = completedRun.ArticleTitle,
            errorMessage = completedRun.ErrorMessage,
        }, JsonCompact);

        return new CapsuleResult(
            new List<ExecutionArtifact> { MakeTextArtifact(node, "vg-out", "视频生成结果", output) },
            sb.ToString());
    }
}
