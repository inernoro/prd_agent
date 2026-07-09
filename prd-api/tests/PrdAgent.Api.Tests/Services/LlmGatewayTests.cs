using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;
using CoreGateway = PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// LLM Gateway 单元测试
/// 验证 Gateway 模式的核心功能：
/// 1. CreateClient 方法返回有效的 ILLMClient
/// 2. GatewayLLMClient 正确委托到 Gateway
/// 3. 三级模型调度逻辑正确触发
/// </summary>
public class LlmGatewayTests
{
    #region CreateClient Tests

    [Fact]
    public void CreateClient_ShouldReturnValidILLMClient()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(AppCallerRegistry.Admin.Lab.Chat, "chat");

        // Assert
        Assert.NotNull(client);
        Assert.IsAssignableFrom<ILLMClient>(client);
    }

    [Fact]
    public void CreateClient_WithCustomParameters_ShouldPreserveValues()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(
            AppCallerRegistry.Admin.Lab.Chat,
            "chat",
            maxTokens: 8192,
            temperature: 0.7);

        // Assert
        Assert.NotNull(client);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal(AppCallerRegistry.Admin.Lab.Chat, gatewayClient.AppCallerCode);
        Assert.Equal("chat", gatewayClient.ModelType);
        Assert.Equal(8192, gatewayClient.MaxTokens);
        Assert.Equal(0.7, gatewayClient.Temperature, precision: 2);
    }

    [Fact]
    public void CreateClient_ShouldSetDefaultValues()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(AppCallerRegistry.Admin.Lab.Chat, "chat");

        // Assert
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal(4096, gatewayClient.MaxTokens);
        Assert.Equal(0.2, gatewayClient.Temperature, precision: 2);
        Assert.True(gatewayClient.EnablePromptCache);
    }

    #endregion

    #region Interface Registration Tests

    [Fact]
    public void LlmGateway_ShouldImplementBothInterfaces()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Assert
        Assert.IsAssignableFrom<CoreGateway.ILlmGateway>(gateway);
        Assert.IsAssignableFrom<ILlmGateway>(gateway);
    }

    [Fact]
    public void LlmGateway_BothInterfaces_ShouldBeSameInstance()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var coreGateway = (CoreGateway.ILlmGateway)gateway;
        var infraGateway = (ILlmGateway)gateway;

        // Assert - 应该是同一个实例
        Assert.Same(coreGateway, infraGateway);
    }

    #endregion

    #region AppCallerCode Format Tests

    [Theory]
    [InlineData("prd-agent-desktop.chat.sendmessage::chat", true)]
    [InlineData("visual-agent.image.text2img::generation", true)]
    [InlineData("open-platform-agent.proxy::chat", true)]
    [InlineData("", false)]
    public void CreateClient_ShouldAcceptVariousAppCallerCodeFormats(string appCallerCode, bool shouldSucceed)
    {
        // Arrange
        var gateway = CreateTestGateway();
        // 从 appCallerCode 中提取 modelType（:: 后的部分）
        var modelType = "chat";
        if (!string.IsNullOrEmpty(appCallerCode) && appCallerCode.Contains("::"))
        {
            modelType = appCallerCode.Split("::").Last();
        }

        // Act & Assert
        if (shouldSucceed)
        {
            var client = gateway.CreateClient(appCallerCode, modelType);
            Assert.NotNull(client);
        }
        else
        {
            Assert.Throws<InvalidOperationException>(() => gateway.CreateClient(appCallerCode, modelType));
        }
    }

    [Theory]
    [InlineData("chat", "prd-agent-web.lab::chat")]
    [InlineData("vision", "prd-agent-web.lab::vision")]
    [InlineData("generation", "prd-agent-web.lab::generation")]
    [InlineData("intent", "visual-agent.image-gen.plan::intent")]
    public void CreateClient_ShouldAcceptAllModelTypes(string modelType, string appCallerCode)
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(appCallerCode, modelType);

        // Assert
        Assert.NotNull(client);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal(modelType, gatewayClient.ModelType);
    }

    #endregion

    #region GatewayLLMClient Properties Tests

    [Fact]
    public void GatewayLLMClient_ShouldExposeAppCallerCode()
    {
        // Arrange
        var gateway = CreateTestGateway();
        var expectedCode = AppCallerRegistry.Desktop.Chat.SendMessageChat;

        // Act
        var client = gateway.CreateClient(expectedCode, "chat");
        var gatewayClient = (GatewayLLMClient)client;

        // Assert
        Assert.Equal(expectedCode, gatewayClient.AppCallerCode);
    }

    [Fact]
    public void GatewayLLMClient_ShouldExposeModelType()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(AppCallerRegistry.VisualAgent.Image.Vision, "vision");
        var gatewayClient = (GatewayLLMClient)client;

        // Assert
        Assert.Equal("vision", gatewayClient.ModelType);
    }

    #endregion

    #region Model Type Constants Tests

    [Fact]
    public void ModelTypes_ShouldDefineAllStandardTypes()
    {
        // Assert
        Assert.Equal("chat", ModelTypes.Chat);
        Assert.Equal("vision", ModelTypes.Vision);
        Assert.Equal("generation", ModelTypes.ImageGen);
        Assert.Equal("intent", ModelTypes.Intent);
    }

    #endregion

    #region Thinking Isolation Tests

    /// <summary>
    /// 验证 IncludeThinking 默认为 false（思考内容默认不透传）
    /// 验证点 1/8：Gateway 默认行为
    /// </summary>
    [Fact]
    public void CreateClient_DefaultIncludeThinking_ShouldBeFalse()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(AppCallerRegistry.Admin.Lab.Chat, "chat");
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);

        // Assert - 默认不包含思考
        Assert.False(gatewayClient.IncludeThinking);
    }

    /// <summary>
    /// 验证 CreateClient 传递 includeThinking=true 时正确保留
    /// 验证点 2/8：Chat 模型显式启用思考
    /// </summary>
    [Fact]
    public void CreateClient_WithIncludeThinkingTrue_ShouldPreserveValue()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(
            AppCallerRegistry.Desktop.Chat.SendMessageChat,
            "chat",
            includeThinking: true);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);

        // Assert - 显式启用思考
        Assert.True(gatewayClient.IncludeThinking);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：IncludeThinking=false → 始终不透传
    /// 验证点 3/8：默认行为（所有 ModelType）
    /// </summary>
    [Theory]
    [InlineData("chat")]
    [InlineData("intent")]
    [InlineData("vision")]
    [InlineData("generation")]
    [InlineData("embedding")]
    [InlineData("rerank")]
    public void IsThinkingEffective_WhenIncludeThinkingFalse_ShouldAlwaysReturnFalse(string modelType)
    {
        // Act
        var result = LlmGateway.IsThinkingEffective(includeThinking: false, modelType);

        // Assert - 无论什么 ModelType，IncludeThinking=false 时始终不透传
        Assert.False(result);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：Intent 模型强制禁止思考
    /// 验证点 4/8：Intent 强制隔离（核心安全保障）
    /// </summary>
    [Theory]
    [InlineData("intent")]
    [InlineData("Intent")]
    [InlineData("INTENT")]
    public void IsThinkingEffective_WhenIntentModelType_ShouldAlwaysReturnFalse_RegardlessOfIncludeThinking(string modelType)
    {
        // Act - 即使 IncludeThinking=true，Intent 也强制禁止
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);

        // Assert
        Assert.False(result);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：Chat 模型 + IncludeThinking=true → 允许透传
    /// 验证点 5/8：推理场景正常启用思考
    /// </summary>
    [Theory]
    [InlineData("chat")]
    [InlineData("Chat")]
    public void IsThinkingEffective_WhenChatModelWithIncludeThinking_ShouldReturnTrue(string modelType)
    {
        // Act
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);

        // Assert - Chat 模型显式请求思考时允许透传
        Assert.True(result);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：Vision/Generation 等模型 + IncludeThinking=true → 允许透传
    /// 验证点 6/8：非 Intent 模型类型在显式请求时均允许思考
    /// </summary>
    [Theory]
    [InlineData("vision")]
    [InlineData("generation")]
    [InlineData("embedding")]
    [InlineData("code")]
    [InlineData("long-context")]
    public void IsThinkingEffective_WhenNonIntentModelWithIncludeThinking_ShouldReturnTrue(string modelType)
    {
        // Act
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);

        // Assert - 所有非 Intent 模型在 IncludeThinking=true 时均允许
        Assert.True(result);
    }

    /// <summary>
    /// 验证所有 Intent 类型的 AppCallerCode 注册都使用 Intent ModelType
    /// 验证点 7/8：确保 AppCallerRegistry 中所有 intent 调用者都被 Gateway 保护
    /// </summary>
    [Theory]
    [InlineData(AppCallerRegistry.Desktop.GroupName.SuggestIntent)]
    [InlineData(AppCallerRegistry.VisualAgent.Workspace.Title)]
    [InlineData(AppCallerRegistry.VisualAgent.ImageGen.Plan)]
    [InlineData(AppCallerRegistry.AiToolbox.Orchestration.Intent)]
    public void AllIntentAppCallerCodes_ShouldEndWithIntentSuffix(string appCallerCode)
    {
        // Assert - 所有 intent AppCallerCode 以 ::intent 结尾
        Assert.EndsWith("::intent", appCallerCode);

        // 验证 Gateway 会强制禁止这些调用者的思考输出
        var modelType = appCallerCode.Split("::").Last();
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);
        Assert.False(result);
    }

    /// <summary>
    /// 验证唯一启用思考的 AppCallerCode 是 Desktop Chat
    /// 验证点 8/8：只有聊天推理场景启用思考，其他场景默认关闭
    /// </summary>
    [Fact]
    public void OnlyChatServiceShouldEnableThinking()
    {
        // 目前唯一使用 includeThinking=true 的是 ChatService
        // AppCallerCode: prd-agent-desktop.chat.sendmessage::chat
        var appCallerCode = AppCallerRegistry.Desktop.Chat.SendMessageChat;

        // 验证该 AppCallerCode 的 ModelType 是 chat（不是 intent）
        Assert.EndsWith("::chat", appCallerCode);

        // 验证 chat ModelType + includeThinking=true 时思考允许透传
        Assert.True(LlmGateway.IsThinkingEffective(includeThinking: true, "chat"));

        // 验证 intent 即使被误配也会被拦截
        Assert.False(LlmGateway.IsThinkingEffective(includeThinking: true, "intent"));
    }

    #endregion

    #region OpenAIGatewayAdapter.BuildEndpoint Tests

    [Theory]
    // 标准 OpenAI 格式（无版本后缀）
    [InlineData("https://api.openai.com", "chat", "https://api.openai.com/v1/chat/completions")]
    [InlineData("https://api.openai.com/", "chat", "https://api.openai.com/v1/chat/completions")]
    [InlineData("https://api.deepseek.com", "chat", "https://api.deepseek.com/v1/chat/completions")]
    [InlineData("https://api.openai.com", "generation", "https://api.openai.com/v1/images/generations")]
    [InlineData("https://api.openai.com", "embedding", "https://api.openai.com/v1/embeddings")]
    [InlineData("https://api.openai.com", "intent", "https://api.openai.com/v1/chat/completions")]
    // 火山引擎格式（/api/v3 后缀）
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "chat", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "chat", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "intent", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "generation", "https://ark.cn-beijing.volces.com/api/v3/images/generations")]
    // /v1 后缀
    [InlineData("https://api.example.com/v1", "chat", "https://api.example.com/v1/chat/completions")]
    [InlineData("https://api.example.com/v1/", "chat", "https://api.example.com/v1/chat/completions")]
    // /v2 后缀
    [InlineData("https://api.example.com/v2", "chat", "https://api.example.com/v2/chat/completions")]
    [InlineData("https://api.example.com/api/v2", "chat", "https://api.example.com/api/v2/chat/completions")]
    public void BuildEndpoint_ShouldHandleVersionSuffixCorrectly(string apiBase, string modelType, string expected)
    {
        // Arrange
        var adapter = new OpenAIGatewayAdapter();

        // Act
        var result = adapter.BuildEndpoint(apiBase, modelType);

        // Assert
        Assert.Equal(expected, result);
    }

    [Fact]
    public void BuildEndpoint_Volces_ShouldNotDuplicateVersionPath()
    {
        // 回归测试：确保火山引擎不会产生 /api/v3/v1/chat/completions
        var adapter = new OpenAIGatewayAdapter();
        var baseUrl = "https://ark.cn-beijing.volces.com/api/v3";

        var endpoint = adapter.BuildEndpoint(baseUrl, "chat");

        Assert.Equal("https://ark.cn-beijing.volces.com/api/v3/chat/completions", endpoint);
        Assert.DoesNotContain("/v1/", endpoint);
    }

    [Fact]
    public void BuildEndpoint_OpenAI_ShouldAddV1Prefix()
    {
        // 标准 OpenAI 应该添加 /v1 前缀
        var adapter = new OpenAIGatewayAdapter();
        var baseUrl = "https://api.openai.com";

        var endpoint = adapter.BuildEndpoint(baseUrl, "chat");

        Assert.Equal("https://api.openai.com/v1/chat/completions", endpoint);
        Assert.Contains("/v1/", endpoint);
    }

    #endregion

    #region Vision image_url.detail Tests

    // 守护"识图不准"根因修复：LLMAttachment 的图片必须把 detail 透传进 image_url，
    // 默认 "high"（避免上游默认 "auto" 低保真）；调用方显式传则用调用方的值。
    // BuildRequestBody 为私有，走反射调用。
    private static JsonObject InvokeBuildRequestBody(GatewayLLMClient client, List<LLMMessage> messages)
    {
        var m = typeof(GatewayLLMClient).GetMethod(
            "BuildRequestBody",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        Assert.NotNull(m);
        return (JsonObject)m!.Invoke(client, new object[] { string.Empty, messages })!;
    }

    private static JsonObject? FindImageUrlObject(JsonObject body)
    {
        var messages = body["messages"] as JsonArray;
        if (messages == null) return null;
        foreach (var msg in messages)
        {
            if (msg is not JsonObject mo) continue;
            if (mo["content"] is not JsonArray content) continue;
            foreach (var part in content)
            {
                if (part is JsonObject po && (string?)po["type"] == "image_url")
                    return po["image_url"] as JsonObject;
            }
        }
        return null;
    }

    private static GatewayLLMClient NewVisionClient()
    {
        var gateway = CreateTestGateway();
        // 必须用「注册了 vision modelType」的 appCaller，否则 CreateClient 的
        // TryValidateAppCaller 会因 modelType 不匹配抛异常（Admin.Lab.Chat 只注册了 chat）。
        return Assert.IsType<GatewayLLMClient>(
            gateway.CreateClient(AppCallerRegistry.Admin.Lab.Vision, "vision"));
    }

    [Fact]
    public void BuildRequestBody_ImageAttachmentWithoutDetail_DefaultsToHigh()
    {
        var client = NewVisionClient();
        var messages = new List<LLMMessage>
        {
            new()
            {
                Role = "user",
                Content = "这张图里有什么？",
                Attachments = new List<LLMAttachment>
                {
                    new() { Type = "image", Url = "https://example.com/a.png" }
                }
            }
        };

        var body = InvokeBuildRequestBody(client, messages);
        var imageUrl = FindImageUrlObject(body);

        Assert.NotNull(imageUrl);
        Assert.Equal("https://example.com/a.png", (string?)imageUrl!["url"]);
        Assert.Equal("high", (string?)imageUrl!["detail"]);
    }

    [Theory]
    [InlineData("low")]
    [InlineData("auto")]
    [InlineData("high")]
    public void BuildRequestBody_ImageAttachmentWithDetail_UsesCallerValue(string detail)
    {
        var client = NewVisionClient();
        var messages = new List<LLMMessage>
        {
            new()
            {
                Role = "user",
                Content = "识别",
                Attachments = new List<LLMAttachment>
                {
                    new() { Type = "image", Url = "https://example.com/b.png", Detail = detail }
                }
            }
        };

        var body = InvokeBuildRequestBody(client, messages);
        var imageUrl = FindImageUrlObject(body);

        Assert.NotNull(imageUrl);
        Assert.Equal(detail, (string?)imageUrl!["detail"]);
    }

    #endregion

    #region Claude Protocol Passthrough Tests

    // 守护"协议归一有损"修复（F3a）：ConvertToClaudeFormat 不再「只抄 5 个字段」拍平采样参数。
    // Claude 原生兼容的 top_p / top_k 必须透传；OpenAI 的 stop 必须改名为 Claude 的 stop_sequences；
    // OpenAI 专有、Claude 会 400 的 frequency_penalty 等「不」透传（白名单而非黑名单）。
    // ConvertToClaudeFormat 为私有静态，走反射调用。
    private static JsonObject InvokeConvertToClaudeFormat(JsonObject openaiBody)
    {
        var m = typeof(ClaudeGatewayAdapter).GetMethod(
            "ConvertToClaudeFormat",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(m);
        return (JsonObject)m!.Invoke(null, new object[] { openaiBody, false })!;
    }

    private static JsonObject BaseClaudeBody() => new()
    {
        ["model"] = "claude-x",
        ["max_tokens"] = 1024,
        ["messages"] = new JsonArray { new JsonObject { ["role"] = "user", ["content"] = "hi" } }
    };

    [Fact]
    public void ConvertToClaudeFormat_TopPAndTopK_ArePassedThrough()
    {
        var body = BaseClaudeBody();
        body["top_p"] = 0.9;
        body["top_k"] = 40;

        var result = InvokeConvertToClaudeFormat(body);

        Assert.Equal(0.9, (double)result["top_p"]!);
        Assert.Equal(40, (int)result["top_k"]!);
    }

    [Fact]
    public void ConvertToClaudeFormat_StopString_BecomesStopSequencesArray()
    {
        var body = BaseClaudeBody();
        body["stop"] = "\n\n";

        var result = InvokeConvertToClaudeFormat(body);

        var seq = Assert.IsType<JsonArray>(result["stop_sequences"]);
        Assert.Single(seq);
        Assert.Equal("\n\n", (string?)seq[0]);
        Assert.Null(result["stop"]); // OpenAI 字段名不应残留
    }

    [Fact]
    public void ConvertToClaudeFormat_StopArray_IsPreservedAsStopSequences()
    {
        var body = BaseClaudeBody();
        body["stop"] = new JsonArray { "END", "STOP" };

        var result = InvokeConvertToClaudeFormat(body);

        var seq = Assert.IsType<JsonArray>(result["stop_sequences"]);
        Assert.Equal(2, seq.Count);
        Assert.Equal("END", (string?)seq[0]);
        Assert.Equal("STOP", (string?)seq[1]);
    }

    [Fact]
    public void ConvertToClaudeFormat_OpenAIOnlyParams_AreNotPassedThrough()
    {
        // frequency_penalty / presence_penalty / n / stream_options 是 OpenAI 专有，
        // Claude Messages API 会 400 → 必须被白名单挡掉。
        var body = BaseClaudeBody();
        body["frequency_penalty"] = 0.5;
        body["presence_penalty"] = 0.3;
        body["n"] = 2;
        body["stream_options"] = new JsonObject { ["include_usage"] = true };

        var result = InvokeConvertToClaudeFormat(body);

        Assert.Null(result["frequency_penalty"]);
        Assert.Null(result["presence_penalty"]);
        Assert.Null(result["n"]);
        Assert.Null(result["stream_options"]);
    }

    #endregion

    #region Function-Calling (tools/tool_calls) Protocol Tests

    // 守护"函数调用穿协议不丢"（G2/G3）：
    // - Claude 请求：OpenAI function 包裹 tools → Claude input_schema；tool_choice 映射
    // - Claude 响应：content[].type=="tool_use" → OpenAI 形状 tool_calls
    // - OpenAI 响应：choices[0].message.tool_calls 透传；流式 delta.tool_calls → ToolCall chunk

    [Fact]
    public void ConvertToClaudeFormat_Tools_ConvertsFunctionWrapToInputSchema()
    {
        var body = BaseClaudeBody();
        body["tools"] = new JsonArray
        {
            new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = "get_weather",
                    ["description"] = "查天气",
                    ["parameters"] = new JsonObject
                    {
                        ["type"] = "object",
                        ["properties"] = new JsonObject { ["city"] = new JsonObject { ["type"] = "string" } }
                    }
                }
            }
        };

        var result = InvokeConvertToClaudeFormat(body);

        var tools = Assert.IsType<JsonArray>(result["tools"]);
        Assert.Single(tools);
        var t = Assert.IsType<JsonObject>(tools[0]);
        Assert.Equal("get_weather", (string?)t["name"]);          // 扁平 name，无 function 包裹
        Assert.Equal("查天气", (string?)t["description"]);
        Assert.NotNull(t["input_schema"]);                         // parameters → input_schema
        Assert.Null(t["function"]);                                // 不残留 OpenAI 包裹
        Assert.Null(t["parameters"]);
        Assert.Equal("object", (string?)t["input_schema"]!["type"]);
    }

    [Theory]
    [InlineData("auto", "auto")]
    [InlineData("required", "any")]
    public void ConvertToClaudeFormat_ToolChoice_StringMapsToClaudeType(string openai, string claudeType)
    {
        var body = BaseClaudeBody();
        body["tools"] = new JsonArray { new JsonObject { ["type"] = "function", ["function"] = new JsonObject { ["name"] = "f" } } };
        body["tool_choice"] = openai;

        var result = InvokeConvertToClaudeFormat(body);

        var tc = Assert.IsType<JsonObject>(result["tool_choice"]);
        Assert.Equal(claudeType, (string?)tc["type"]);
    }

    [Fact]
    public void ConvertToClaudeFormat_ToolChoice_FunctionObjectMapsToTool()
    {
        var body = BaseClaudeBody();
        body["tools"] = new JsonArray { new JsonObject { ["type"] = "function", ["function"] = new JsonObject { ["name"] = "get_weather" } } };
        body["tool_choice"] = new JsonObject { ["type"] = "function", ["function"] = new JsonObject { ["name"] = "get_weather" } };

        var result = InvokeConvertToClaudeFormat(body);

        var tc = Assert.IsType<JsonObject>(result["tool_choice"]);
        Assert.Equal("tool", (string?)tc["type"]);
        Assert.Equal("get_weather", (string?)tc["name"]);
    }

    [Fact]
    public void ClaudeAdapter_ParseToolCalls_ToolUse_ToOpenAiShape()
    {
        var adapter = new ClaudeGatewayAdapter();
        var responseBody = """
        {
          "content": [
            { "type": "text", "text": "稍等" },
            { "type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": { "city": "北京" } }
          ]
        }
        """;

        var toolCalls = adapter.ParseToolCalls(responseBody);

        Assert.NotNull(toolCalls);
        Assert.Single(toolCalls!);
        var c = Assert.IsType<JsonObject>(toolCalls![0]);
        Assert.Equal("toolu_1", (string?)c["id"]);
        Assert.Equal("function", (string?)c["type"]);
        var fn = Assert.IsType<JsonObject>(c["function"]);
        Assert.Equal("get_weather", (string?)fn["name"]);
        // arguments 必须是 JSON 字符串（OpenAI 约定）；ToJsonString 会把非 ASCII 转义为 \uXXXX，
        // 故不能裸子串比对，必须解析回 JSON 再断言字段值。
        var args = (string?)fn["arguments"];
        Assert.NotNull(args);
        var parsedArgs = JsonNode.Parse(args!);
        Assert.Equal("北京", (string?)parsedArgs!["city"]);
    }

    [Fact]
    public void ClaudeAdapter_ParseToolCalls_NoToolUse_ReturnsNull()
    {
        var adapter = new ClaudeGatewayAdapter();
        var responseBody = """{ "content": [ { "type": "text", "text": "你好" } ] }""";
        Assert.Null(adapter.ParseToolCalls(responseBody));
    }

    [Fact]
    public void OpenAIAdapter_ParseToolCalls_PassesThroughMessageToolCalls()
    {
        var adapter = new OpenAIGatewayAdapter();
        var responseBody = """
        {
          "choices": [
            { "message": { "role": "assistant", "content": null,
              "tool_calls": [ { "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"上海\"}" } } ] } }
          ]
        }
        """;

        var toolCalls = adapter.ParseToolCalls(responseBody);

        Assert.NotNull(toolCalls);
        Assert.Single(toolCalls!);
        var c = Assert.IsType<JsonObject>(toolCalls![0]);
        Assert.Equal("call_1", (string?)c["id"]);
        Assert.Equal("get_weather", (string?)c["function"]!["name"]);
    }

    [Fact]
    public void OpenAIAdapter_ParseStreamChunk_ToolCallsDelta_EmitsToolCallChunk()
    {
        var adapter = new OpenAIGatewayAdapter();
        var sse = """
        {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"ci"}}]}}]}
        """;

        var chunk = adapter.ParseStreamChunk(sse);

        Assert.NotNull(chunk);
        Assert.Equal(GatewayChunkType.ToolCall, chunk!.Type);
        Assert.NotNull(chunk.ToolCallDelta);
        Assert.Single(chunk.ToolCallDelta!);
    }

    [Fact]
    public void OpenAIAdapter_ParseStreamChunk_PlainText_StillText()
    {
        // 纯文本块不得被 tool_calls 子串判断误伤
        var adapter = new OpenAIGatewayAdapter();
        var sse = """{"choices":[{"delta":{"content":"你好"}}]}""";
        var chunk = adapter.ParseStreamChunk(sse);
        Assert.NotNull(chunk);
        Assert.Equal(GatewayChunkType.Text, chunk!.Type);
        Assert.Equal("你好", chunk.Content);
    }

    [Fact]
    public void ClaudeAdapter_ParseStreamChunk_ToolUseStart_EmitsToolCallChunk()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sse = """
        {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}
        """;

        var chunk = adapter.ParseStreamChunk(sse);

        Assert.NotNull(chunk);
        Assert.Equal(GatewayChunkType.ToolCall, chunk!.Type);
        Assert.NotNull(chunk.ToolCallDelta);
        var call = Assert.IsType<JsonObject>(Assert.Single(chunk.ToolCallDelta!));
        Assert.Equal(1, (int?)call["index"]);
        Assert.Equal("toolu_1", (string?)call["id"]);
        var fn = Assert.IsType<JsonObject>(call["function"]);
        Assert.Equal("get_weather", (string?)fn["name"]);
        Assert.Equal("", (string?)fn["arguments"]);
    }

    [Fact]
    public void ClaudeAdapter_ParseStreamChunk_InputJsonDelta_EmitsArgumentsDelta()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sse = """
        {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"上海\"}"}}
        """;

        var chunk = adapter.ParseStreamChunk(sse);

        Assert.NotNull(chunk);
        Assert.Equal(GatewayChunkType.ToolCall, chunk!.Type);
        Assert.NotNull(chunk.ToolCallDelta);
        var call = Assert.IsType<JsonObject>(Assert.Single(chunk.ToolCallDelta!));
        Assert.Equal(1, (int?)call["index"]);
        var fn = Assert.IsType<JsonObject>(call["function"]);
        Assert.Equal("{\"city\":\"上海\"}", (string?)fn["arguments"]);
    }

    // 守护流式函数调用增量「按 index 合并」（日志可视化用）：首个 delta 带 id/name，
    // 后续 delta 只追加 function.arguments 片段 → 合并成一条完整 tool_call。
    // AccumulateToolCallDeltas / BuildAccumulatedToolCalls 为 LlmGateway 私有静态，走反射。
    [Fact]
    public void StreamToolCallDeltas_MergedByIndex_IntoOneCompleteCall()
    {
        var accumType = typeof(Dictionary<int, JsonObject>);
        var accum = Activator.CreateInstance(accumType)!;

        var accumulate = typeof(LlmGateway).GetMethod(
            "AccumulateToolCallDeltas",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        var build = typeof(LlmGateway).GetMethod(
            "BuildAccumulatedToolCalls",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(accumulate);
        Assert.NotNull(build);

        var delta1 = new JsonArray
        {
            new JsonObject
            {
                ["index"] = 0,
                ["id"] = "call_1",
                ["type"] = "function",
                ["function"] = new JsonObject { ["name"] = "get_weather", ["arguments"] = "{\"ci" }
            }
        };
        var delta2 = new JsonArray
        {
            new JsonObject
            {
                ["index"] = 0,
                ["function"] = new JsonObject { ["arguments"] = "ty\":\"上海\"}" }
            }
        };

        accumulate!.Invoke(null, new object[] { accum, delta1 });
        accumulate!.Invoke(null, new object[] { accum, delta2 });
        var merged = build!.Invoke(null, new object[] { accum }) as JsonArray;

        Assert.NotNull(merged);
        Assert.Single(merged!);                                       // 两个 delta 合并成一条
        var c = Assert.IsType<JsonObject>(merged![0]);
        Assert.Equal("call_1", (string?)c["id"]);
        var fn = Assert.IsType<JsonObject>(c["function"]);
        Assert.Equal("get_weather", (string?)fn["name"]);
        // arguments 片段拼接后是合法 JSON
        var parsed = JsonNode.Parse((string)fn["arguments"]!);
        Assert.Equal("上海", (string?)parsed!["city"]);
    }

    #endregion

    #region Helper Methods

    private static LlmGateway CreateTestGateway()
    {
        // 创建一个用于测试的 Gateway 实例
        // 使用 InMemoryModelResolver 避免外部依赖
        var resolver = new InMemoryModelResolver()
            .WithPlatform(new LLMPlatform
            {
                Id = "test-platform",
                Name = "Test Platform",
                PlatformType = "openai",
                ApiUrl = "https://api.example.com",
                Enabled = true
            }, "sk-test-key")
            .WithModelGroup(new ModelGroup
            {
                Id = "test-pool",
                Name = "Test Pool",
                Code = "test-pool",
                ModelType = "chat",
                IsDefaultForType = true,
                Priority = 0,
                Models = new List<ModelGroupItem>
                {
                    new()
                    {
                        PlatformId = "test-platform",
                        ModelId = "gpt-4o",
                        Priority = 0,
                        HealthStatus = ModelHealthStatus.Healthy
                    }
                }
            });

        var httpClientFactory = new TestHttpClientFactory();
        var logger = new TestLogger<LlmGateway>();

        return new LlmGateway(resolver, httpClientFactory, logger);
    }

    #endregion
}

#region Test Helpers

internal class TestHttpClientFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new();
}

internal class TestLogger<T> : Microsoft.Extensions.Logging.ILogger<T>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => false;
    public void Log<TState>(
        Microsoft.Extensions.Logging.LogLevel logLevel,
        Microsoft.Extensions.Logging.EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    { }
}

#endregion
