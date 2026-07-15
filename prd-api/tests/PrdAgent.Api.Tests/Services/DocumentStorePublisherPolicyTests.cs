using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class DocumentStorePublisherPolicyTests
{
    [Theory]
    [InlineData(false, null, null, "target", "Create")]
    [InlineData(true, "target", "old", "target", "Noop")]
    [InlineData(true, "old", "old", "target", "Update")]
    [InlineData(true, "human-edit", "old", "target", "Conflict")]
    [InlineData(true, "human-edit", null, "target", "Conflict")]
    public void Decide_UsesThreeWayHashWithoutOverwritingHumanEdits(
        bool exists,
        string? current,
        string? lastApplied,
        string target,
        string expected)
    {
        DocumentStorePublisherPolicy.Decide(exists, current, lastApplied, target).ToString().ShouldBe(expected);
    }

    [Fact]
    public void MergeMetadata_PreservesUnknownFieldsAndOwnsReservedFields()
    {
        var current = new Dictionary<string, string>
        {
            ["humanNote"] = "keep",
            [DocumentStorePublisherPolicy.SourceIdKey] = "old-source",
        };
        var requested = new Dictionary<string, string>
        {
            ["chapterLevel"] = "basic",
            [DocumentStorePublisherPolicy.PublisherKey] = "attempted-override",
        };

        var merged = DocumentStorePublisherPolicy.MergeMetadata(
            current,
            requested,
            "llmgw-authoritative-tutorial",
            "chapter-00",
            "chapters/00-introduction.md",
            "source-sha",
            "manifest-sha",
            "revision-1",
            "document",
            createdByRunId: "run-001",
            lastAppliedRunId: "run-001");

        merged["humanNote"].ShouldBe("keep");
        merged["chapterLevel"].ShouldBe("basic");
        merged[DocumentStorePublisherPolicy.PublisherKey].ShouldBe("llmgw-authoritative-tutorial");
        merged[DocumentStorePublisherPolicy.SourceIdKey].ShouldBe("chapter-00");
        merged[DocumentStorePublisherPolicy.LastAppliedSha256Key].ShouldBe("source-sha");
        merged[DocumentStorePublisherPolicy.DerivedStateKey].ShouldBe("ready");
        merged[DocumentStorePublisherPolicy.CreatedByRunIdKey].ShouldBe("run-001");
        merged[DocumentStorePublisherPolicy.LastAppliedRunIdKey].ShouldBe("run-001");
    }

    [Theory]
    [InlineData("llmgw-authoritative-tutorial", true)]
    [InlineData("chapter-00", true)]
    [InlineData("a", false)]
    [InlineData("UPPER", false)]
    [InlineData("has space", false)]
    [InlineData("../escape", false)]
    public void IsSafeToken_RejectsAmbiguousPublisherIdentities(string value, bool expected)
    {
        DocumentStorePublisherPolicy.IsSafeToken(value).ShouldBe(expected);
    }

    [Theory]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", true)]
    [InlineData("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF", true)]
    [InlineData("not-a-hash", false)]
    [InlineData("zz23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", false)]
    public void IsSha256_RequiresExactlySixtyFourHexCharacters(string value, bool expected)
    {
        DocumentStorePublisherPolicy.IsSha256(value).ShouldBe(expected);
    }

    [Fact]
    public void WouldCreateParentCycle_RejectsSelfAndDescendantParents()
    {
        var parents = new Dictionary<string, string?>
        {
            ["root"] = null,
            ["chapter"] = "root",
            ["section"] = "chapter",
        };

        DocumentStorePublisherPolicy.WouldCreateParentCycle("chapter", "chapter", parents).ShouldBeTrue();
        DocumentStorePublisherPolicy.WouldCreateParentCycle("chapter", "section", parents).ShouldBeTrue();
        DocumentStorePublisherPolicy.WouldCreateParentCycle("section", "root", parents).ShouldBeFalse();
        DocumentStorePublisherPolicy.WouldCreateParentCycle("root", null, parents).ShouldBeFalse();
    }

    [Fact]
    public void MetadataSha256_IsOrderIndependentAndChangesWithContent()
    {
        var first = new Dictionary<string, string> { ["b"] = "2", ["a"] = "1" };
        var same = new Dictionary<string, string> { ["a"] = "1", ["b"] = "2" };
        var changed = new Dictionary<string, string> { ["a"] = "1", ["b"] = "3" };

        DocumentStorePublisherPolicy.MetadataSha256(first).ShouldBe(DocumentStorePublisherPolicy.MetadataSha256(same));
        DocumentStorePublisherPolicy.MetadataSha256(first).ShouldNotBe(DocumentStorePublisherPolicy.MetadataSha256(changed));
    }

    [Fact]
    public void HasIdentityConflicts_FailsClosedForDuplicateOrMalformedManagedNodes()
    {
        var valid = Entry("one", "publisher-a", "chapter-00");
        var duplicate = Entry("two", "publisher-a", "chapter-00");
        var malformed = Entry("three", "publisher-a", null);
        var foreign = Entry("four", "publisher-b", null);

        DocumentStorePublisherPolicy.HasIdentityConflicts(new[] { valid, foreign }, "publisher-a").ShouldBeFalse();
        DocumentStorePublisherPolicy.HasIdentityConflicts(new[] { valid, duplicate }, "publisher-a").ShouldBeTrue();
        DocumentStorePublisherPolicy.HasIdentityConflicts(new[] { valid, malformed }, "publisher-a").ShouldBeTrue();
    }

    [Fact]
    public void IsSafeMetadata_RejectsMongoPathKeysAndOversizedPayloads()
    {
        DocumentStorePublisherPolicy.IsSafeMetadata(new Dictionary<string, string> { ["chapterLevel"] = "basic" }).ShouldBeTrue();
        DocumentStorePublisherPolicy.IsSafeMetadata(new Dictionary<string, string> { ["bad.key"] = "value" }).ShouldBeFalse();
        DocumentStorePublisherPolicy.IsSafeMetadata(new Dictionary<string, string> { ["$bad"] = "value" }).ShouldBeFalse();
        DocumentStorePublisherPolicy.IsSafeMetadata(new Dictionary<string, string> { ["large"] = new string('x', 4097) }).ShouldBeFalse();
    }

    [Fact]
    public void IsManagedBy_RequiresPublisherAndSourceIdTogether()
    {
        var metadata = new Dictionary<string, string>
        {
            [DocumentStorePublisherPolicy.PublisherKey] = "llmgw-authoritative-tutorial",
            [DocumentStorePublisherPolicy.SourceIdKey] = "chapter-00",
        };

        DocumentStorePublisherPolicy.IsManagedBy(metadata, "llmgw-authoritative-tutorial", "chapter-00").ShouldBeTrue();
        DocumentStorePublisherPolicy.IsManagedBy(metadata, "other-publisher", "chapter-00").ShouldBeFalse();
        DocumentStorePublisherPolicy.IsManagedBy(metadata, "llmgw-authoritative-tutorial", "chapter-01").ShouldBeFalse();
    }

    [Fact]
    public async Task Controller_RequiresApiKeyAndWriteScopeAtClassBoundary()
    {
        var type = typeof(DocumentStorePublisherController);
        var route = type.GetCustomAttributes(typeof(RouteAttribute), inherit: true).Cast<RouteAttribute>().Single();
        var authorize = type.GetCustomAttributes(typeof(AuthorizeAttribute), inherit: true).Cast<AuthorizeAttribute>().Single();
        var scope = type.GetCustomAttributes(typeof(RequireScopeAttribute), inherit: true).SingleOrDefault();

        route.Template.ShouldBe("api/open/document-store/publisher");
        authorize.AuthenticationSchemes.ShouldBe("ApiKey");
        scope.ShouldNotBeNull();

        var denied = CreateAuthorizationContext("document-store:read");
        await ((RequireScopeAttribute)scope!).OnAuthorizationAsync(denied);
        ((ObjectResult)denied.Result!).StatusCode.ShouldBe(StatusCodes.Status403Forbidden);

        var allowed = CreateAuthorizationContext(DocumentStoreOpenApiController.ScopeWrite);
        await ((RequireScopeAttribute)scope!).OnAuthorizationAsync(allowed);
        allowed.Result.ShouldBeNull();
    }

    [Fact]
    public void Controller_ExposesOnlySnapshotPutRollbackDeleteAndPrimaryWrite()
    {
        var methods = typeof(DocumentStorePublisherController).GetMethods()
            .Where(method => method.DeclaringType == typeof(DocumentStorePublisherController))
            .ToDictionary(method => method.Name);

        methods["Snapshot"].GetCustomAttributes(typeof(HttpGetAttribute), true).ShouldHaveSingleItem();
        methods["PutNode"].GetCustomAttributes(typeof(HttpPutAttribute), true).ShouldHaveSingleItem();
        methods["DeleteCreatedNode"].GetCustomAttributes(typeof(HttpDeleteAttribute), true).ShouldHaveSingleItem();
        methods["SetPrimary"].GetCustomAttributes(typeof(HttpPutAttribute), true).ShouldHaveSingleItem();
    }

    private static AuthorizationFilterContext CreateAuthorizationContext(string scope)
    {
        var httpContext = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("scope", scope) },
                authenticationType: "test")),
        };
        var actionContext = new ActionContext(
            httpContext,
            new RouteData(),
            new ActionDescriptor(),
            new Microsoft.AspNetCore.Mvc.ModelBinding.ModelStateDictionary());
        return new AuthorizationFilterContext(actionContext, new List<IFilterMetadata>());
    }

    private static DocumentEntry Entry(string id, string publisher, string? sourceId)
    {
        var metadata = new Dictionary<string, string>
        {
            [DocumentStorePublisherPolicy.PublisherKey] = publisher,
        };
        if (sourceId != null) metadata[DocumentStorePublisherPolicy.SourceIdKey] = sourceId;
        return new DocumentEntry { Id = id, Metadata = metadata };
    }
}
