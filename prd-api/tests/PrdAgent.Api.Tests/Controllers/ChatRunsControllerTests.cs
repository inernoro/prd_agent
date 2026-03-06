using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Tests.TestHelpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class ChatRunsControllerTests
{
    [Fact]
    public async Task CreateRun_ShouldReject_WhenSessionOwnedByAnotherUser()
    {
        var sessionService = new Mock<ISessionService>(MockBehavior.Strict);
        sessionService.Setup(x => x.GetByIdAsync("session-1"))
            .ReturnsAsync(new Session
            {
                SessionId = "session-1",
                OwnerUserId = "owner-2",
                CurrentRole = UserRole.PM
            });

        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        var runQueue = new Mock<IRunQueue>(MockBehavior.Strict);

        var controller = CreateController(
            userId: "owner-1",
            sessionService: sessionService,
            runStore: runStore,
            runQueue: runQueue);

        var result = await controller.CreateRun("session-1", new SendMessageRequest
        {
            Content = "hello"
        }, CancellationToken.None);

        var response = AssertApiError(result, StatusCodes.Status403Forbidden);
        response.Error!.Code.ShouldBe(ErrorCodes.PERMISSION_DENIED);

        runStore.Verify(x => x.SetRunAsync(It.IsAny<string>(), It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Never);
        runQueue.Verify(x => x.EnqueueAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetRun_ShouldReject_WhenRunSessionOwnedByAnotherUser()
    {
        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        runStore.Setup(x => x.GetRunAsync(RunKinds.Chat, "run-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RunMeta
            {
                RunId = "run-1",
                Kind = RunKinds.Chat,
                SessionId = "session-1",
                CreatedByUserId = "owner-1"
            });

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
            sessionService: sessionService,
            runStore: runStore);

        var result = await controller.GetRun("run-1", CancellationToken.None);

        var response = AssertApiError(result, StatusCodes.Status403Forbidden);
        response.Error!.Code.ShouldBe(ErrorCodes.PERMISSION_DENIED);
    }

    [Fact]
    public async Task Cancel_ShouldReject_WhenRunSessionOwnedByAnotherUser()
    {
        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        runStore.Setup(x => x.GetRunAsync(RunKinds.Chat, "run-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RunMeta
            {
                RunId = "run-1",
                Kind = RunKinds.Chat,
                SessionId = "session-1",
                CreatedByUserId = "owner-1"
            });

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
            sessionService: sessionService,
            runStore: runStore);

        var result = await controller.Cancel("run-1", CancellationToken.None);

        var response = AssertApiError(result, StatusCodes.Status403Forbidden);
        response.Error!.Code.ShouldBe(ErrorCodes.PERMISSION_DENIED);

        runStore.Verify(x => x.TryMarkCancelRequestedAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task Stream_ShouldWritePermissionDeniedEvent_WhenRunSessionOwnedByAnotherUser()
    {
        var runStore = new Mock<IRunEventStore>(MockBehavior.Strict);
        runStore.Setup(x => x.GetRunAsync(RunKinds.Chat, "run-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RunMeta
            {
                RunId = "run-1",
                Kind = RunKinds.Chat,
                SessionId = "session-1",
                CreatedByUserId = "owner-1"
            });

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
            sessionService: sessionService,
            runStore: runStore);

        var httpContext = controller.ControllerContext.HttpContext;
        var responseStream = new MemoryStream();
        httpContext.Response.Body = responseStream;

        await controller.Stream("run-1", afterSeq: 0, cancellationToken: CancellationToken.None);

        responseStream.Position = 0;
        var payload = Encoding.UTF8.GetString(responseStream.ToArray());
        payload.ShouldContain("event: error");
        payload.ShouldContain(ErrorCodes.PERMISSION_DENIED);
        payload.ShouldContain("无权限");
    }

    private static ChatRunsController CreateController(
        string userId,
        Mock<ISessionService> sessionService,
        Mock<IRunEventStore> runStore,
        Mock<IRunQueue>? runQueue = null,
        MongoDbContext? db = null)
    {
        var controller = new ChatRunsController(
            sessionService.Object,
            Mock.Of<IMessageRepository>(),
            Mock.Of<IGroupMessageSeqService>(),
            Mock.Of<IGroupMessageStreamHub>(),
            runStore.Object,
            (runQueue ?? new Mock<IRunQueue>(MockBehavior.Strict)).Object,
            db ?? MongoDbContextTestFactory.Create(),
            Mock.Of<ILogger<ChatRunsController>>());

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
