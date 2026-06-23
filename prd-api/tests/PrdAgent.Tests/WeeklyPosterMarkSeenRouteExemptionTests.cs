using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 守护周报海报已读标记端点的管理权限豁免。
///
/// 契约：<c>POST /api/weekly-posters/{id}/mark-seen</c> 是普通登录用户侧端点，
/// Controller 内部用当前用户写 SeenBy；它必须绕过 report-agent.template.manage
/// 管理写权限，否则没有模板管理权限的普通用户会在业务逻辑前被中间件拦成 403。
///
/// 边界：只豁免 mark-seen，不豁免周报海报创建、编辑、发布等管理写操作。
/// </summary>
public class WeeklyPosterMarkSeenRouteExemptionTests
{
    private static bool IsPublicRoute(string path)
    {
        var scanner = new AdminControllerScanner(NullLogger<AdminControllerScanner>.Instance);
        var method = typeof(AdminControllerScanner).GetMethod(
            "IsPublicRoute", BindingFlags.NonPublic | BindingFlags.Instance)!;
        return (bool)method.Invoke(scanner, new object[] { path })!;
    }

    [Theory]
    [InlineData("/api/weekly-posters/abc123/mark-seen", true)]
    [InlineData("/api/weekly-posters/abc123/mark-seen/", true)]
    [InlineData("/api/weekly-posters/abc123/publish", false)]
    [InlineData("/api/weekly-posters/abc123/unpublish", false)]
    [InlineData("/api/weekly-posters/abc123", false)]
    [InlineData("/api/weekly-posters", false)]
    public void IsPublicRoute_WeeklyPosterMarkSeenExemption_RespectsBoundaries(string path, bool expected)
    {
        Assert.Equal(expected, IsPublicRoute(path));
    }
}
