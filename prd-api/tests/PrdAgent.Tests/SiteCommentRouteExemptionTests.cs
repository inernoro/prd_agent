using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 守护 <see cref="AdminControllerScanner"/> 对站点维度评论路由的权限豁免（Codex P2）。
///
/// 契约：<c>POST/GET /api/web-pages/{siteId}/comments</c> 由 service 层
/// (ListCommentsBySiteAsync / AddCommentBySiteAsync 经 GetByIdAsync) 自行鉴权，
/// 团队成员（含 viewer 角色）可读/可评，因此必须从 AdminPermissionMiddleware 的
/// WebPagesWrite 写权限闸门豁免，否则 viewer 从面板发表评论会被提前 403。
///
/// 边界：豁免正则用 <c>$</c> 锚定，**不得**误伤 owner/editor 专属的
/// <c>{id}/comments-enabled</c> 开关（必须保留写权限）。本测试同时锁定这条反向边界。
/// </summary>
public class SiteCommentRouteExemptionTests
{
    private static bool IsPublicRoute(string path)
    {
        var scanner = new AdminControllerScanner(NullLogger<AdminControllerScanner>.Instance);
        var method = typeof(AdminControllerScanner).GetMethod(
            "IsPublicRoute", BindingFlags.NonPublic | BindingFlags.Instance)!;
        return (bool)method.Invoke(scanner, new object[] { path })!;
    }

    [Theory]
    // 站点评论列表/发表：必须豁免（含尾斜杠）
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f/comments", true)]
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f/comments/", true)]
    // 既有公开前缀：保持豁免
    [InlineData("/api/web-pages/comments/some-comment-id", true)]
    [InlineData("/api/web-pages/shares/view/tok123/comments", true)]
    // 反向边界：owner/editor 专属开关绝不能被误豁免
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f/comments-enabled", false)]
    // 普通站点写操作不豁免
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f", false)]
    public void IsPublicRoute_SiteCommentExemption_RespectsBoundaries(string path, bool expected)
    {
        Assert.Equal(expected, IsPublicRoute(path));
    }
}
