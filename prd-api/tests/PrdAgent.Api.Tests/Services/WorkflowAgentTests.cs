using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 工作流引擎 (Workflow Agent) 单元测试
/// </summary>
public class WorkflowAgentTests
{
    #region Workflow Model Tests

    [Fact]
    public void Workflow_DefaultValues_ShouldBeCorrect()
    {
        var wf = new Workflow();

        Assert.NotNull(wf.Id);
        Assert.NotEmpty(wf.Id);
        Assert.Empty(wf.Name);
        Assert.Null(wf.Description);
        Assert.Empty(wf.Tags);
        Assert.Empty(wf.Nodes);
        Assert.Empty(wf.Edges);
        Assert.Empty(wf.Variables);
        Assert.Empty(wf.Triggers);
        Assert.True(wf.IsEnabled);
        Assert.Equal(0, wf.ExecutionCount);
        Assert.Null(wf.LastExecutedAt);
        Assert.True(wf.CreatedAt <= DateTime.UtcNow);
    }

    [Fact]
    public void Workflow_SetProperties_ShouldWork()
    {
        var wf = new Workflow
        {
            Name = "月度质量报告",
            Description = "自动化 TAPD 数据汇总",
            Tags = new List<string> { "tapd", "quality" },
            CreatedBy = "user123",
            CreatedByName = "张三"
        };

        Assert.Equal("月度质量报告", wf.Name);
        Assert.Equal("自动化 TAPD 数据汇总", wf.Description);
        Assert.Equal(2, wf.Tags.Count);
        Assert.Contains("tapd", wf.Tags);
        Assert.Equal("user123", wf.CreatedBy);
    }

    [Fact]
    public void Workflow_UniqueIds_ShouldBeGenerated()
    {
        var wf1 = new Workflow();
        var wf2 = new Workflow();
        Assert.NotEqual(wf1.Id, wf2.Id);
    }

    #endregion

    #region WorkflowNode Tests

    [Fact]
    public void WorkflowNode_DefaultValues_ShouldBeCorrect()
    {
        var node = new WorkflowNode();

        Assert.NotNull(node.NodeId);
        Assert.Equal(8, node.NodeId.Length);
        Assert.Empty(node.Name);
        Assert.Empty(node.NodeType);
        Assert.NotNull(node.Config);
        Assert.Empty(node.InputSlots);
        Assert.Empty(node.OutputSlots);
        Assert.Null(node.Position);
        Assert.Null(node.Retry);
    }

    [Fact]
    public void WorkflowNode_UniqueNodeIds()
    {
        var n1 = new WorkflowNode();
        var n2 = new WorkflowNode();
        Assert.NotEqual(n1.NodeId, n2.NodeId);
    }

    [Theory]
    [InlineData("data-collector", true)]
    [InlineData("script-executor", true)]
    [InlineData("llm-analyzer", true)]
    [InlineData("llm-code-executor", true)]
    [InlineData("renderer", true)]
    [InlineData("unknown-type", false)]
    [InlineData("", false)]
    public void WorkflowNodeTypes_Validation(string nodeType, bool shouldBeValid)
    {
        var isValid = WorkflowNodeTypes.All.Contains(nodeType);
        Assert.Equal(shouldBeValid, isValid);
    }

    [Fact]
    public void WorkflowNodeTypes_All_ShouldContainFiveTypes()
    {
        Assert.Equal(5, WorkflowNodeTypes.All.Length);
    }

    #endregion

    #region ArtifactSlot Tests

    [Fact]
    public void ArtifactSlot_DefaultValues()
    {
        var slot = new ArtifactSlot();

        Assert.Equal(8, slot.SlotId.Length);
        Assert.Empty(slot.Name);
        Assert.Equal("text", slot.DataType);
        Assert.True(slot.Required);
        Assert.Null(slot.Description);
    }

    [Theory]
    [InlineData("text")]
    [InlineData("json")]
    [InlineData("image")]
    [InlineData("binary")]
    public void ArtifactSlot_DataTypes_ShouldBeAssignable(string dataType)
    {
        var slot = new ArtifactSlot { DataType = dataType };
        Assert.Equal(dataType, slot.DataType);
    }

    #endregion

    #region WorkflowEdge Tests

    [Fact]
    public void WorkflowEdge_DefaultValues()
    {
        var edge = new WorkflowEdge();

        Assert.Equal(8, edge.EdgeId.Length);
        Assert.Empty(edge.SourceNodeId);
        Assert.Empty(edge.SourceSlotId);
        Assert.Empty(edge.TargetNodeId);
        Assert.Empty(edge.TargetSlotId);
    }

    [Fact]
    public void WorkflowEdge_CanConnect_TwoNodes()
    {
        var nodeA = new WorkflowNode { Name = "采集" };
        var nodeB = new WorkflowNode { Name = "分析" };
        var slotOut = new ArtifactSlot { Name = "output" };
        var slotIn = new ArtifactSlot { Name = "input" };

        var edge = new WorkflowEdge
        {
            SourceNodeId = nodeA.NodeId,
            SourceSlotId = slotOut.SlotId,
            TargetNodeId = nodeB.NodeId,
            TargetSlotId = slotIn.SlotId,
        };

        Assert.Equal(nodeA.NodeId, edge.SourceNodeId);
        Assert.Equal(nodeB.NodeId, edge.TargetNodeId);
    }

    #endregion

    #region WorkflowVariable Tests

    [Fact]
    public void WorkflowVariable_DefaultValues()
    {
        var v = new WorkflowVariable();

        Assert.Empty(v.Key);
        Assert.Empty(v.Label);
        Assert.Equal("string", v.Type);
        Assert.Null(v.DefaultValue);
        Assert.Null(v.Options);
        Assert.True(v.Required);
        Assert.False(v.IsSecret);
    }

    [Fact]
    public void WorkflowVariable_Secret_ShouldBeMarked()
    {
        var v = new WorkflowVariable
        {
            Key = "TAPD_TOKEN",
            Label = "TAPD API Token",
            IsSecret = true,
            Required = true,
        };

        Assert.True(v.IsSecret);
        Assert.True(v.Required);
    }

    #endregion

    #region WorkflowTrigger Tests

    [Fact]
    public void WorkflowTrigger_DefaultValues()
    {
        var t = new WorkflowTrigger();

        Assert.Equal(8, t.TriggerId.Length);
        Assert.Equal("manual", t.Type);
        Assert.Null(t.CronExpression);
        Assert.Equal("Asia/Shanghai", t.Timezone);
    }

    [Fact]
    public void WorkflowTrigger_CronType()
    {
        var t = new WorkflowTrigger
        {
            Type = WorkflowTriggerTypes.Cron,
            CronExpression = "0 9 1 * *",
            Timezone = "Asia/Shanghai"
        };

        Assert.Equal("cron", t.Type);
        Assert.Equal("0 9 1 * *", t.CronExpression);
    }

    #endregion

    #region WorkflowExecution Tests

    [Fact]
    public void WorkflowExecution_DefaultValues_ShouldBeCorrect()
    {
        var exec = new WorkflowExecution();

        Assert.NotNull(exec.Id);
        Assert.NotEmpty(exec.Id);
        Assert.Empty(exec.WorkflowId);
        Assert.Empty(exec.WorkflowName);
        Assert.Equal("manual", exec.TriggerType);
        Assert.Equal(WorkflowExecutionStatus.Queued, exec.Status);
        Assert.Empty(exec.Variables);
        Assert.Empty(exec.NodeSnapshot);
        Assert.Empty(exec.EdgeSnapshot);
        Assert.Empty(exec.NodeExecutions);
        Assert.Empty(exec.FinalArtifacts);
        Assert.Empty(exec.ShareLinkIds);
        Assert.Null(exec.StartedAt);
        Assert.Null(exec.CompletedAt);
        Assert.Null(exec.ErrorMessage);
        Assert.Equal(0, exec.LastSeq);
    }

    [Fact]
    public void WorkflowExecutionStatus_All_ShouldContainAllStatuses()
    {
        Assert.Contains(WorkflowExecutionStatus.Queued, WorkflowExecutionStatus.All);
        Assert.Contains(WorkflowExecutionStatus.Running, WorkflowExecutionStatus.All);
        Assert.Contains(WorkflowExecutionStatus.Completed, WorkflowExecutionStatus.All);
        Assert.Contains(WorkflowExecutionStatus.Failed, WorkflowExecutionStatus.All);
        Assert.Contains(WorkflowExecutionStatus.Cancelled, WorkflowExecutionStatus.All);
        Assert.Equal(5, WorkflowExecutionStatus.All.Length);
    }

    [Fact]
    public void WorkflowExecution_WithNodes_ShouldTrackAllNodes()
    {
        var exec = new WorkflowExecution
        {
            WorkflowId = "wf-001",
            WorkflowName = "测试工作流",
            NodeExecutions = new List<NodeExecution>
            {
                new() { NodeId = "a", NodeName = "采集", NodeType = WorkflowNodeTypes.DataCollector },
                new() { NodeId = "b", NodeName = "分析", NodeType = WorkflowNodeTypes.LlmAnalyzer },
                new() { NodeId = "c", NodeName = "渲染", NodeType = WorkflowNodeTypes.Renderer },
            }
        };

        Assert.Equal(3, exec.NodeExecutions.Count);
        Assert.All(exec.NodeExecutions, ne => Assert.Equal(NodeExecutionStatus.Pending, ne.Status));
    }

    #endregion

    #region NodeExecution Tests

    [Fact]
    public void NodeExecution_DefaultValues()
    {
        var ne = new NodeExecution();

        Assert.Empty(ne.NodeId);
        Assert.Equal(NodeExecutionStatus.Pending, ne.Status);
        Assert.Empty(ne.InputArtifactRefs);
        Assert.Empty(ne.OutputArtifacts);
        Assert.Null(ne.Logs);
        Assert.Equal(0, ne.AttemptCount);
        Assert.Null(ne.ErrorMessage);
    }

    [Fact]
    public void NodeExecution_StatusTransition()
    {
        var ne = new NodeExecution
        {
            NodeId = "node-001",
            NodeName = "数据采集",
            NodeType = WorkflowNodeTypes.DataCollector,
        };

        // pending → running
        ne.Status = NodeExecutionStatus.Running;
        ne.StartedAt = DateTime.UtcNow;
        Assert.Equal("running", ne.Status);

        // running → completed
        ne.Status = NodeExecutionStatus.Completed;
        ne.CompletedAt = DateTime.UtcNow;
        ne.DurationMs = (long)(ne.CompletedAt.Value - ne.StartedAt.Value).TotalMilliseconds;
        Assert.Equal("completed", ne.Status);
        Assert.NotNull(ne.DurationMs);
    }

    #endregion

    #region ExecutionArtifact Tests

    [Fact]
    public void ExecutionArtifact_DefaultValues()
    {
        var art = new ExecutionArtifact();

        Assert.Equal(32, art.ArtifactId.Length);
        Assert.Empty(art.Name);
        Assert.Equal("text/plain", art.MimeType);
        Assert.Null(art.InlineContent);
        Assert.Null(art.CosKey);
        Assert.Null(art.CosUrl);
        Assert.Equal(0, art.SizeBytes);
    }

    [Fact]
    public void ExecutionArtifact_InlineContent_ForSmallData()
    {
        var art = new ExecutionArtifact
        {
            Name = "stats.json",
            MimeType = "application/json",
            InlineContent = """{"totalBugs": 42}""",
            SizeBytes = 19,
        };

        Assert.NotNull(art.InlineContent);
        Assert.Null(art.CosKey);
        Assert.Equal(19, art.SizeBytes);
    }

    [Fact]
    public void ExecutionArtifact_CosStorage_ForLargeData()
    {
        var art = new ExecutionArtifact
        {
            Name = "report.html",
            MimeType = "text/html",
            CosKey = "workflow-agent/artifacts/exec123/final/report.html",
            CosUrl = "https://cdn.example.com/workflow-agent/artifacts/exec123/final/report.html",
            SizeBytes = 512_000,
        };

        Assert.Null(art.InlineContent);
        Assert.NotNull(art.CosKey);
        Assert.NotNull(art.CosUrl);
        Assert.Equal(512_000, art.SizeBytes);
    }

    #endregion

    #region ShareLink Tests

    [Fact]
    public void ShareLink_DefaultValues()
    {
        var link = new ShareLink();

        Assert.NotNull(link.Id);
        Assert.NotNull(link.Token);
        Assert.Equal(12, link.Token.Length);
        Assert.Equal("workflow-execution", link.ResourceType);
        Assert.Equal("public", link.AccessLevel);
        Assert.Null(link.Password);
        Assert.False(link.IsRevoked);
        Assert.Equal(0, link.ViewCount);
        Assert.Null(link.ExpiresAt);
    }

    [Fact]
    public void ShareLink_Token_ShouldBeUrlSafe()
    {
        var link = new ShareLink();

        // Token 不应包含 +, /, = (Base64 特殊字符)
        Assert.DoesNotContain("+", link.Token);
        Assert.DoesNotContain("/", link.Token);
        Assert.DoesNotContain("=", link.Token);
    }

    [Fact]
    public void ShareLink_UniqueTokens()
    {
        var tokens = Enumerable.Range(0, 100).Select(_ => new ShareLink().Token).ToHashSet();
        Assert.Equal(100, tokens.Count);
    }

    [Theory]
    [InlineData("public")]
    [InlineData("authenticated")]
    public void ShareLink_AccessLevels(string level)
    {
        var link = new ShareLink { AccessLevel = level };
        Assert.Equal(level, link.AccessLevel);
    }

    [Fact]
    public void ShareLink_Expiration()
    {
        var link = new ShareLink
        {
            ExpiresAt = DateTime.UtcNow.AddDays(30)
        };

        Assert.True(link.ExpiresAt > DateTime.UtcNow);
    }

    #endregion

    #region WorkflowSchedule Tests

    [Fact]
    public void WorkflowSchedule_DefaultValues()
    {
        var schedule = new WorkflowSchedule();

        Assert.NotNull(schedule.Id);
        Assert.Empty(schedule.WorkflowId);
        Assert.Empty(schedule.CronExpression);
        Assert.Equal("Asia/Shanghai", schedule.Timezone);
        Assert.True(schedule.IsEnabled);
        Assert.Null(schedule.NextRunAt);
        Assert.Equal(0, schedule.TriggerCount);
    }

    [Fact]
    public void WorkflowSchedule_CronConfig()
    {
        var schedule = new WorkflowSchedule
        {
            WorkflowId = "wf-001",
            CronExpression = "0 9 1 * *",
            Timezone = "Asia/Shanghai",
            NextRunAt = new DateTime(2026, 3, 1, 1, 0, 0, DateTimeKind.Utc), // 9:00 CST = 1:00 UTC
        };

        Assert.Equal("0 9 1 * *", schedule.CronExpression);
        Assert.NotNull(schedule.NextRunAt);
    }

    #endregion

    #region WorkflowSecret Tests

    [Fact]
    public void WorkflowSecret_DefaultValues()
    {
        var secret = new WorkflowSecret();

        Assert.NotNull(secret.Id);
        Assert.Empty(secret.WorkflowId);
        Assert.Empty(secret.Key);
        Assert.Empty(secret.EncryptedValue);
    }

    #endregion

    #region DAG Topology Tests

    [Fact]
    public void Workflow_LinearDAG_EdgesConnectSequentially()
    {
        // A → B → C → D
        var nodeA = new WorkflowNode { Name = "采集", NodeType = WorkflowNodeTypes.DataCollector };
        var nodeB = new WorkflowNode { Name = "分析", NodeType = WorkflowNodeTypes.LlmAnalyzer };
        var nodeC = new WorkflowNode { Name = "统计", NodeType = WorkflowNodeTypes.LlmCodeExecutor };
        var nodeD = new WorkflowNode { Name = "渲染", NodeType = WorkflowNodeTypes.Renderer };

        nodeA.OutputSlots.Add(new ArtifactSlot { Name = "data" });
        nodeB.InputSlots.Add(new ArtifactSlot { Name = "input" });
        nodeB.OutputSlots.Add(new ArtifactSlot { Name = "table" });
        nodeC.InputSlots.Add(new ArtifactSlot { Name = "input" });
        nodeC.OutputSlots.Add(new ArtifactSlot { Name = "stats" });
        nodeD.InputSlots.Add(new ArtifactSlot { Name = "input" });

        var wf = new Workflow
        {
            Name = "线性管线",
            Nodes = new List<WorkflowNode> { nodeA, nodeB, nodeC, nodeD },
            Edges = new List<WorkflowEdge>
            {
                new() { SourceNodeId = nodeA.NodeId, SourceSlotId = nodeA.OutputSlots[0].SlotId, TargetNodeId = nodeB.NodeId, TargetSlotId = nodeB.InputSlots[0].SlotId },
                new() { SourceNodeId = nodeB.NodeId, SourceSlotId = nodeB.OutputSlots[0].SlotId, TargetNodeId = nodeC.NodeId, TargetSlotId = nodeC.InputSlots[0].SlotId },
                new() { SourceNodeId = nodeC.NodeId, SourceSlotId = nodeC.OutputSlots[0].SlotId, TargetNodeId = nodeD.NodeId, TargetSlotId = nodeD.InputSlots[0].SlotId },
            }
        };

        Assert.Equal(4, wf.Nodes.Count);
        Assert.Equal(3, wf.Edges.Count);

        // 验证拓扑完整性：每个非首节点都有入边
        var targetNodeIds = wf.Edges.Select(e => e.TargetNodeId).ToHashSet();
        Assert.DoesNotContain(nodeA.NodeId, targetNodeIds); // 首节点无入边
        Assert.Contains(nodeB.NodeId, targetNodeIds);
        Assert.Contains(nodeC.NodeId, targetNodeIds);
        Assert.Contains(nodeD.NodeId, targetNodeIds);
    }

    [Fact]
    public void Workflow_ParallelDAG_MultipleInputsToOneNode()
    {
        //   A (Bug采集) ──→ C (统计)
        //   B (Story采集) ─→ C (统计)
        var nodeA = new WorkflowNode { Name = "Bug采集", NodeType = WorkflowNodeTypes.DataCollector };
        var nodeB = new WorkflowNode { Name = "Story采集", NodeType = WorkflowNodeTypes.DataCollector };
        var nodeC = new WorkflowNode { Name = "统计", NodeType = WorkflowNodeTypes.LlmCodeExecutor };

        nodeA.OutputSlots.Add(new ArtifactSlot { Name = "bugs" });
        nodeB.OutputSlots.Add(new ArtifactSlot { Name = "stories" });
        nodeC.InputSlots.Add(new ArtifactSlot { Name = "bugs" });
        nodeC.InputSlots.Add(new ArtifactSlot { Name = "stories" });

        var wf = new Workflow
        {
            Name = "并行采集",
            Nodes = new List<WorkflowNode> { nodeA, nodeB, nodeC },
            Edges = new List<WorkflowEdge>
            {
                new() { SourceNodeId = nodeA.NodeId, SourceSlotId = nodeA.OutputSlots[0].SlotId, TargetNodeId = nodeC.NodeId, TargetSlotId = nodeC.InputSlots[0].SlotId },
                new() { SourceNodeId = nodeB.NodeId, SourceSlotId = nodeB.OutputSlots[0].SlotId, TargetNodeId = nodeC.NodeId, TargetSlotId = nodeC.InputSlots[1].SlotId },
            }
        };

        // 验证节点 C 有两条入边
        var incomingToC = wf.Edges.Where(e => e.TargetNodeId == nodeC.NodeId).ToList();
        Assert.Equal(2, incomingToC.Count);
    }

    #endregion

    #region Resume From Node Tests

    [Fact]
    public void Execution_ResumeFromNode_PreservesCompletedNodes()
    {
        // 模拟 A(完成) → B(完成) → C(失败) → D(未执行)
        var exec = new WorkflowExecution
        {
            WorkflowId = "wf-001",
            NodeExecutions = new List<NodeExecution>
            {
                new() { NodeId = "a", NodeName = "采集", Status = NodeExecutionStatus.Completed,
                    OutputArtifacts = new List<ExecutionArtifact> { new() { Name = "data.json" } } },
                new() { NodeId = "b", NodeName = "分析", Status = NodeExecutionStatus.Completed,
                    OutputArtifacts = new List<ExecutionArtifact> { new() { Name = "table.json" } } },
                new() { NodeId = "c", NodeName = "统计", Status = NodeExecutionStatus.Failed,
                    ErrorMessage = "代码执行超时" },
                new() { NodeId = "d", NodeName = "渲染", Status = NodeExecutionStatus.Pending },
            }
        };

        // 从 C 重跑：A、B 应保留 completed，C、D 重置为 pending
        var resumeFromNodeId = "c";
        var targetFound = false;
        var newNodeExecutions = new List<NodeExecution>();

        foreach (var ne in exec.NodeExecutions)
        {
            if (ne.NodeId == resumeFromNodeId) targetFound = true;

            if (!targetFound && ne.Status == NodeExecutionStatus.Completed)
            {
                newNodeExecutions.Add(new NodeExecution
                {
                    NodeId = ne.NodeId,
                    NodeName = ne.NodeName,
                    Status = NodeExecutionStatus.Completed,
                    OutputArtifacts = ne.OutputArtifacts,
                });
            }
            else
            {
                newNodeExecutions.Add(new NodeExecution
                {
                    NodeId = ne.NodeId,
                    NodeName = ne.NodeName,
                    Status = NodeExecutionStatus.Pending,
                });
            }
        }

        Assert.Equal(NodeExecutionStatus.Completed, newNodeExecutions[0].Status); // A 保留
        Assert.Equal(NodeExecutionStatus.Completed, newNodeExecutions[1].Status); // B 保留
        Assert.Single(newNodeExecutions[0].OutputArtifacts);  // A 产物保留
        Assert.Single(newNodeExecutions[1].OutputArtifacts);  // B 产物保留
        Assert.Equal(NodeExecutionStatus.Pending, newNodeExecutions[2].Status);   // C 重置
        Assert.Equal(NodeExecutionStatus.Pending, newNodeExecutions[3].Status);   // D 重置
        Assert.Empty(newNodeExecutions[2].OutputArtifacts);   // C 产物清空
    }

    #endregion

    #region Permission Tests

    [Fact]
    public void AdminPermissionCatalog_WorkflowAgent_ShouldExist()
    {
        Assert.Equal("workflow-agent.use", AdminPermissionCatalog.WorkflowAgentUse);
        Assert.Equal("workflow-agent.manage", AdminPermissionCatalog.WorkflowAgentManage);
    }

    [Fact]
    public void AdminPermissionCatalog_All_ShouldContainWorkflowPermissions()
    {
        var keys = AdminPermissionCatalog.All.Select(p => p.Key).ToList();
        Assert.Contains(AdminPermissionCatalog.WorkflowAgentUse, keys);
        Assert.Contains(AdminPermissionCatalog.WorkflowAgentManage, keys);
    }

    #endregion

    #region RetryPolicy Tests

    [Fact]
    public void RetryPolicy_DefaultValues()
    {
        var policy = new RetryPolicy();
        Assert.Equal(1, policy.MaxAttempts);
        Assert.Equal(5, policy.DelaySeconds);
    }

    [Fact]
    public void RetryPolicy_CustomValues()
    {
        var policy = new RetryPolicy { MaxAttempts = 3, DelaySeconds = 10 };
        Assert.Equal(3, policy.MaxAttempts);
        Assert.Equal(10, policy.DelaySeconds);
    }

    #endregion

    #region NodePosition Tests

    [Fact]
    public void NodePosition_CanSetCoordinates()
    {
        var pos = new NodePosition { X = 100.5, Y = 200.3 };
        Assert.Equal(100.5, pos.X);
        Assert.Equal(200.3, pos.Y);
    }

    #endregion

    #region End-to-End Workflow Construction

    [Fact]
    public void TAPD_QualityReport_Workflow_FullConstruction()
    {
        // 构建完整的 TAPD 月度质量报告工作流
        var wf = new Workflow
        {
            Name = "月度质量会议报告",
            Description = "自动从 TAPD 拉取数据，分析统计后生成报告",
            Tags = new List<string> { "tapd", "quality", "monthly" },
            Variables = new List<WorkflowVariable>
            {
                new() { Key = "TARGET_MONTH", Label = "目标月份", Type = "string", DefaultValue = "{{now.year}}-{{now.month}}" },
                new() { Key = "TAPD_WORKSPACE_ID", Label = "TAPD 工作空间 ID", IsSecret = true },
            },
            Triggers = new List<WorkflowTrigger>
            {
                new() { Type = WorkflowTriggerTypes.Cron, CronExpression = "0 9 1 * *" },
                new() { Type = WorkflowTriggerTypes.Manual },
            },
        };

        // Node A: TAPD Bug 采集
        var nodeA = new WorkflowNode
        {
            Name = "TAPD Bug 数据采集",
            NodeType = WorkflowNodeTypes.DataCollector,
            OutputSlots = { new ArtifactSlot { Name = "bugs", DataType = "json" } }
        };

        // Node B: TAPD Story 采集
        var nodeB = new WorkflowNode
        {
            Name = "TAPD Story 数据采集",
            NodeType = WorkflowNodeTypes.DataCollector,
            OutputSlots = { new ArtifactSlot { Name = "stories", DataType = "json" } }
        };

        // Node C: LLM 分析 Bug 明细
        var nodeC = new WorkflowNode
        {
            Name = "Bug 明细结构化",
            NodeType = WorkflowNodeTypes.LlmAnalyzer,
            InputSlots = { new ArtifactSlot { Name = "rawBugs", DataType = "json" } },
            OutputSlots = { new ArtifactSlot { Name = "bugDetails", DataType = "json" } }
        };

        // Node D: LLM 分析 Story 明细
        var nodeD = new WorkflowNode
        {
            Name = "Story 明细结构化",
            NodeType = WorkflowNodeTypes.LlmAnalyzer,
            InputSlots = { new ArtifactSlot { Name = "rawStories", DataType = "json" } },
            OutputSlots = { new ArtifactSlot { Name = "storyDetails", DataType = "json" } }
        };

        // Node E: LLM 生成代码统计
        var nodeE = new WorkflowNode
        {
            Name = "统计汇总",
            NodeType = WorkflowNodeTypes.LlmCodeExecutor,
            InputSlots =
            {
                new ArtifactSlot { Name = "bugDetails", DataType = "json" },
                new ArtifactSlot { Name = "storyDetails", DataType = "json" },
            },
            OutputSlots = { new ArtifactSlot { Name = "stats", DataType = "json" } },
            Retry = new RetryPolicy { MaxAttempts = 3, DelaySeconds = 5 }
        };

        // Node F: 渲染报告
        var nodeF = new WorkflowNode
        {
            Name = "生成 HTML 报告",
            NodeType = WorkflowNodeTypes.Renderer,
            InputSlots = { new ArtifactSlot { Name = "stats", DataType = "json" } },
            OutputSlots =
            {
                new ArtifactSlot { Name = "htmlReport", DataType = "text" },
                new ArtifactSlot { Name = "mdReport", DataType = "text" },
            }
        };

        wf.Nodes = new List<WorkflowNode> { nodeA, nodeB, nodeC, nodeD, nodeE, nodeF };

        // 连线
        wf.Edges = new List<WorkflowEdge>
        {
            new() { SourceNodeId = nodeA.NodeId, SourceSlotId = nodeA.OutputSlots[0].SlotId, TargetNodeId = nodeC.NodeId, TargetSlotId = nodeC.InputSlots[0].SlotId },
            new() { SourceNodeId = nodeB.NodeId, SourceSlotId = nodeB.OutputSlots[0].SlotId, TargetNodeId = nodeD.NodeId, TargetSlotId = nodeD.InputSlots[0].SlotId },
            new() { SourceNodeId = nodeC.NodeId, SourceSlotId = nodeC.OutputSlots[0].SlotId, TargetNodeId = nodeE.NodeId, TargetSlotId = nodeE.InputSlots[0].SlotId },
            new() { SourceNodeId = nodeD.NodeId, SourceSlotId = nodeD.OutputSlots[0].SlotId, TargetNodeId = nodeE.NodeId, TargetSlotId = nodeE.InputSlots[1].SlotId },
            new() { SourceNodeId = nodeE.NodeId, SourceSlotId = nodeE.OutputSlots[0].SlotId, TargetNodeId = nodeF.NodeId, TargetSlotId = nodeF.InputSlots[0].SlotId },
        };

        // 验证
        Assert.Equal(6, wf.Nodes.Count);
        Assert.Equal(5, wf.Edges.Count);
        Assert.Equal(2, wf.Variables.Count);
        Assert.Equal(2, wf.Triggers.Count);

        // 验证所有边的节点引用合法
        var nodeIds = wf.Nodes.Select(n => n.NodeId).ToHashSet();
        Assert.All(wf.Edges, e =>
        {
            Assert.Contains(e.SourceNodeId, nodeIds);
            Assert.Contains(e.TargetNodeId, nodeIds);
        });

        // 验证根节点（无入边）
        var targetIds = wf.Edges.Select(e => e.TargetNodeId).ToHashSet();
        var rootNodes = wf.Nodes.Where(n => !targetIds.Contains(n.NodeId)).ToList();
        Assert.Equal(2, rootNodes.Count); // A 和 B 是根节点

        // 验证叶节点（无出边）
        var sourceIds = wf.Edges.Select(e => e.SourceNodeId).ToHashSet();
        var leafNodes = wf.Nodes.Where(n => !sourceIds.Contains(n.NodeId)).ToList();
        Assert.Single(leafNodes); // F 是叶节点
        Assert.Equal("生成 HTML 报告", leafNodes[0].Name);

        // 验证 Secret 变量
        var secrets = wf.Variables.Where(v => v.IsSecret).ToList();
        Assert.Single(secrets);
        Assert.Equal("TAPD_WORKSPACE_ID", secrets[0].Key);
    }

    #endregion
}
