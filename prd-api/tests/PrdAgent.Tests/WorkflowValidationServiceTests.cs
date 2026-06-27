using System.Linq;
using System.Collections.Generic;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 工作流自动配置核心：校验 + 自动接线 + 缺项扫描的回归测试。
/// 守护「AI 产出从草稿变可跑件」这条闭环不退化。
/// 设计依据：doc/design.workflow-agent.auto-config.md
/// </summary>
public class WorkflowValidationServiceTests
{
    private readonly WorkflowValidationService _svc = new();

    private static WorkflowNode Node(string id, string type, Dictionary<string, object?>? config = null) => new()
    {
        NodeId = id,
        Name = id,
        NodeType = type,
        Config = config ?? new(),
    };

    [Fact]
    public void EmptyWorkflow_IsInvalid()
    {
        var g = new WorkflowChatGenerated { Nodes = new() };
        var r = _svc.Process(g);
        Assert.False(r.Valid);
        Assert.Contains(r.Issues, i => i.Target == "workflow");
    }

    [Fact]
    public void UnknownNodeType_ProducesIssue()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("n1", "not-a-real-capsule") },
        };
        var r = _svc.Process(g);
        Assert.False(r.Valid);
        Assert.Contains(r.Issues, i => i.Target == "n1" && i.Message.Contains("未知"));
    }

    [Fact]
    public void LegacyAliasNodeType_IsFlagged()
    {
        // data-collector 是旧别名，注册表无 meta/schema → 视为不可用，应报问题交自愈
        var g = new WorkflowChatGenerated { Nodes = new() { Node("n1", "data-collector") } };
        var r = _svc.Process(g);
        Assert.False(r.Valid);
        Assert.Contains(r.Issues, i => i.Target == "n1");
    }

    [Fact]
    public void DisabledCapsule_ProducesIssue()
    {
        // timer 标了 DisabledReason（开发中）→ 应判不可用
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("t1", CapsuleTypes.Timer) },
        };
        var r = _svc.Process(g);
        Assert.False(r.Valid);
        Assert.Contains(r.Issues, i => i.Target == "t1" && i.Message.Contains("暂未开放"));
    }

    [Fact]
    public void Slots_AreNormalizedToCapsuleDefaults()
    {
        // 故意给错误插槽，应被规范化为舱默认插槽
        var node = Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://x.com", ["method"] = "GET" });
        node.OutputSlots = new() { new() { SlotId = "garbage", DataType = "text" } };
        var g = new WorkflowChatGenerated { Nodes = new() { node } };

        _svc.Process(g);

        var outSlots = g.Nodes![0].OutputSlots;
        Assert.Contains(outSlots, s => s.SlotId == "http-out");
        Assert.DoesNotContain(outSlots, s => s.SlotId == "garbage");
    }

    [Fact]
    public void EdgeWithWrongSlotIds_IsRepaired_AndValid()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://x.com", ["method"] = "GET" }),
            },
            Edges = new()
            {
                new() { EdgeId = "e1", SourceNodeId = "m1", SourceSlotId = "wrong-out", TargetNodeId = "h1", TargetSlotId = "wrong-in" },
            },
        };

        var r = _svc.Process(g);

        Assert.True(r.Valid, "修复后应无结构问题：" + string.Join(";", r.Issues.Select(i => i.Message)));
        var edge = Assert.Single(g.Edges!);
        Assert.Equal("manual-out", edge.SourceSlotId);
        Assert.Equal("http-in", edge.TargetSlotId);
        Assert.NotEmpty(r.WireNotes);
    }

    [Fact]
    public void NoEdges_AutoChainsNodesInOrder()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://x.com", ["method"] = "GET" }),
            },
            Edges = new(),
        };

        var r = _svc.Process(g);

        Assert.True(r.Valid);
        var edge = Assert.Single(g.Edges!);
        Assert.Equal("m1", edge.SourceNodeId);
        Assert.Equal("h1", edge.TargetNodeId);
        Assert.Contains(r.WireNotes, n => n.Contains("自动补全"));
    }

    [Fact]
    public void DuplicateNodeId_ProducesIssue_AndDoesNotThrow()
    {
        // LLM 偶发同 nodeId：不能崩，应报结构问题
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("dup", CapsuleTypes.ManualTrigger),
                Node("dup", CapsuleTypes.HttpRequest, new() { ["url"] = "https://x.com", ["method"] = "GET" }),
            },
            Edges = new(),
        };

        var r = _svc.Process(g);   // 不抛异常
        Assert.False(r.Valid);
        Assert.Contains(r.Issues, i => i.Target == "dup" && i.Message.Contains("重复"));
    }

    [Fact]
    public void DuplicateVariableKeys_DoNotThrow()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("m1", CapsuleTypes.ManualTrigger) },
            Variables = new()
            {
                new() { Key = "token", Label = "T1", Required = true, IsSecret = true },
                new() { Key = "token", Label = "T2", Required = true, IsSecret = true },
            },
        };
        var r = _svc.Process(g);   // 不抛
        Assert.Contains(r.RequiredInputs, x => x.Key == "token");
    }

    [Fact]
    public void NullNodeConfig_DoesNotThrow()
    {
        var node = Node("h1", CapsuleTypes.HttpRequest);
        node.Config = null!;   // 模拟 "config": null
        var g = new WorkflowChatGenerated { Nodes = new() { node } };
        var r = _svc.Process(g);   // 不抛
        Assert.Contains(r.RequiredInputs, x => x.Key == "url");
    }

    [Fact]
    public void PartialEdges_OrphanNodeGetsWired()
    {
        // m1→h1 已连，h2 漏接：应被自动补一条上游
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://a.com", ["method"] = "GET" }),
                Node("h2", CapsuleTypes.HttpRequest, new() { ["url"] = "https://b.com", ["method"] = "GET" }),
            },
            Edges = new()
            {
                new() { SourceNodeId = "m1", SourceSlotId = "manual-out", TargetNodeId = "h1", TargetSlotId = "http-in" },
            },
        };

        var r = _svc.Process(g);
        Assert.True(r.Valid);
        Assert.Contains(g.Edges!, e => e.TargetNodeId == "h2");   // h2 不再是孤儿
    }

    [Fact]
    public void Merger_TwoRequiredInputs_BothAutoWired()
    {
        // data-merger 有两个必填输入槽，应各自接到不同上游（不能只连一个就判通过）
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("a", CapsuleTypes.HttpRequest, new() { ["url"] = "https://a.com", ["method"] = "GET" }),
                Node("b", CapsuleTypes.HttpRequest, new() { ["url"] = "https://b.com", ["method"] = "GET" }),
                Node("mg", CapsuleTypes.DataMerger),
            },
            Edges = new(),
        };

        var r = _svc.Process(g);
        var mergerIn = g.Edges!.Where(e => e.TargetNodeId == "mg").Select(e => e.TargetSlotId).ToHashSet();
        Assert.Contains("merge-in-1", mergerIn);
        Assert.Contains("merge-in-2", mergerIn);
        Assert.True(r.Valid, string.Join(";", r.Issues.Select(i => i.Message)));
    }

    [Fact]
    public void Merger_MissingSecondUpstream_FlaggedInvalid()
    {
        // 只有一个可用上游 → merge-in-2 补不上 → 必须报问题，不能静默通过
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("a", CapsuleTypes.HttpRequest, new() { ["url"] = "https://a.com", ["method"] = "GET" }),
                Node("mg", CapsuleTypes.DataMerger),
            },
            Edges = new(),
        };

        var r = _svc.Process(g);
        Assert.False(r.Valid);
        Assert.Contains(r.Issues, i => i.Target == "mg" && i.Message.Contains("缺少上游"));
    }

    [Fact]
    public void ConditionBranches_GetDistinctOutputSlots()
    {
        // condition 的两条出边即使 sourceSlotId 空/错，也要分到 cond-true / cond-false，
        // 不能都塌到第一个槽（否则 true/false 分支被一起激活/跳过）
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("cond", CapsuleTypes.Condition),
                Node("a", CapsuleTypes.HttpRequest, new() { ["url"] = "https://a.com", ["method"] = "GET" }),
                Node("b", CapsuleTypes.HttpRequest, new() { ["url"] = "https://b.com", ["method"] = "GET" }),
            },
            Edges = new()
            {
                new() { SourceNodeId = "m1", SourceSlotId = "manual-out", TargetNodeId = "cond", TargetSlotId = "cond-in" },
                new() { SourceNodeId = "cond", SourceSlotId = "", TargetNodeId = "a", TargetSlotId = "http-in" },
                new() { SourceNodeId = "cond", SourceSlotId = "", TargetNodeId = "b", TargetSlotId = "http-in" },
            },
        };

        var r = _svc.Process(g);
        var condOut = g.Edges!.Where(e => e.SourceNodeId == "cond").Select(e => e.SourceSlotId).ToList();
        Assert.Equal(2, condOut.Count);
        Assert.Equal(2, condOut.Distinct().Count());
        Assert.Contains("cond-true", condOut);
        Assert.Contains("cond-false", condOut);
    }

    [Fact]
    public void ConditionExplicitSameSlotFanout_IsPreserved()
    {
        // 两条出边都显式写成 cond-true（同槽 fan-out）是有意写法，运行时按 slot 激活全部出边 →
        // 不能擅自改派；只有省略/猜错才分流（见 ConditionBranches_GetDistinctOutputSlots）
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("cond", CapsuleTypes.Condition),
                Node("a", CapsuleTypes.HttpRequest, new() { ["url"] = "https://a.com", ["method"] = "GET" }),
                Node("b", CapsuleTypes.HttpRequest, new() { ["url"] = "https://b.com", ["method"] = "GET" }),
            },
            Edges = new()
            {
                new() { SourceNodeId = "m1", SourceSlotId = "manual-out", TargetNodeId = "cond", TargetSlotId = "cond-in" },
                new() { SourceNodeId = "cond", SourceSlotId = "cond-true", TargetNodeId = "a", TargetSlotId = "http-in" },
                new() { SourceNodeId = "cond", SourceSlotId = "cond-true", TargetNodeId = "b", TargetSlotId = "http-in" },
            },
        };

        var r = _svc.Process(g);
        var condOut = g.Edges!.Where(e => e.SourceNodeId == "cond").Select(e => e.SourceSlotId).ToList();
        Assert.Equal(2, condOut.Count);
        Assert.All(condOut, s => Assert.Equal("cond-true", s)); // 显式同槽 fan-out 原样保留
    }

    [Fact]
    public void Cycle_ProducesIssue()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("a", CapsuleTypes.HttpRequest, new() { ["url"] = "https://x.com", ["method"] = "GET" }),
                Node("b", CapsuleTypes.HttpRequest, new() { ["url"] = "https://y.com", ["method"] = "GET" }),
            },
            Edges = new()
            {
                new() { SourceNodeId = "a", SourceSlotId = "http-out", TargetNodeId = "b", TargetSlotId = "http-in" },
                new() { SourceNodeId = "b", SourceSlotId = "http-out", TargetNodeId = "a", TargetSlotId = "http-in" },
            },
        };

        var r = _svc.Process(g);
        Assert.Contains(r.Issues, i => i.Message.Contains("环"));
    }

    [Fact]
    public void MissingRequiredConfig_BecomesRequiredInput()
    {
        // http-request 缺 url（必填、无默认值）→ 缺项；method 有默认值 GET → 不算缺项
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("h1", CapsuleTypes.HttpRequest) },
        };

        var r = _svc.Process(g);

        Assert.Contains(r.RequiredInputs, x => x.Key == "url" && x.Scope == "config" && x.NodeId == "h1");
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "method");
    }

    [Fact]
    public void TapdCollector_CookieMode_RequiresCookieAndDscToken()
    {
        // authMode=cookie 时 cookie/dscToken 条件必填（schema 里是 Required=false）
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("t1", CapsuleTypes.TapdCollector, new()
                {
                    ["authMode"] = "cookie",
                    ["workspaceId"] = "50116108",
                    ["dataType"] = "bugs",
                }),
            },
        };

        var r = _svc.Process(g);
        // cookie(textarea)/dscToken(text) 类型不是 password，但按 key 判定应标 secret 并掩码
        Assert.Contains(r.RequiredInputs, x => x.Key == "cookie" && x.NodeId == "t1" && x.IsSecret && x.Type == "password");
        Assert.Contains(r.RequiredInputs, x => x.Key == "dscToken" && x.NodeId == "t1" && x.IsSecret);
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "authToken"); // basic 模式专用，不该出现
    }

    [Fact]
    public void RequiredSecretVariable_WithoutDefault_BecomesRequiredInput()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("m1", CapsuleTypes.ManualTrigger) },
            Variables = new()
            {
                new() { Key = "apiToken", Label = "API 令牌", Required = true, IsSecret = true },
            },
        };

        var r = _svc.Process(g);

        Assert.Contains(r.RequiredInputs, x => x.Key == "apiToken" && x.Scope == "variable" && x.IsSecret);
    }

    [Fact]
    public void DeclaredVariableReference_IsNotReportedMissing()
    {
        // url 引用已声明变量 → 不算缺项
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "{{endpoint}}", ["method"] = "GET" }) },
            Variables = new() { new() { Key = "endpoint", Label = "端点", Required = true, DefaultValue = "https://x.com" } },
        };

        var r = _svc.Process(g);
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "url");
    }

    [Fact]
    public void ReservedPlaceholders_AreNotReportedAsVariables()
    {
        // {{input}}（上游注入）/{{date}}（时间）是执行器保留占位，不能当缺项 surface
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("llm", CapsuleTypes.LlmAnalyzer, new() { ["userPromptTemplate"] = "分析这段数据：{{input}}，今天是 {{date}}" }),
            },
        };

        var r = _svc.Process(g);
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "input");
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "date");
    }

    [Fact]
    public void DeclaredVariable_ReferencedButNoDefaultNorRequired_IsSurfaced()
    {
        // 声明了 host 但没 required、没 defaultValue，配置里又引用了它 → 必须 surface，
        // 否则运行时会带着字面 {{host}} 跑
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://{{host}}/api", ["method"] = "GET" }) },
            Variables = new() { new() { Key = "host", Label = "主机", Required = false } },
        };

        var r = _svc.Process(g);
        Assert.Contains(r.RequiredInputs, x => x.Key == "host" && x.Scope == "variable");
    }

    [Fact]
    public void NestedJsonConfigPlaceholder_IsSurfacedAndNormalized()
    {
        // headers 是 JSON 对象，里面嵌 {{ api_token }} → 递归扫出并规范化
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("h1", CapsuleTypes.HttpRequest, new()
                {
                    ["url"] = "https://x.com",
                    ["method"] = "GET",
                    ["headers"] = new Dictionary<string, object?> { ["Authorization"] = "Bearer {{ api_token }}" },
                }),
            },
        };

        var r = _svc.Process(g);
        Assert.Contains(r.RequiredInputs, x => x.Key == "api_token" && x.Scope == "variable" && x.IsSecret);
        // 对象型 config 被序列化成 JSON 字符串（执行器用 GetConfigString 读），占位规范化为 {{api_token}}
        var headers = g.Nodes![0].Config["headers"];
        Assert.IsType<string>(headers);
        Assert.Contains("Bearer {{api_token}}", (string)headers!);
    }

    [Fact]
    public void TapdCustomCurl_SkipsCookieCredentialPrompts()
    {
        // 设了 customCurl（兜底路径）时不应再强求 cookie/dscToken
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("t1", CapsuleTypes.TapdCollector, new()
                {
                    ["authMode"] = "cookie",
                    ["workspaceId"] = "50116108",
                    ["dataType"] = "bugs",
                    ["customCurl"] = "curl 'https://tapd.cn/...' -H 'Cookie: xxx'",
                }),
            },
        };

        var r = _svc.Process(g);
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "cookie");
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "dscToken");
    }

    [Fact]
    public void SpacedPlaceholder_IsNormalizedToExactForm()
    {
        // {{ host }}（带空格）应被规范化成运行时认的 {{host}}，并仍 surface host
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://{{ host }}/api", ["method"] = "GET" }) },
        };

        var r = _svc.Process(g);
        Assert.Equal("https://{{host}}/api", g.Nodes![0].Config["url"]);
        Assert.Contains(r.RequiredInputs, x => x.Key == "host" && x.Scope == "variable");
    }

    [Fact]
    public void EmbeddedUndeclaredVariable_BecomesVariableInput()
    {
        // url 内嵌未声明变量 {{host}} → 应 surface 成可填变量，而不是当已填静默通过
        var g = new WorkflowChatGenerated
        {
            Nodes = new() { Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://{{host}}/api", ["method"] = "GET" }) },
        };

        var r = _svc.Process(g);
        Assert.Contains(r.RequiredInputs, x => x.Key == "host" && x.Scope == "variable");
        Assert.DoesNotContain(r.RequiredInputs, x => x.Key == "url");
    }

    [Fact]
    public void ValidLinearWorkflow_PassesClean()
    {
        var g = new WorkflowChatGenerated
        {
            Nodes = new()
            {
                Node("m1", CapsuleTypes.ManualTrigger),
                Node("h1", CapsuleTypes.HttpRequest, new() { ["url"] = "https://x.com", ["method"] = "GET" }),
            },
            Edges = new()
            {
                new() { SourceNodeId = "m1", SourceSlotId = "manual-out", TargetNodeId = "h1", TargetSlotId = "http-in" },
            },
        };

        var r = _svc.Process(g);
        Assert.True(r.Valid);
        Assert.Empty(r.RequiredInputs);
    }
}
