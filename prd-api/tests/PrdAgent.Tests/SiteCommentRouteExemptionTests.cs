using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 守护 <see cref="AdminControllerScanner"/> 对站点维度评论路由的权限豁免（Codex P2）。
///
/// 契约：以下三条站点维度评论路由由 service 层自行鉴权，不依赖全局 WebPagesWrite，
/// 因此必须从 AdminPermissionMiddleware 的写权限闸门豁免（否则中间件在 service 鉴权前 403）：
///   - <c>GET/POST /api/web-pages/{siteId}/comments</c>          经 GetByIdAsync 校验（owner + 团队成员，含 viewer 可读/可评）
///   - <c>PATCH /api/web-pages/{siteId}/comments-enabled</c>     SetCommentsEnabledAsync 显式只放行 owner/editor
///
/// 边界：豁免正则用 <c>$</c> 锚定，**不得**误伤站点其它写操作（如 publish / 删除站点本体）。
/// 本测试同时锁定正向豁免与反向不豁免。
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
    // 评论开关：service 层只放行 owner/editor，同样豁免管理权限闸门（Codex P2 第二轮）
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f/comments-enabled", true)]
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f/comments-enabled/", true)]
    // 既有公开前缀：保持豁免
    [InlineData("/api/web-pages/comments/some-comment-id", true)]
    [InlineData("/api/web-pages/shares/view/tok123/comments", true)]
    // 反向边界：站点本体写操作不豁免
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f", false)]
    [InlineData("/api/web-pages/148d0c6d730444c1800ccdbb4a918a5f/publish", false)]
    public void IsPublicRoute_SiteCommentExemption_RespectsBoundaries(string path, bool expected)
    {
        Assert.Equal(expected, IsPublicRoute(path));
    }
}
