using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Filters;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 团队动态白名单守卫 — 防止 Controller / Action 重命名后白名单静默失效
/// （ActivityLogActionFilter 按 "Controller.Action" 字典匹配，匹配不到不报错只是不留痕，
/// 没有守卫的话重命名会让动态悄悄断流）。
/// </summary>
public class ActivityActionRegistryGuardTests
{
    private static readonly Assembly ApiAssembly = typeof(ActivityActionRegistry).Assembly;

    /// <summary>白名单里的每个 "Controller.Action" 复合键必须能在 API 程序集中找到对应的 Controller 类与公开 Action 方法。</summary>
    [Fact]
    public void EveryRegistryKey_ShouldMatchExistingControllerAction()
    {
        // 同名 Controller 可能在不同命名空间出现（MVC 路由用短名，留痕键也用短名），按短名分组逐一匹配
        var controllers = ApiAssembly.GetTypes()
            .Where(t => !t.IsAbstract && typeof(ControllerBase).IsAssignableFrom(t))
            .ToLookup(
                t => t.Name.EndsWith("Controller", StringComparison.Ordinal) ? t.Name[..^"Controller".Length] : t.Name,
                StringComparer.Ordinal);

        var missing = new List<string>();
        foreach (var key in ActivityActionRegistry.Actions.Keys)
        {
            var parts = key.Split('.');
            if (parts.Length != 2)
            {
                missing.Add($"{key}（格式应为 Controller.Action）");
                continue;
            }

            var candidates = controllers[parts[0]].ToList();
            if (candidates.Count == 0)
            {
                missing.Add($"{key}（找不到 {parts[0]}Controller）");
                continue;
            }

            var hasAction = candidates.Any(controllerType => controllerType
                .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Any(m => string.Equals(m.Name, parts[1], StringComparison.Ordinal)));
            if (!hasAction)
            {
                missing.Add($"{key}（{parts[0]}Controller 上没有公开方法 {parts[1]}）");
            }
        }

        Assert.True(missing.Count == 0,
            "团队动态白名单存在漂移条目（Controller/Action 已重命名或删除，请同步更新 ActivityActionRegistry）:\n  " +
            string.Join("\n  ", missing));
    }

    /// <summary>每个条目的展示字段必须完整，且至少声明一种标题来源或显式无目标对象。</summary>
    [Fact]
    public void EveryRegistryDef_ShouldHaveCompleteDisplayFields()
    {
        foreach (var (key, def) in ActivityActionRegistry.Actions)
        {
            Assert.False(string.IsNullOrWhiteSpace(def.Module), $"{key}: Module 不能为空");
            Assert.False(string.IsNullOrWhiteSpace(def.ModuleLabel), $"{key}: ModuleLabel 不能为空");
            Assert.False(string.IsNullOrWhiteSpace(def.ActionLabel), $"{key}: ActionLabel 不能为空");
            // TitleDb 必须配合 TargetRouteKey 使用（预读需要 TargetId）
            if (def.TitleDb != null)
            {
                Assert.False(string.IsNullOrWhiteSpace(def.TargetRouteKey),
                    $"{key}: 声明了 TitleDb 却没有 TargetRouteKey，预读永远拿不到 TargetId");
            }
        }
    }

    /// <summary>模块清单导出应去重且与白名单一致（前端筛选下拉数据源）。</summary>
    [Fact]
    public void Modules_ShouldBeDistinctAndCoverAllEntries()
    {
        var keys = ActivityActionRegistry.Modules.Select(m => m.Key).ToList();
        Assert.Equal(keys.Count, keys.Distinct(StringComparer.Ordinal).Count());

        var registered = ActivityActionRegistry.Actions.Values.Select(d => d.Module).Distinct().ToHashSet(StringComparer.Ordinal);
        Assert.Equal(registered, keys.ToHashSet(StringComparer.Ordinal));
    }
}
