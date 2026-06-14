using System.Linq;
using System.Collections.Generic;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 工作流自动配置核心：校验 + 自动接线 + 缺项扫描的回归测试。
/// 守护「AI 产出从草稿变可跑件」这条闭环不退化。
/// 设计依据：doc/design.workflow-auto-config.md
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
        Assert.Contains(r.Issues, i => i.Target == "n1" && i.Message.Contains("未知舱"));
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
        Assert.Contains(r.WireNotes, n => n.Contains("自动连接"));
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
