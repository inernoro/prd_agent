using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class ProductWorkflowTransitionGuardTests
{
    private static Product SampleProduct() => new()
    {
        OwnerId = "owner-1",
        AdminIds = new() { "admin-1" },
        MemberIds = new() { "member-1", "admin-1" },
    };

    [Fact]
    public void CanExecuteTransition_allows_empty_allowed_roles()
    {
        var transition = new ProductWorkflowTransition { AllowedRoles = null };
        Assert.True(ProductWorkflowTransitionGuard.CanExecuteTransition(
            "member-1", transition, SampleProduct(), false, "owner-2", null));
    }

    [Fact]
    public void CanExecuteTransition_blocks_member_for_product_admin_only()
    {
        var transition = new ProductWorkflowTransition
        {
            AllowedRoles = new() { ProductWorkflowTransitionRoles.ProductAdmin },
        };
        Assert.False(ProductWorkflowTransitionGuard.CanExecuteTransition(
            "member-1", transition, SampleProduct(), false, "owner-2", null));
        Assert.True(ProductWorkflowTransitionGuard.CanExecuteTransition(
            "admin-1", transition, SampleProduct(), false, "owner-2", null));
    }

    [Fact]
    public void ValidateRequiredFields_requires_comment_and_assignee()
    {
        var transition = new ProductWorkflowTransition
        {
            RequireComment = true,
            RequiredFieldKeys = new() { ProductWorkflowTransitionFieldKeys.AssigneeId },
        };
        Assert.Equal("该流转需要填写备注", ProductWorkflowTransitionGuard.ValidateRequiredFields(
            transition, "title", "p2", null, null, false));
        Assert.Equal("该流转需要指定处理人", ProductWorkflowTransitionGuard.ValidateRequiredFields(
            transition, "title", "p2", null, "ok", false));
        Assert.Null(ProductWorkflowTransitionGuard.ValidateRequiredFields(
            transition, "title", "p2", "user-9", "ok", false));
    }

    [Fact]
    public void Default_requirement_release_transition_restricts_roles()
    {
        var def = ProductWorkflowDefaults.Requirement();
        var releaseEdge = def.Transitions.First(t => t.Key == "developing-to-resolved");
        Assert.NotNull(releaseEdge.AllowedRoles);
        Assert.Contains(ProductWorkflowTransitionRoles.ProductAdmin, releaseEdge.AllowedRoles!);
    }
}
