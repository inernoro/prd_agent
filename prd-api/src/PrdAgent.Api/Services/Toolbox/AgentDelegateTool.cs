using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models.AgentUniverse;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services.AgentTools;

namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// 把一个专业智能体包成通用对话智能体可以自己调用的工具。
///
/// 用户不必再先挑智能体：说清要做什么，通用体自己判断该不该转派、转派给谁。
/// 显式选择/@ 某个智能体的老路径原样保留，两条路走同一个真实组件。
///
/// 三条硬约束，缺一条这个类就变成了「另一个假智能体」：
/// 1. **只转发不仿冒**：一律路由到该智能体真实的 <see cref="IAgentAdapter"/>，
///    找不到就如实报错，绝不用提示词现编一个。
/// 2. **权限不放大**：走通用体调用和用户自己点进那个智能体，过同一道 `{agentKey}.use` 门。
///    通用体能调 ≠ 谁都能调。
/// 3. **调用身份不丢**：适配器内部要调网关，必须带着发起人的 UserId
///    （llm-gateway 规则；漏了会以 "User not found" 的形式炸在运行时）。
/// </summary>
public sealed class AgentDelegateTool : IAgentTool
{
    private readonly AgentCapability _capability;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<AgentDelegateTool> _logger;

    /// <summary>
    /// 单次转派的等待上限。超了如实说超时，不假装还在跑。
    /// 取 4 分钟对齐 ChatGenerateImageTool 的既有口径——工具调用是运行时的一次同步回调，
    /// 比它等更久只会先撞上运行时自己的超时，届时用户看到的是一条无来由的中断。
    /// </summary>
    private static readonly TimeSpan RunLimit = TimeSpan.FromMinutes(4);

    public AgentDelegateTool(
        AgentCapability capability,
        IServiceScopeFactory scopeFactory,
        ILogger<AgentDelegateTool> logger)
    {
        if (string.IsNullOrWhiteSpace(capability.ToolName))
            throw new ArgumentException(
                $"能力 {capability.AgentKey} 没有声明 ToolName，不该被包成工具", nameof(capability));

        _capability = capability;
        _scopeFactory = scopeFactory;
        _logger = logger;
        Descriptor = BuildDescriptor(capability);
    }

    public AgentToolDescriptor Descriptor { get; }

    /// <summary>
    /// 工具元数据全部由能力契约推导，不手写第二份。
    /// 契约改了描述自动跟着改，不会出现「注册表说它能做 A、工具描述还写着 B」。
    /// </summary>
    private static AgentToolDescriptor BuildDescriptor(AgentCapability capability) => new()
    {
        Name = capability.ToolName!,
        Description = $"{capability.Name}：{capability.Description}。{capability.ToolWhenToUse}",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["instruction"],
          "properties": {
            "instruction": {
              "type": "string",
              "description": "交给这个智能体的指令，说清要它做什么。"
            },
            "content": {
              "type": "string",
              "description": "可选。要处理的正文（文档全文、录音原文、缺陷描述等）。指令里已经写全了就不用给。"
            }
          }
        }
        """,
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        var instruction = ReadString(input, "instruction");
        if (string.IsNullOrWhiteSpace(instruction))
            return AgentToolInvokeResult.Fail("agent_instruction_required", "instruction 不能为空");

        var userId = (context.UserId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(userId))
            return AgentToolInvokeResult.Fail(
                "agent_user_context_required",
                $"调用「{_capability.Name}」需要一个明确的用户身份");

        using var scope = _scopeFactory.CreateScope();
        var provider = scope.ServiceProvider;

        // 权限门：与用户自己点进那个智能体走同一条判据。
        // isRoot 只能来自 HTTP claims，这里没有 claims 上下文，所以传 false ——
        // 结果是按用户自己的角色算权限（fail-closed）。宁可少给，不可放大。
        var permissions = await provider
            .GetRequiredService<IAdminPermissionService>()
            .GetEffectivePermissionsAsync(userId, isRoot: false, ct);
        var required = $"{_capability.AgentKey}.use";
        if (!permissions.Contains(AdminPermissionCatalog.Super) && !permissions.Contains(required))
        {
            return AgentToolInvokeResult.Fail(
                "agent_permission_denied",
                $"当前账号没有「{_capability.Name}」的使用权限（{required}），请联系管理员开通。");
        }

        // 真实组件。找不到就报错——绝不降级成提示词仿冒（AgentCapabilityRegistry 的注册前提）。
        var adapter = provider
            .GetServices<IAgentAdapter>()
            .FirstOrDefault(a => a.AgentKey == _capability.AgentKey
                                 && a.CanHandle(_capability.DefaultAction));
        if (adapter == null)
        {
            _logger.LogError(
                "[AgentDelegate] 能力已登记但没有真实适配器 agentKey={AgentKey} action={Action}",
                _capability.AgentKey, _capability.DefaultAction);
            return AgentToolInvokeResult.Fail(
                "agent_no_real_component",
                $"「{_capability.Name}」暂时不可用（缺少真实组件）");
        }

        var content = ReadString(input, "content");
        var execution = new AgentExecutionContext
        {
            RunId = Guid.NewGuid().ToString("N"),
            TraceId = string.IsNullOrWhiteSpace(context.RunId)
                ? "agent-delegate-" + Guid.NewGuid().ToString("N")
                : context.RunId,
            StepId = Guid.NewGuid().ToString("N"),
            UserId = userId,
            UserMessage = string.IsNullOrWhiteSpace(content)
                ? instruction!.Trim()
                : $"{instruction!.Trim()}\n\n[待处理内容]\n{content!.Trim()}",
            Action = _capability.DefaultAction,
            Input = new Dictionary<string, object>(),
        };

        // 适配器内部要调网关，UserId 必须在作用域里，否则网关访问控制层查不到人
        using var _llmScope = provider
            .GetRequiredService<ILLMRequestContextAccessor>()
            .BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: userId,
                ViewRole: null,
                DocumentChars: content?.Length,
                DocumentHash: null,
                SystemPromptRedacted: $"agent-delegate:{_capability.AgentKey}:{_capability.DefaultAction}",
                RequestType: _capability.InvokeMode,
                AppCallerCode: null));

        var text = new StringBuilder();
        var artifacts = new List<object>();
        string? failure = null;

        // 超时闸只有一个来源：我方自设的 RunLimit。**刻意不接入 InvokeAsync 的 ct** ——
        // 那条线连着 HTTP 连接，接上去就等于「客户端断开顺手掐掉服务端任务」（server-authority 禁止）。
        using var wait = new CancellationTokenSource(RunLimit);
        try
        {
            await foreach (var chunk in adapter.StreamExecuteAsync(execution, wait.Token))
            {
                switch (chunk.Type)
                {
                    case AgentChunkType.Text when !string.IsNullOrEmpty(chunk.Content):
                        text.Append(chunk.Content);
                        break;

                    case AgentChunkType.Artifact when chunk.Artifact != null:
                        artifacts.Add(new
                        {
                            kind = chunk.Artifact.Type.ToString().ToLowerInvariant(),
                            name = chunk.Artifact.Name,
                            url = chunk.Artifact.Url,
                            content = chunk.Artifact.Content,
                        });
                        break;

                    case AgentChunkType.Error:
                        failure = chunk.Content ?? "智能体执行失败";
                        break;
                }

                if (failure != null) break;
            }
        }
        catch (OperationCanceledException) when (wait.IsCancellationRequested)
        {
            return AgentToolInvokeResult.Fail(
                "agent_delegate_timeout",
                $"「{_capability.Name}」跑了超过 {RunLimit.TotalMinutes:F0} 分钟还没给结果，先跟用户说一声，稍后再试");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AgentDelegate] 转派失败 agentKey={AgentKey}", _capability.AgentKey);
            return AgentToolInvokeResult.Fail("agent_delegate_failed", $"「{_capability.Name}」执行异常");
        }

        if (failure != null)
            return AgentToolInvokeResult.Fail("agent_delegate_failed", failure);

        var output = text.ToString().Trim();
        if (output.Length == 0 && artifacts.Count == 0)
            return AgentToolInvokeResult.Fail(
                "agent_delegate_empty",
                $"「{_capability.Name}」没有产出内容，换个说法再试一次");

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            ok = true,
            agent = _capability.Name,
            output,
            artifacts,
            note = $"以上是「{_capability.Name}」的真实产出。转述给用户时说明这是它做的，不要冒充成你自己写的。",
        }));
    }

    private static string? ReadString(JsonElement input, string name)
    {
        if (input.ValueKind != JsonValueKind.Object) return null;
        if (!input.TryGetProperty(name, out var value)) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }
}
