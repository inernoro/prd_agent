using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// MAP MCP 连接器网关纯逻辑单测。不需要 live sk-ak 密钥 / 真实 HTTP / DB ——
/// 断言「工具目录、scope 过滤、动态命名唯一、路径占位替换、请求拼装、inputSchema」的行为。
/// 这是 CLAUDE.md §8.1 的自测路径 #1：用集成/单元测试证明行为真实发生。
/// </summary>
public class McpGatewayLogicTests
{
    private static readonly Regex McpToolNameRegex = new(@"^[a-zA-Z0-9_-]{1,64}$");

    // ── 工具目录 ──

    [Fact]
    public void BuiltinTools_ExposeExactlyFiveReadTools_WithExpectedNamesScopesPaths()
    {
        var byName = McpBuiltinTools.All.ToDictionary(t => t.Name);

        byName.Keys.ShouldBe(new[]
        {
            "marketplace_search_skills",
            "marketplace_get_skill",
            "knowledge_base_list_stores",
            "knowledge_base_list_entries",
            "knowledge_base_read_entry",
        }, ignoreOrder: true);

        // 海鲜市场工具 → marketplace.skills:read，回环到既有开放接口
        byName["marketplace_search_skills"].RequiredScope.ShouldBe("marketplace.skills:read");
        byName["marketplace_search_skills"].Method.ShouldBe("GET");
        byName["marketplace_search_skills"].PathTemplate.ShouldBe("/api/open/marketplace/skills");

        // 知识库工具 → document-store:read，回环到新建的 sk-ak 友好开放接口（/api/open/document-store）
        byName["knowledge_base_list_stores"].RequiredScope.ShouldBe("document-store:read");
        byName["knowledge_base_list_entries"].PathTemplate.ShouldBe("/api/open/document-store/stores/{storeId}/entries");
        byName["knowledge_base_read_entry"].PathTemplate.ShouldBe("/api/open/document-store/entries/{entryId}/content");

        // 所有工具名必须满足 MCP 工具名正则
        foreach (var t in McpBuiltinTools.All)
            McpToolNameRegex.IsMatch(t.Name).ShouldBeTrue($"工具名 {t.Name} 不满足 MCP 正则");
    }

    [Fact]
    public void BuiltinToolToJson_EmitsNameDescriptionAndRequiredInputSchema()
    {
        var tool = McpBuiltinTools.All.First(t => t.Name == "marketplace_get_skill");
        var json = McpGatewayController.BuiltinToolToJson(tool);

        json["name"]!.GetValue<string>().ShouldBe("marketplace_get_skill");
        json["description"]!.GetValue<string>().ShouldNotBeNullOrWhiteSpace();
        var schema = json["inputSchema"]!.AsObject();
        schema["type"]!.GetValue<string>().ShouldBe("object");
        schema["properties"]!.AsObject().ContainsKey("id").ShouldBeTrue();
        // id 是路径必填参数 → required 数组里有 id
        schema["required"]!.AsArray().Select(x => x!.GetValue<string>()).ShouldContain("id");
    }

    // ── scope 满足（写隐含读，镜像 AdminPermissionMiddleware）──

    [Fact]
    public void ScopeSatisfies_ExactMatch_True()
    {
        var owned = new HashSet<string> { "document-store:read" };
        McpGatewayController.ScopeSatisfies(owned, "document-store:read").ShouldBeTrue();
    }

    [Fact]
    public void ScopeSatisfies_DocumentStoreWrite_ImpliesRead()
    {
        var owned = new HashSet<string> { "document-store:write" };
        McpGatewayController.ScopeSatisfies(owned, "document-store:read").ShouldBeTrue();
    }

    [Fact]
    public void ScopeSatisfies_UnrelatedScope_False()
    {
        var owned = new HashSet<string> { "marketplace.skills:read" };
        McpGatewayController.ScopeSatisfies(owned, "document-store:read").ShouldBeFalse();
    }

    [Fact]
    public void ScopeSatisfies_MarketplaceWriteDoesNotImplyRead()
    {
        // marketplace 在 REST 层是精确 OR（无写隐含读），ScopeSatisfies 也不应放行
        var owned = new HashSet<string> { "marketplace.skills:write" };
        McpGatewayController.ScopeSatisfies(owned, "marketplace.skills:read").ShouldBeFalse();
    }

    // ── 动态工具名唯一性（共享其他 Agent 的开放接口）──

    [Fact]
    public void DynamicToolName_SameAgentKeyAndAction_DifferentEndpoints_ProduceUniqueNames()
    {
        var e1 = new AgentOpenEndpoint
        {
            Id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
            AgentKey = "report-agent",
            RequiredScopes = new List<string> { "agent.report-agent:call" },
        };
        var e2 = new AgentOpenEndpoint
        {
            Id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
            AgentKey = "report-agent",
            RequiredScopes = new List<string> { "agent.report-agent:call" },
        };

        var n1 = McpGatewayController.DynamicToolName(e1);
        var n2 = McpGatewayController.DynamicToolName(e2);

        n1.ShouldNotBe(n2); // 完整 id 后缀保证唯一
        n1.ShouldStartWith("report-agent__call__");
        McpToolNameRegex.IsMatch(n1).ShouldBeTrue();
        McpToolNameRegex.IsMatch(n2).ShouldBeTrue();
        n1.Length.ShouldBeLessThanOrEqualTo(64);
    }

    // ── 路径占位替换 + 请求拼装 ──

    [Fact]
    public void SubstitutePathParams_ReplacesPlaceholder_AndRecordsConsumed()
    {
        var args = new JsonObject { ["storeId"] = "abc123" };
        var consumed = new HashSet<string>();
        var path = McpGatewayController.SubstitutePathParams(
            "/api/document-store/stores/{storeId}/entries", args, consumed);

        path.ShouldBe("/api/document-store/stores/abc123/entries");
        consumed.ShouldContain("storeId");
    }

    [Fact]
    public void BuildBuiltinRequest_GetWithQueryParams_BuildsQueryString_NoBody()
    {
        var tool = McpBuiltinTools.All.First(t => t.Name == "marketplace_search_skills");
        var args = new JsonObject { ["keyword"] = "vue", ["limit"] = 5 };

        var (path, body, err) = McpGatewayController.BuildBuiltinRequest(tool, args);

        err.ShouldBeNull();
        body.ShouldBeNull();
        path.ShouldStartWith("/api/open/marketplace/skills?");
        path.ShouldContain("keyword=vue");
        path.ShouldContain("limit=5");
    }

    [Fact]
    public void BuildBuiltinRequest_PathParam_IsSubstitutedIntoPath()
    {
        var tool = McpBuiltinTools.All.First(t => t.Name == "marketplace_get_skill");
        var args = new JsonObject { ["id"] = "skill-42" };

        var (path, body, err) = McpGatewayController.BuildBuiltinRequest(tool, args);

        err.ShouldBeNull();
        body.ShouldBeNull();
        path.ShouldBe("/api/open/marketplace/skills/skill-42");
    }

    [Fact]
    public void BuildBuiltinRequest_MissingRequiredParam_ReturnsError()
    {
        var tool = McpBuiltinTools.All.First(t => t.Name == "knowledge_base_read_entry");
        var (_, _, err) = McpGatewayController.BuildBuiltinRequest(tool, new JsonObject());

        err.ShouldNotBeNull();
        err!.ShouldContain("entryId");
    }

    // ── 动态工具 inputSchema 推断 ──

    [Fact]
    public void InferSchema_FromExampleJson_ProducesObjectWithProperties()
    {
        var schema = McpGatewayController.InferSchema("{\"title\":\"x\",\"count\":3,\"flag\":true}");

        schema["type"]!.GetValue<string>().ShouldBe("object");
        var props = schema["properties"]!.AsObject();
        props["title"]!["type"]!.GetValue<string>().ShouldBe("string");
        props["count"]!["type"]!.GetValue<string>().ShouldBe("number");
        props["flag"]!["type"]!.GetValue<string>().ShouldBe("boolean");
    }

    [Fact]
    public void InferSchema_InvalidExample_FallsBackToOpenObject()
    {
        var schema = McpGatewayController.InferSchema("not-json");
        schema["type"]!.GetValue<string>().ShouldBe("object");
        schema["additionalProperties"]!.GetValue<bool>().ShouldBeTrue();
    }

    // ── 畸形 JSON-RPC 字段非抛出读取（公开端点 robustness）──

    [Fact]
    public void AsString_NonStringOrMissing_ReturnsNull_DoesNotThrow()
    {
        // 畸形："method": 1 / true / null / 缺失 —— 一律返回 null，不抛异常（否则公开端点 500）
        McpGatewayController.AsString(JsonValue.Create(1)).ShouldBeNull();
        McpGatewayController.AsString(JsonValue.Create(true)).ShouldBeNull();
        McpGatewayController.AsString(null).ShouldBeNull();
        // 合法字符串正常读出
        McpGatewayController.AsString(JsonValue.Create("tools/list")).ShouldBe("tools/list");
    }
}
