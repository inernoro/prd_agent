using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Mvc.Routing;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class TaskAdmissionPolicyTests
{
    [Theory]
    [InlineData("Bearer", null, "admin", TaskExecutionOrigins.Interactive)]
    [InlineData("Bearer", "jwt", "desktop", TaskExecutionOrigins.Interactive)]
    [InlineData("ApiKey", "agent-apikey", "admin", TaskExecutionOrigins.Agent)]
    [InlineData("AiAccessKey", "ai-access-key", "ai", TaskExecutionOrigins.Agent)]
    [InlineData("StableSmoke", "stable-smoke-signature", "stable-smoke", TaskExecutionOrigins.Agent)]
    public void Origin_ComesFromAuthenticatedClaims(string scheme, string? auth, string client, string expected)
    {
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, "actor"), new("clientType", client) };
        if (auth is not null) claims.Add(new("authType", auth));
        var user = new ClaimsPrincipal(new ClaimsIdentity(claims, scheme));
        Assert.Equal(expected, TaskAdmissionService.ResolveOrigin(user, "actor").Origin);
        Assert.Equal("actor", TaskAdmissionService.ResolveActor(user));
    }

    [Fact]
    public void RegisteredActions_AreRealEndpointsWithFiniteCapabilities()
    {
        var assembly = typeof(TaskAdmissionService).Assembly;
        foreach (var operation in TaskAdmissionPolicies.Operations)
        {
            var separator = operation.LastIndexOf('.');
            var typeName = operation[..separator];
            var action = operation[(separator + 1)..];
            var controller = assembly.GetType(typeName);
            Assert.True(controller is not null, $"准入控制器不存在：{operation}");
            var methods = controller!.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .Where(method => method.Name == action).ToArray();
            Assert.True(methods.Any(method => method.GetCustomAttributes<HttpMethodAttribute>().Any()),
                $"准入动作不是现有 HTTP 入口：{operation}");
            var policy = TaskAdmissionPolicies.Find(typeName, action)!;
            Assert.NotEmpty(policy.AppCallers);
            Assert.DoesNotContain("*", policy.AppCallers);
            Assert.InRange(policy.InteractiveMaxCalls, 1, GatewayTaskPermitRecord.MaximumCalls);
            Assert.Null(TaskAdmissionPolicies.Find(typeName, "FutureUnregisteredPaidAction"));
        }
    }

    [Fact]
    public void DelegatedSubjects_AreLimitedToExistingWorkflowManagementOperations()
    {
        var delegated = TaskAdmissionPolicies.Operations.Where(operation =>
        {
            var dot = operation.LastIndexOf('.');
            return TaskAdmissionPolicies.Find(operation[..dot], operation[(dot + 1)..])!.AllowDelegatedSubjects;
        }).ToArray();
        Assert.Equal(3, delegated.Length);
        Assert.All(delegated, operation => Assert.StartsWith(
            "PrdAgent.Api.Controllers.Api.WorkflowAgentController.", operation));
    }

    [Fact]
    public void MixedCrudAction_UsesExplicitPaidBranchAdmission_WhileExistingPaidActionsUseMiddleware()
    {
        const string reportController = "PrdAgent.Api.Controllers.Api.ReportAgentController";
        Assert.Equal(TaskAdmissionTiming.AuthenticatedPaidBranch,
            TaskAdmissionPolicies.Find(reportController, "CreateReport")!.Timing);
        Assert.Equal(TaskAdmissionTiming.Middleware,
            TaskAdmissionPolicies.Find(reportController, "GenerateReport")!.Timing);
        var onDemand = TaskAdmissionPolicies.Operations.Where(operation =>
        {
            var dot = operation.LastIndexOf('.');
            return TaskAdmissionPolicies.Find(operation[..dot], operation[(dot + 1)..])!.Timing
                == TaskAdmissionTiming.AuthenticatedPaidBranch;
        }).ToArray();
        Assert.Equal(new[]
        {
            "PrdAgent.Api.Controllers.GroupsController.Create",
            reportController + ".CreateReport",
            "PrdAgent.Api.Controllers.Api.DefectAgentController.StreamScores",
            "PrdAgent.Api.Controllers.Api.ReviewAgentController.StreamReviewResult",
            "PrdAgent.Api.Controllers.Api.MarketplaceSkillsController.Upload",
        }, onDemand);
        // 上传与重置评审仅处理普通数据，不能在模型调用之前要求治理库可用。
        Assert.Null(TaskAdmissionPolicies.Find("PrdAgent.Api.Controllers.Api.ReviewAgentController", "CreateSubmission"));
        Assert.Null(TaskAdmissionPolicies.Find("PrdAgent.Api.Controllers.Api.ReviewAgentController", "RerunSubmission"));
    }

    [Fact]
    public void NestedLoggingScope_CannotReplaceVerifiedOriginOrOperator()
    {
        var accessor = new LLMRequestContextAccessor();
        var verified = new LlmRequestContext("request", null, null, "subject", null, null, null, null,
            TaskPermitId: "server-permit", ExecutionOrigin: TaskExecutionOrigins.Agent,
            TriggerCredentialId: "agent:key-id", TriggerActorUserId: "actor",
            SourceDeployment: "branch", SourceTask: "registered-operation", SourceSystem: "map");
        using (accessor.BeginScope(verified))
        {
            using (accessor.BeginScope(verified with
            {
                TaskPermitId = "fake", ExecutionOrigin = TaskExecutionOrigins.Interactive,
                TriggerCredentialId = "fake", TriggerActorUserId = "fake", SourceSystem = "fake",
            }))
                Assert.Equal(verified, accessor.Current);
            Assert.Equal(verified, accessor.Current);
        }
        Assert.Null(accessor.Current);
    }
}
