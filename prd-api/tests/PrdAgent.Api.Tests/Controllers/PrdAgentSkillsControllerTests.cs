using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Tests.TestHelpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class PrdAgentSkillsControllerTests
{
    [Fact]
    public async Task Execute_ShouldReject_WhenSessionOwnedByAnotherUser()
    {
        var skillService = new Mock<ISkillService>(MockBehavior.Strict);
        skillService.Setup(x => x.GetByKeyAsync("skill-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Skill
            {
                SkillKey = "skill-1",
                Title = "公开技能",
                Visibility = SkillVisibility.Public,
                IsEnabled = true,
                Execution = new SkillExecutionConfig { PromptTemplate = "模板" }
            });

        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        var runQueue = new Mock<IRunQueue>(MockBehavior.Strict);
        var sessionService = new Mock<ISessionService>(MockBehavior.Strict);
        sessionService.Setup(x => x.GetByIdAsync("session-1"))
            .ReturnsAsync(new Session
            {
                SessionId = "session-1",
                OwnerUserId = "owner-2",
                CurrentRole = UserRole.PM
            });

        var controller = CreateController(
            userId: "owner-1",
            skillService: skillService,
            runStore: runStore,
            runQueue: runQueue,
            sessionService: sessionService);

        var result = await controller.Execute("skill-1", new SkillExecuteRequest
        {
            SessionId = "session-1"
        }, CancellationToken.None);

        var response = AssertApiError(result, StatusCodes.Status403Forbidden);
        response.Error!.Code.ShouldBe(ErrorCodes.PERMISSION_DENIED);

        runStore.Verify(x => x.SetRunAsync(It.IsAny<string>(), It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Never);
        runQueue.Verify(x => x.EnqueueAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task Execute_ShouldReject_WhenEffectiveGroupRoleIsNotAllowed()
    {
        var groupMembers = MongoDbContextTestFactory.CreateCollectionReturning(new GroupMember
        {
            GroupId = "group-1",
            UserId = "user-1",
            MemberRole = UserRole.DEV
        });

        var skillService = new Mock<ISkillService>(MockBehavior.Strict);
        skillService.Setup(x => x.GetByKeyAsync("skill-qa", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Skill
            {
                SkillKey = "skill-qa",
                Title = "仅 QA 可用",
                Visibility = SkillVisibility.Public,
                IsEnabled = true,
                Roles = new List<UserRole> { UserRole.QA },
                Execution = new SkillExecutionConfig { PromptTemplate = "模板" }
            });

        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        var runQueue = new Mock<IRunQueue>(MockBehavior.Strict);
        var sessionService = new Mock<ISessionService>(MockBehavior.Strict);
        sessionService.Setup(x => x.GetByIdAsync("session-1"))
            .ReturnsAsync(new Session
            {
                SessionId = "session-1",
                GroupId = "group-1",
                CurrentRole = UserRole.PM
            });

        var controller = CreateController(
            userId: "user-1",
            db: MongoDbContextTestFactory.Create(groupMembers: groupMembers.Object),
            skillService: skillService,
            runStore: runStore,
            runQueue: runQueue,
            sessionService: sessionService);

        var result = await controller.Execute("skill-qa", new SkillExecuteRequest
        {
            SessionId = "session-1"
        }, CancellationToken.None);

        var response = AssertApiError(result, StatusCodes.Status403Forbidden);
        response.Error!.Code.ShouldBe(ErrorCodes.PERMISSION_DENIED);
        response.Error.Message.ShouldBe("当前角色无权执行此技能");

        runStore.Verify(x => x.SetRunAsync(It.IsAny<string>(), It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Never);
        runQueue.Verify(x => x.EnqueueAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task Execute_ShouldUseGroupMemberRole_WhenQueueingRun()
    {
        var groupMembers = MongoDbContextTestFactory.CreateCollectionReturning(new GroupMember
        {
            GroupId = "group-1",
            UserId = "user-1",
            MemberRole = UserRole.QA
        });

        RunMeta? capturedMeta = null;

        var skillService = new Mock<ISkillService>(MockBehavior.Strict);
        skillService.Setup(x => x.GetByKeyAsync("skill-qa", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Skill
            {
                SkillKey = "skill-qa",
                Title = "QA 技能",
                Visibility = SkillVisibility.Public,
                IsEnabled = true,
                Roles = new List<UserRole> { UserRole.QA },
                Input = new SkillInputConfig { ContextScope = "prd" },
                Output = new SkillOutputConfig { Mode = "chat" },
                Execution = new SkillExecutionConfig { PromptTemplate = "请总结" }
            });
        skillService.Setup(x => x.IncrementUsageAsync("skill-qa", It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        runStore.Setup(x => x.SetRunAsync(RunKinds.Chat, It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()))
            .Callback<string, RunMeta, TimeSpan?, CancellationToken>((_, meta, _, _) => capturedMeta = meta)
            .Returns(Task.CompletedTask);

        var runQueue = new Mock<IRunQueue>(MockBehavior.Strict);
        runQueue.Setup(x => x.EnqueueAsync(RunKinds.Chat, It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var sessionService = new Mock<ISessionService>(MockBehavior.Strict);
        sessionService.Setup(x => x.GetByIdAsync("session-1"))
            .ReturnsAsync(new Session
            {
                SessionId = "session-1",
                GroupId = "group-1",
                CurrentRole = UserRole.PM
            });

        var controller = CreateController(
            userId: "user-1",
            db: MongoDbContextTestFactory.Create(groupMembers: groupMembers.Object),
            skillService: skillService,
            runStore: runStore,
            runQueue: runQueue,
            sessionService: sessionService);

        var result = await controller.Execute("skill-qa", new SkillExecuteRequest
        {
            SessionId = "session-1",
            UserInput = "补充说明"
        }, CancellationToken.None);

        var ok = result.ShouldBeOfType<OkObjectResult>();
        ok.StatusCode.ShouldBe(StatusCodes.Status200OK);

        capturedMeta.ShouldNotBeNull();
        using var inputJson = JsonDocument.Parse(capturedMeta!.InputJson!);
        inputJson.RootElement.GetProperty("answerAsRole").GetString().ShouldBe(UserRole.QA.ToString());
        inputJson.RootElement.GetProperty("content").GetString().ShouldBe("【QA 技能】补充说明");

        runStore.Verify(x => x.SetRunAsync(RunKinds.Chat, It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Once);
        runQueue.Verify(x => x.EnqueueAsync(RunKinds.Chat, It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once);
        skillService.Verify(x => x.IncrementUsageAsync("skill-qa", It.IsAny<CancellationToken>()), Times.Once);
    }

    private static PrdAgentSkillsController CreateController(
        string userId,
        Mock<ISkillService> skillService,
        Mock<IRunEventStore> runStore,
        Mock<IRunQueue> runQueue,
        Mock<ISessionService> sessionService,
        MongoDbContext? db = null)
    {
        var controller = new PrdAgentSkillsController(
            db ?? MongoDbContextTestFactory.Create(),
            skillService.Object,
            runStore.Object,
            runQueue.Object,
            sessionService.Object,
            Mock.Of<ILlmGateway>(),
            Mock.Of<ILLMRequestContextAccessor>(),
            Mock.Of<ILogger<PrdAgentSkillsController>>());

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = BuildUser(userId)
            }
        };

        return controller;
    }

    private static ClaimsPrincipal BuildUser(string userId)
    {
        return new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("userId", userId),
            new Claim("sub", userId)
        }, "TestAuth"));
    }

    private static ApiResponse<object> AssertApiError(IActionResult result, int statusCode)
    {
        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(statusCode);
        return objectResult.Value.ShouldBeOfType<ApiResponse<object>>();
    }
}
