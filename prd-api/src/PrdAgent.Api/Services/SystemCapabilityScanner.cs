using System.Reflection;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 系统能力扫描器 — 运行时动态扫描真实系统能力，供涌现探索器的 AI Prompt 使用。
///
/// 解决问题：硬编码的能力清单 = 无根之木，会随系统演进过时。
/// 解决方案：从 6 个运行时注册表动态扫描，每次涌现都用最新的系统状态。
/// </summary>
public class SystemCapabilityScanner
{
    private readonly IAdminControllerScanner _controllerScanner;
    private readonly MongoDbContext _db;

    // 缓存：启动后首次扫描，缓存 10 分钟
    private string? _cachedCapabilities;
    private DateTime _cacheExpiry = DateTime.MinValue;
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(10);

    public SystemCapabilityScanner(IAdminControllerScanner controllerScanner, MongoDbContext db)
    {
        _controllerScanner = controllerScanner;
        _db = db;
    }

    /// <summary>
    /// 获取系统能力摘要（供 LLM prompt 使用）
    /// </summary>
    public string GetCapabilities()
    {
        if (_cachedCapabilities != null && DateTime.UtcNow < _cacheExpiry)
            return _cachedCapabilities;

        _cachedCapabilities = BuildCapabilities();
        _cacheExpiry = DateTime.UtcNow + CacheDuration;
        return _cachedCapabilities;
    }

    private string BuildCapabilities()
    {
        var sb = new StringBuilder();
        sb.AppendLine("## 当前系统真实能力（运行时扫描，非硬编码）");
        sb.AppendLine();

        // ── 1. 功能模块（从菜单目录扫描）──
        sb.AppendLine("### 功能模块");
        foreach (var menu in AdminMenuCatalog.All.Where(m => m.Description != null))
        {
            sb.AppendLine($"- **{menu.Label}**（{menu.AppKey}）：{menu.Description}，路由 `{menu.Path}`");
        }
        sb.AppendLine();

        // ── 2. API 端点（从 Controller 扫描器获取）──
        sb.AppendLine("### API 控制器");
        var controllers = _controllerScanner.GetAllControllers();
        var appKeyGroups = controllers.GroupBy(c => c.AppKey).OrderBy(g => g.Key);
        foreach (var group in appKeyGroups)
        {
            var routes = string.Join(", ", group.Select(c => $"`{c.RoutePrefix}`"));
            sb.AppendLine($"- **{group.Key}**：{routes}");
        }
        sb.AppendLine();

        // ── 3. AI 能力（从 AppCallerRegistry 扫描）──
        sb.AppendLine("### AI/LLM 调用能力");
        var callers = AppCallerRegistrationService.GetAllDefinitions();
        var callerGroups = callers.GroupBy(c => c.Category).OrderBy(g => g.Key);
        foreach (var group in callerGroups)
        {
            sb.AppendLine($"**{group.Key}**：");
            foreach (var caller in group.Take(5)) // 每类最多 5 个避免过长
            {
                sb.AppendLine($"  - {caller.DisplayName}（{caller.AppCode}）");
            }
            if (group.Count() > 5)
                sb.AppendLine($"  - …及另外 {group.Count() - 5} 个调用点");
        }
        sb.AppendLine();

        // ── 4. 数据存储（从 MongoDbContext 反射扫描）──
        sb.AppendLine("### 数据集合（MongoDB）");
        var contextType = typeof(MongoDbContext);
        var collectionProps = contextType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.PropertyType.IsGenericType &&
                        p.PropertyType.GetGenericTypeDefinition() == typeof(IMongoCollection<>))
            .OrderBy(p => p.Name);

        var collectionNames = collectionProps
            .Select(p => p.Name)
            .ToList();
        sb.AppendLine($"共 {collectionNames.Count} 个集合：{string.Join("、", collectionNames.Take(30))}");
        if (collectionNames.Count > 30)
            sb.AppendLine($"…及另外 {collectionNames.Count - 30} 个集合");
        sb.AppendLine();

        // ── 5. 权限体系 ──
        sb.AppendLine("### 权限体系");
        sb.AppendLine($"共 {AdminPermissionCatalog.All.Count} 个权限点，覆盖：");
        var permGroups = AdminPermissionCatalog.All
            .Select(p => p.Key.Split('.')[0])
            .Distinct()
            .OrderBy(g => g);
        sb.AppendLine(string.Join("、", permGroups));
        sb.AppendLine();

        // ── 6. 工作流舱类型（从 CapsuleTypeRegistry 反射扫描）──
        sb.AppendLine("### 工作流舱类型");
        try
        {
            var capsuleType = typeof(CapsuleTypeRegistry);
            var capsuleFields = capsuleType
                .GetFields(BindingFlags.Public | BindingFlags.Static)
                .Where(f => f.FieldType == typeof(CapsuleTypeMeta));

            foreach (var field in capsuleFields.Take(15))
            {
                if (field.GetValue(null) is CapsuleTypeMeta meta)
                {
                    sb.AppendLine($"- **{meta.Name}**（{meta.TypeKey}）：{meta.Description?.Split('.')[0]}");
                }
            }
        }
        catch
        {
            sb.AppendLine("- （舱类型扫描跳过）");
        }

        return sb.ToString();
    }
}
