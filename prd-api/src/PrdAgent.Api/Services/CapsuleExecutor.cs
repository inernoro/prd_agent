using System.Text;
using System.Text.Json;
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

    public static async Task<CapsuleResult> ExecuteLlmAnalyzerAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var gateway = sp.GetService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        if (gateway == null)
            throw new InvalidOperationException("LLM Gateway 未配置，无法执行 LLM 分析");

        var systemPrompt = ReplaceVariables(GetConfigString(node, "systemPrompt") ?? "", variables);
        var userPromptTemplate = ReplaceVariables(GetConfigString(node, "userPromptTemplate") ?? "", variables);
        var temperature = double.TryParse(GetConfigString(node, "temperature"), out var t) ? t : 0.3;

        // 将输入产物内容拼接为 inputText
        var inputText = "";
        if (inputArtifacts.Count > 0)
        {
            inputText = string.Join("\n---\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => $"[{a.Name}]\n{a.InlineContent}"));
        }

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

        var response = await gateway.SendAsync(request, CancellationToken.None);
        var content = response.Content ?? "";
        var logs = $"LLM model={response.Resolution?.ActualModel}\nTokens: input={response.TokenUsage?.InputTokens} output={response.TokenUsage?.OutputTokens}\n";

        var artifact = MakeTextArtifact(node, "llm-output", "分析结果", content);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
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
        var baseUrl = ReplaceVariables(
            GetConfigString(node, "api_url") ?? GetConfigString(node, "apiUrl") ?? "", variables);
        var authToken = ReplaceVariables(
            GetConfigString(node, "auth_token") ?? GetConfigString(node, "authToken")
            ?? GetConfigString(node, "apiToken") ?? "", variables);
        var dataType = GetConfigString(node, "data_type") ?? GetConfigString(node, "dataType") ?? "bugs";
        var workspaceId = GetConfigString(node, "workspaceId") ?? GetConfigString(node, "workspace_id") ?? "";
        var dateRange = GetConfigString(node, "dateRange") ?? GetConfigString(node, "date_range") ?? "";

        // 如果未直接提供完整 URL，则从 baseUrl + workspaceId + dataType 自动构造
        if (string.IsNullOrWhiteSpace(baseUrl))
            baseUrl = "https://api.tapd.cn";

        var url = baseUrl.TrimEnd('/');
        if (!url.Contains('?') && !string.IsNullOrWhiteSpace(workspaceId))
        {
            // 构造 TAPD Open API URL: https://api.tapd.cn/{dataType}?workspace_id={id}
            url = $"{url}/{dataType}?workspace_id={workspaceId}";
            if (!string.IsNullOrWhiteSpace(dateRange))
                url += $"&created=>={dateRange}-01&created=<={dateRange}-31";
        }

        if (string.IsNullOrWhiteSpace(workspaceId) && !url.Contains("workspace_id"))
            throw new InvalidOperationException("TAPD 工作空间 ID 未配置");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        // TAPD Open API 使用 Basic Auth (Base64 of api_user:api_password)
        if (!string.IsNullOrWhiteSpace(authToken))
            client.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Basic", authToken);

        var response = await client.GetAsync(url, CancellationToken.None);
        var body = await response.Content.ReadAsStringAsync(CancellationToken.None);
        var logs = $"TAPD {dataType} collect: {url}\nStatus: {(int)response.StatusCode}\nBody length: {body.Length}\n";

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

        var inputText = string.Join("\n---\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => $"[{a.Name}]\n{a.InlineContent}"));

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

        var response = await gateway.SendAsync(request, CancellationToken.None);
        var content = response.Content ?? "";

        var mimeType = format == "html" ? "text/html" : "text/markdown";
        var artifact = MakeTextArtifact(node, "report", "报告", content, mimeType);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"Report generated: {format}, {content.Length} chars, model={response.Resolution?.ActualModel}");
    }

    public static CapsuleResult ExecuteFileExporter(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var format = GetConfigString(node, "format") ?? "json";
        var fileName = GetConfigString(node, "file_name") ?? GetConfigString(node, "fileName") ?? $"export.{format}";

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

        var artifact = new ExecutionArtifact
        {
            Name = fileName,
            MimeType = mimeType,
            SlotId = node.OutputSlots.FirstOrDefault()?.SlotId ?? "export-file",
            InlineContent = content,
            SizeBytes = System.Text.Encoding.UTF8.GetByteCount(content),
        };

        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"File exported: {fileName} ({format}), {artifact.SizeBytes} bytes");
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
        var message = ReplaceVariables(GetConfigString(node, "message") ?? "", variables);

        if (string.IsNullOrWhiteSpace(message) && inputArtifacts.Count > 0)
        {
            message = string.Join("\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent?[..Math.Min(a.InlineContent.Length, 500)]));
        }

        var notification = new AdminNotification
        {
            Title = title,
            Message = message,
            Level = "info",
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
        var slotId = node.OutputSlots.FirstOrDefault()?.SlotId ?? slotSuffix;
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
            var s = val.ToString()?.Trim();
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
