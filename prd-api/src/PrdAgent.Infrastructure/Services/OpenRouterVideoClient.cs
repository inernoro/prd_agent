using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// OpenRouter 视频生成 API 客户端实现
/// 异步模型：Submit → JobId → Poll → VideoUrl
/// </summary>
public class OpenRouterVideoClient : IOpenRouterVideoClient
{
    private readonly HttpClient _http;
    private readonly ILogger<OpenRouterVideoClient> _logger;
    private readonly string? _apiKey;
    private readonly string _baseUrl;

    public OpenRouterVideoClient(HttpClient http, IConfiguration config, ILogger<OpenRouterVideoClient> logger)
    {
        _http = http;
        _logger = logger;
        _apiKey = config["OpenRouter:ApiKey"];
        _baseUrl = (config["OpenRouter:BaseUrl"] ?? "https://openrouter.ai/api/v1").TrimEnd('/');
    }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(_apiKey);

    public async Task<OpenRouterVideoSubmitResult> SubmitAsync(OpenRouterVideoSubmitRequest request, CancellationToken ct = default)
    {
        if (!IsConfigured)
        {
            return new OpenRouterVideoSubmitResult
            {
                Success = false,
                ErrorMessage = "OpenRouter API Key 未配置，请在后端环境变量 OPENROUTER_API_KEY 注入。"
            };
        }

        var body = new JsonObject
        {
            ["model"] = request.Model,
            ["prompt"] = request.Prompt
        };
        if (!string.IsNullOrWhiteSpace(request.AspectRatio)) body["aspect_ratio"] = request.AspectRatio;
        if (!string.IsNullOrWhiteSpace(request.Resolution)) body["resolution"] = request.Resolution;
        if (request.DurationSeconds.HasValue) body["duration"] = request.DurationSeconds.Value;
        if (request.GenerateAudio.HasValue) body["generate_audio"] = request.GenerateAudio.Value;
        if (request.Seed.HasValue) body["seed"] = request.Seed.Value;

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/videos");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        httpRequest.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

        try
        {
            using var resp = await _http.SendAsync(httpRequest, ct);
            var text = await resp.Content.ReadAsStringAsync(ct);

            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("OpenRouter 视频提交失败 status={Status} body={Body}",
                    (int)resp.StatusCode, Truncate(text, 500));
                return new OpenRouterVideoSubmitResult
                {
                    Success = false,
                    ErrorMessage = ExtractErrorMessage(text) ?? $"HTTP {(int)resp.StatusCode}"
                };
            }

            var doc = JsonNode.Parse(text)?.AsObject();
            var jobId = doc?["id"]?.GetValue<string>() ?? doc?["generation_id"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(jobId))
            {
                return new OpenRouterVideoSubmitResult
                {
                    Success = false,
                    ErrorMessage = "OpenRouter 响应缺少 id 字段"
                };
            }

            double? cost = null;
            if (doc?["usage"] is JsonObject usage && usage["cost"] is JsonNode costNode)
            {
                try { cost = costNode.GetValue<double>(); } catch { /* ignore */ }
            }

            return new OpenRouterVideoSubmitResult
            {
                Success = true,
                JobId = jobId,
                Cost = cost
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "OpenRouter 视频提交异常");
            return new OpenRouterVideoSubmitResult
            {
                Success = false,
                ErrorMessage = ex.Message
            };
        }
    }

    public async Task<OpenRouterVideoStatus> GetStatusAsync(string jobId, CancellationToken ct = default)
    {
        if (!IsConfigured)
        {
            return new OpenRouterVideoStatus
            {
                Status = "failed",
                ErrorMessage = "OpenRouter API Key 未配置"
            };
        }

        using var httpRequest = new HttpRequestMessage(HttpMethod.Get, $"{_baseUrl}/videos/{Uri.EscapeDataString(jobId)}");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        try
        {
            using var resp = await _http.SendAsync(httpRequest, ct);
            var text = await resp.Content.ReadAsStringAsync(ct);

            if (!resp.IsSuccessStatusCode)
            {
                return new OpenRouterVideoStatus
                {
                    Status = "failed",
                    ErrorMessage = ExtractErrorMessage(text) ?? $"HTTP {(int)resp.StatusCode}"
                };
            }

            var doc = JsonNode.Parse(text)?.AsObject();
            var status = doc?["status"]?.GetValue<string>()?.ToLowerInvariant() ?? "pending";

            string? videoUrl = null;
            if (doc?["unsigned_urls"] is JsonArray urls && urls.Count > 0)
            {
                videoUrl = urls[0]?.GetValue<string>();
            }

            string? errMsg = null;
            if (doc?["error"] is JsonNode errNode)
            {
                errMsg = errNode is JsonObject errObj
                    ? errObj["message"]?.GetValue<string>() ?? errObj.ToJsonString()
                    : errNode.ToString();
            }

            double? cost = null;
            if (doc?["usage"] is JsonObject usage && usage["cost"] is JsonNode costNode)
            {
                try { cost = costNode.GetValue<double>(); } catch { /* ignore */ }
            }

            return new OpenRouterVideoStatus
            {
                Status = status,
                VideoUrl = videoUrl,
                ErrorMessage = errMsg,
                Cost = cost
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "OpenRouter 视频状态查询异常 jobId={JobId}", jobId);
            return new OpenRouterVideoStatus
            {
                Status = "failed",
                ErrorMessage = ex.Message
            };
        }
    }

    private static string? ExtractErrorMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            var doc = JsonNode.Parse(body)?.AsObject();
            if (doc == null) return null;
            var err = doc["error"];
            if (err is JsonObject errObj)
            {
                return errObj["message"]?.GetValue<string>() ?? errObj.ToJsonString();
            }
            return err?.ToString();
        }
        catch
        {
            return Truncate(body, 200);
        }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
