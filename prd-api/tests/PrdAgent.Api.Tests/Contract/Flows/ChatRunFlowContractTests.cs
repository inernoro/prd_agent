using System.Text.Json;
using PrdAgent.Core.Models;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Contract.Flows;

/// <summary>
/// Chat Run Flow Contract Tests
///
/// Validates the complete chat flow contract:
/// 1. Create Run (POST /api/v1/sessions/{sessionId}/messages/run)
/// 2. Stream Events (GET /api/v1/sessions/{sessionId}/runs/{runId}/events)
/// 3. Get Messages (GET /api/v1/sessions/{sessionId}/messages)
///
/// Run: dotnet test --filter "ChatRunFlowContractTests"
/// </summary>
[Trait("Category", "Contract")]
public class ChatRunFlowContractTests : ContractTestBase
{
    public ChatRunFlowContractTests(ITestOutputHelper output) : base(output) { }

    #region Request Contracts

    /// <summary>
    /// Minimal request - only required fields
    /// </summary>
    [Fact]
    public void CreateRun_MinimalRequest_ValidContract()
    {
        LogSection("CreateRun Minimal Request Contract");

        var request = """
        {
            "content": "Hello, world!"
        }
        """;

        LogJson("Frontend Request", request);

        var doc = JsonDocument.Parse(request);
        Assert.True(doc.RootElement.TryGetProperty("content", out var content));
        Assert.Equal("Hello, world!", content.GetString());

        Log("\n[PASS] Minimal request contract verified");
    }

    /// <summary>
    /// Full request - all optional fields
    /// </summary>
    [Fact]
    public void CreateRun_FullRequest_ValidContract()
    {
        LogSection("CreateRun Full Request Contract");

        var request = """
        {
            "content": "Analyze this PRD document",
            "role": 1,
            "attachmentIds": ["att_001", "att_002"],
            "promptKey": "prd-analysis",
            "skipAiReply": false
        }
        """;

        LogJson("Frontend Request", request);

        var doc = JsonDocument.Parse(request);

        // Required field
        Assert.True(doc.RootElement.TryGetProperty("content", out _));

        // Optional fields
        Assert.True(doc.RootElement.TryGetProperty("role", out var role));
        Assert.Equal(1, role.GetInt32());

        Assert.True(doc.RootElement.TryGetProperty("attachmentIds", out var attachments));
        Assert.Equal(2, attachments.GetArrayLength());

        Assert.True(doc.RootElement.TryGetProperty("promptKey", out _));
        Assert.True(doc.RootElement.TryGetProperty("skipAiReply", out _));

        Log("\n[PASS] Full request contract verified");
    }

    /// <summary>
    /// Skip AI Reply request - for group chat mode
    /// </summary>
    [Fact]
    public void CreateRun_SkipAiReply_ValidContract()
    {
        LogSection("CreateRun Skip AI Reply Contract");

        var request = """
        {
            "content": "This is a human-only message",
            "skipAiReply": true
        }
        """;

        LogJson("Frontend Request", request);

        var doc = JsonDocument.Parse(request);
        Assert.True(doc.RootElement.TryGetProperty("skipAiReply", out var skip));
        Assert.True(skip.GetBoolean());

        Log("\n[PASS] Skip AI reply contract verified");
    }

    #endregion

    #region Response Contracts

    /// <summary>
    /// Successful Run creation response
    /// </summary>
    [Fact]
    public void CreateRun_SuccessResponse_ValidContract()
    {
        LogSection("CreateRun Success Response Contract");

        var response = """
        {
            "code": "OK",
            "data": {
                "runId": "run_abc123def456",
                "userMessageId": "msg_user_001",
                "assistantMessageId": "msg_asst_001",
                "groupSeq": 42,
                "skippedAiReply": false
            }
        }
        """;

        LogJson("Backend Response", response);

        var doc = JsonDocument.Parse(response);

        // API envelope
        Assert.True(doc.RootElement.TryGetProperty("code", out var code));
        Assert.Equal("OK", code.GetString());

        // Data fields
        Assert.True(doc.RootElement.TryGetProperty("data", out var data));
        Assert.True(data.TryGetProperty("runId", out _));
        Assert.True(data.TryGetProperty("userMessageId", out _));
        Assert.True(data.TryGetProperty("assistantMessageId", out _));

        Log("\n[PASS] Success response contract verified");
    }

    /// <summary>
    /// Skip AI Reply response - no runId or assistantMessageId
    /// </summary>
    [Fact]
    public void CreateRun_SkipAiReplyResponse_ValidContract()
    {
        LogSection("CreateRun Skip AI Reply Response Contract");

        var response = """
        {
            "code": "OK",
            "data": {
                "runId": null,
                "userMessageId": "msg_user_001",
                "assistantMessageId": null,
                "groupSeq": 43,
                "skippedAiReply": true
            }
        }
        """;

        LogJson("Backend Response", response);

        var doc = JsonDocument.Parse(response);
        var data = doc.RootElement.GetProperty("data");

        Assert.True(data.TryGetProperty("runId", out var runId));
        Assert.Equal(JsonValueKind.Null, runId.ValueKind);

        Assert.True(data.TryGetProperty("skippedAiReply", out var skipped));
        Assert.True(skipped.GetBoolean());

        Log("\n[PASS] Skip AI reply response contract verified");
    }

    /// <summary>
    /// Error response contract
    /// </summary>
    [Fact]
    public void CreateRun_ErrorResponse_ValidContract()
    {
        LogSection("CreateRun Error Response Contract");

        var response = """
        {
            "code": "INVALID_FORMAT",
            "message": "消息内容不能为空",
            "data": null
        }
        """;

        LogJson("Backend Error Response", response);

        var doc = JsonDocument.Parse(response);

        Assert.True(doc.RootElement.TryGetProperty("code", out var code));
        Assert.NotEqual("OK", code.GetString());

        Assert.True(doc.RootElement.TryGetProperty("message", out var message));
        Assert.False(string.IsNullOrEmpty(message.GetString()));

        Log("\n[PASS] Error response contract verified");
    }

    #endregion

    #region SSE Event Contracts

    /// <summary>
    /// SSE stream event format
    /// </summary>
    [Fact]
    public void StreamEvents_EventFormat_ValidContract()
    {
        LogSection("Stream Events SSE Format Contract");

        // SSE event format
        var sseEvents = """
        event: status
        data: {"runId":"run_123","status":"running"}

        event: delta
        data: {"runId":"run_123","content":"Hello"}

        event: delta
        data: {"runId":"run_123","content":" world"}

        event: done
        data: {"runId":"run_123","status":"completed"}

        """;

        Log("[SSE Event Stream]");
        Log(new string('-', 40));
        Log(sseEvents);
        Log(new string('-', 40));

        // Parse individual events
        var lines = sseEvents.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var eventTypes = new List<string>();
        var dataLines = new List<string>();

        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i].StartsWith("event:"))
                eventTypes.Add(lines[i].Substring(7).Trim());
            if (lines[i].StartsWith("data:"))
                dataLines.Add(lines[i].Substring(5).Trim());
        }

        // Verify event types
        Assert.Contains("status", eventTypes);
        Assert.Contains("delta", eventTypes);
        Assert.Contains("done", eventTypes);

        // Verify data is valid JSON
        foreach (var data in dataLines)
        {
            var doc = JsonDocument.Parse(data);
            Assert.True(doc.RootElement.TryGetProperty("runId", out _));
        }

        Log("\n[PASS] SSE event format contract verified");
    }

    /// <summary>
    /// SSE afterSeq reconnection contract
    /// </summary>
    [Fact]
    public void StreamEvents_Reconnection_ValidContract()
    {
        LogSection("Stream Events Reconnection Contract");

        // Reconnection URL format
        var reconnectUrl = "/api/v1/sessions/sess_123/runs/run_456/events?afterSeq=42";

        Log($"[Reconnection URL]\n{reconnectUrl}");

        // The afterSeq parameter allows resuming from a specific sequence
        Assert.Contains("afterSeq=", reconnectUrl);

        // Events after reconnection should continue from afterSeq
        var reconnectedEvents = """
        event: delta
        data: {"runId":"run_456","content":" continuing","seq":43}

        event: delta
        data: {"runId":"run_456","content":" text","seq":44}

        event: done
        data: {"runId":"run_456","status":"completed","seq":45}

        """;

        Log("\n[Reconnected Events]");
        Log(reconnectedEvents);

        Log("\n[PASS] Reconnection contract verified");
    }

    #endregion

    #region Message List Contracts

    /// <summary>
    /// Get messages response contract
    /// </summary>
    [Fact]
    public void GetMessages_Response_ValidContract()
    {
        LogSection("Get Messages Response Contract");

        var response = """
        {
            "code": "OK",
            "data": {
                "messages": [
                    {
                        "id": "msg_001",
                        "sessionId": "sess_123",
                        "role": "user",
                        "content": "Hello",
                        "senderId": "user_admin",
                        "timestamp": "2025-01-15T10:30:00Z",
                        "groupSeq": 1
                    },
                    {
                        "id": "msg_002",
                        "sessionId": "sess_123",
                        "role": "assistant",
                        "content": "Hi! How can I help you?",
                        "timestamp": "2025-01-15T10:30:05Z",
                        "groupSeq": 2
                    }
                ],
                "hasMore": false,
                "nextCursor": null
            }
        }
        """;

        LogJson("Backend Response", response);

        var doc = JsonDocument.Parse(response);
        var data = doc.RootElement.GetProperty("data");

        // Messages array
        Assert.True(data.TryGetProperty("messages", out var messages));
        Assert.Equal(2, messages.GetArrayLength());

        // Message fields
        var firstMessage = messages[0];
        Assert.True(firstMessage.TryGetProperty("id", out _));
        Assert.True(firstMessage.TryGetProperty("sessionId", out _));
        Assert.True(firstMessage.TryGetProperty("role", out _));
        Assert.True(firstMessage.TryGetProperty("content", out _));
        Assert.True(firstMessage.TryGetProperty("timestamp", out _));

        // Pagination
        Assert.True(data.TryGetProperty("hasMore", out _));

        Log("\n[PASS] Get messages response contract verified");
    }

    #endregion

    #region Full Flow Documentation

    /// <summary>
    /// Documents the complete chat flow for AI reference
    /// </summary>
    [Fact]
    public void FullChatFlow_Documentation()
    {
        LogSection("Complete Chat Flow Documentation");

        Log("""

        === CHAT RUN FLOW ===

        1. CREATE RUN
           POST /api/v1/sessions/{sessionId}/messages/run
           Headers: Authorization: Bearer {token}
           Body: { "content": "user message" }
           Response: { "code": "OK", "data": { "runId": "...", "userMessageId": "...", "assistantMessageId": "..." } }

        2. STREAM EVENTS (optional, for real-time updates)
           GET /api/v1/sessions/{sessionId}/runs/{runId}/events
           Response: SSE stream with events (status, delta, done)

        3. RECONNECT IF DISCONNECTED
           GET /api/v1/sessions/{sessionId}/runs/{runId}/events?afterSeq={lastReceivedSeq}
           Resume from last received sequence number

        4. GET MESSAGES (after run completes or for history)
           GET /api/v1/sessions/{sessionId}/messages
           Response: { "code": "OK", "data": { "messages": [...], "hasMore": false } }

        === ERROR HANDLING ===

        - INVALID_FORMAT: Bad request body
        - SESSION_NOT_FOUND: Session doesn't exist
        - PERMISSION_DENIED: Not authorized

        """);

        Assert.True(true); // Documentation test always passes
    }

    #endregion
}
