using System.Text.Json;
using Microsoft.AspNetCore.Http;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.InfraConnections;

namespace PrdAgent.Api.Services.Toolbox.Adapters;

/// <summary>
/// CDS Agent 适配器：让 AI 百宝箱/智能体体系把任务委托给远程 CDS sandbox。
/// </summary>
public class CdsAgentAdapter : IAgentAdapter
{
    private readonly MongoDbContext _db;
    private readonly IInfraAgentSessionService _sessions;
    private readonly ILogger<CdsAgentAdapter> _logger;

    public CdsAgentAdapter(
        MongoDbContext db,
        IInfraAgentSessionService sessions,
        ILogger<CdsAgentAdapter> logger)
    {
        _db = db;
        _sessions = sessions;
        _logger = logger;
    }

    public string AgentKey => "cds-agent";

    public string DisplayName => "CDS Agent";

    public bool CanHandle(string action)
    {
        return action is "remote_task" or "code_audit" or "create_pr" or "execute";
    }

    public async Task<AgentExecutionResult> ExecuteAsync(
        AgentExecutionContext context,
        CancellationToken ct = default)
    {
        var content = new System.Text.StringBuilder();
        await foreach (var chunk in StreamExecuteAsync(context, ct))
        {
            if (chunk.Type == AgentChunkType.Text && !string.IsNullOrWhiteSpace(chunk.Content))
            {
                content.Append(chunk.Content);
            }
            if (chunk.Type == AgentChunkType.Error)
            {
                return AgentExecutionResult.Fail(chunk.Content ?? "CDS Agent 执行失败");
            }
        }
        return AgentExecutionResult.Ok(content.ToString());
    }

    public async IAsyncEnumerable<AgentStreamChunk> StreamExecuteAsync(
        AgentExecutionContext context,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        var recentHealthyCutoff = DateTime.UtcNow.Subtract(TimeSpan.FromMinutes(10));
        var connection = await _db.InfraConnections
            .Find(x => x.Partner == "cds"
                && (x.Status == "active"
                    || (x.LastProbeOk == true
                        && x.LastProbedAt != null
                        && x.LastProbedAt >= recentHealthyCutoff)))
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        if (connection == null)
        {
            yield return AgentStreamChunk.Error("没有 active CDS 连接，请先在系统设置中完成 CDS 长期授权");
            yield break;
        }

        var runtimeProfile = await _db.InfraAgentRuntimeProfiles
            .Find(x => x.IsDefault)
            .FirstOrDefaultAsync(ct)
            ?? await _db.InfraAgentRuntimeProfiles
                .Find(_ => true)
                .SortByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct);
        if (runtimeProfile == null)
        {
            yield return AgentStreamChunk.Error("没有系统级模型配置，请先配置 baseUrl、model 和 API key");
            yield break;
        }

        var title = context.Action switch
        {
            "code_audit" => "远程代码巡检",
            "create_pr" => "远程 PR 任务",
            _ => "远程 CDS Agent 任务"
        };

        yield return AgentStreamChunk.Text("正在创建 CDS 远程会话...\n");
        var session = await _sessions.CreateAsync(
            context.UserId,
            new CreateInfraAgentSessionRequest(
                connection.Id,
                runtimeProfile.Runtime,
                runtimeProfile.Model,
                title,
                "confirm-dangerous",
                null,
                runtimeProfile.Id),
            ct);
        yield return AgentStreamChunk.Text($"已创建 CDS 远程会话：{session.Id}\n");

        session = await _sessions.StartAsync(
            context.UserId,
            session.Id,
            new StartInfraAgentSessionRequest(runtimeProfile.Runtime, runtimeProfile.Model),
            ct) ?? session;
        yield return AgentStreamChunk.Text($"远程 runtime 已启动：{session.Runtime} / {session.Model}\n");

        var prompt = BuildRemotePrompt(context);
        yield return AgentStreamChunk.Text("正在发送远程任务并等待事件回放...\n");
        session = await _sessions.SendMessageAsync(
            context.UserId,
            session.Id,
            new SendInfraAgentMessageRequest(prompt),
            ct) ?? session;

        var events = await _sessions.ListEventsAsync(context.UserId, session.Id, 0, 500, ct);
        foreach (var evt in events)
        {
            var text = RenderEvent(evt);
            if (!string.IsNullOrWhiteSpace(text))
            {
                yield return AgentStreamChunk.Text(text + "\n");
            }
        }

        var eventsJson = JsonSerializer.Serialize(events, new JsonSerializerOptions { WriteIndented = true });
        var logs = await _sessions.GetLogsAsync(context.UserId, session.Id, ct) ?? string.Empty;
        yield return AgentStreamChunk.ArtifactChunk(new ToolboxArtifact
        {
            Type = ToolboxArtifactType.Json,
            Name = "CDS Agent 事件时间线",
            MimeType = "application/json",
            Content = eventsJson,
            SourceStepId = context.StepId
        });
        yield return AgentStreamChunk.ArtifactChunk(new ToolboxArtifact
        {
            Type = ToolboxArtifactType.Text,
            Name = "CDS Agent 运行日志",
            MimeType = "text/plain",
            Content = logs,
            SourceStepId = context.StepId
        });
        yield return AgentStreamChunk.Text($"CDS 会话状态：{session.Status}\n");

        if (string.Equals(session.Status, "failed", StringComparison.OrdinalIgnoreCase))
        {
            var reason = string.IsNullOrWhiteSpace(session.LastError)
                ? "远程 CDS Agent 会话执行失败，请查看事件时间线和运行日志"
                : session.LastError;
            yield return AgentStreamChunk.Error(reason);
            yield break;
        }

        yield return AgentStreamChunk.Done();
    }

    private static string BuildRemotePrompt(AgentExecutionContext context)
    {
        var userMessage = string.IsNullOrWhiteSpace(context.UserMessage)
            ? "执行远程任务"
            : context.UserMessage.Trim();

        if (context.Action is "code_audit" or "create_pr"
            || userMessage.Contains("巡检", StringComparison.OrdinalIgnoreCase)
            || userMessage.Contains("PR", StringComparison.OrdinalIgnoreCase))
        {
            return $"""
                你在远程 CDS sandbox 中作为代码巡检智能体工作。
                目标仓库：prd_agent。
                任务：{userMessage}

                验收标准：
                1. 检查仓库当前代码。
                2. 找到一个小而真实的问题。
                3. 修改并运行相关测试。
                4. 创建分支、提交、推送并提交 PR。
                5. 把 PR 链接、修改文件、测试结果返回 MAP。
                """;
        }

        return userMessage;
    }

    private static string RenderEvent(InfraAgentEventView evt)
    {
        try
        {
            using var doc = JsonDocument.Parse(evt.PayloadJson);
            var root = doc.RootElement;
            if (evt.Type == InfraAgentEventTypes.TextDelta && root.TryGetProperty("text", out var text))
            {
                return text.GetString() ?? string.Empty;
            }
            if (evt.Type == InfraAgentEventTypes.Done && root.TryGetProperty("finalText", out var finalText))
            {
                return finalText.GetString() ?? string.Empty;
            }
            if (evt.Type == InfraAgentEventTypes.ToolCall)
            {
                return $"工具调用：{root}";
            }
            if (evt.Type == InfraAgentEventTypes.ToolResult)
            {
                return $"工具结果：{root}";
            }
            if (evt.Type == InfraAgentEventTypes.Error)
            {
                return $"错误：{root}";
            }
        }
        catch
        {
            return evt.PayloadJson;
        }
        return string.Empty;
    }
}
