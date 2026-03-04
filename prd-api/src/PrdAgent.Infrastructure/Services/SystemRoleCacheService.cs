using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 系统角色缓存服务实现。
/// - 内置角色：从 BuiltInSystemRoles.Definitions 加载（只读）
/// - 自定义角色：从数据库加载（可 CRUD）
/// - 合并后维护一个统一列表
/// </summary>
public sealed class SystemRoleCacheService : ISystemRoleCacheService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<SystemRoleCacheService> _logger;
    private readonly object _lock = new();

    // 内置角色（只读，启动时从代码加载）
    private readonly List<SystemRole> _builtInRoles;

    // 自定义角色（从数据库加载）
    private List<SystemRole> _customRoles = new();

    // 合并后的列表（内置 + 自定义）
    private List<SystemRole> _allRoles = new();

    // 快速查找表
    private Dictionary<string, SystemRole> _roleByKey = new(StringComparer.OrdinalIgnoreCase);

    // 权限指纹（权限目录 + 角色定义的哈希，用于前端缓存失效判断）
    private string _fingerprint = string.Empty;

    public SystemRoleCacheService(MongoDbContext db, ILogger<SystemRoleCacheService> logger)
    {
        _db = db;
        _logger = logger;

        // 从代码加载内置角色
        _builtInRoles = BuiltInSystemRoles.Definitions.Select(def => new SystemRole
        {
            Id = $"builtin-{def.Key}",
            Key = def.Key,
            Name = def.Name,
            Permissions = def.Permissions.Distinct(StringComparer.Ordinal).ToList(),
            IsBuiltIn = true,
            UpdatedAt = DateTime.UtcNow,
            UpdatedBy = "system"
        }).ToList();

        _logger.LogInformation("已加载 {Count} 个内置角色: {Keys}",
            _builtInRoles.Count,
            string.Join(", ", _builtInRoles.Select(r => r.Key)));
    }

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await RefreshCustomRolesAsync(ct);
        _logger.LogInformation("SystemRoleCacheService 初始化完成，共 {Count} 个角色", _allRoles.Count);
    }

    public async Task RefreshCustomRolesAsync(CancellationToken ct = default)
    {
        try
        {
            // 从数据库加载自定义角色（IsBuiltIn = false）
            var customRoles = await _db.SystemRoles
                .Find(x => !x.IsBuiltIn)
                .ToListAsync(ct);

            lock (_lock)
            {
                _customRoles = customRoles;
                RebuildMergedList();
            }

            _logger.LogDebug("已刷新自定义角色缓存，共 {Count} 个", customRoles.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "刷新自定义角色缓存失败");
            throw;
        }
    }

    private void RebuildMergedList()
    {
        // 合并内置 + 自定义，内置角色优先（key 冲突时忽略自定义）
        var builtInKeys = new HashSet<string>(_builtInRoles.Select(r => r.Key), StringComparer.OrdinalIgnoreCase);

        var merged = new List<SystemRole>(_builtInRoles);
        merged.AddRange(_customRoles.Where(r => !builtInKeys.Contains(r.Key)));

        _allRoles = merged.OrderBy(r => r.Key, StringComparer.OrdinalIgnoreCase).ToList();
        _roleByKey = _allRoles.ToDictionary(r => r.Key, r => r, StringComparer.OrdinalIgnoreCase);

        _fingerprint = ComputeFingerprint();
    }

    /// <summary>
    /// 基于权限目录 + 所有角色定义计算 SHA256 指纹（取前 12 位 hex）。
    /// 任何权限目录变更（新部署）或角色权限调整都会改变此值。
    /// </summary>
    private string ComputeFingerprint()
    {
        var sb = new StringBuilder();

        // 1. 权限目录（每次新增/删除权限 key 都会变）
        sb.Append("catalog:");
        foreach (var p in AdminPermissionCatalog.All.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            sb.Append(p.Key).Append(',');
        }

        // 2. 所有角色的 key + 排序后的权限列表
        sb.Append("|roles:");
        foreach (var role in _allRoles)
        {
            sb.Append(role.Key).Append('=');
            if (role.Permissions != null)
            {
                foreach (var p in role.Permissions.OrderBy(x => x, StringComparer.Ordinal))
                {
                    sb.Append(p).Append(',');
                }
            }
            sb.Append(';');
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexString(hash)[..12].ToLowerInvariant();
    }

    public IReadOnlyList<SystemRole> GetAllRoles()
    {
        lock (_lock)
        {
            return _allRoles.ToList(); // 返回副本
        }
    }

    public SystemRole? GetRoleByKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;

        lock (_lock)
        {
            return _roleByKey.TryGetValue(key.Trim(), out var role) ? role : null;
        }
    }

    public string GetFingerprint()
    {
        lock (_lock)
        {
            return _fingerprint;
        }
    }
}
