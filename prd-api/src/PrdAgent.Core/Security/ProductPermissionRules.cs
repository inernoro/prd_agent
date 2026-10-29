using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

public sealed record ProductMenuDefinition(string Key, string Label, string[] Functions);

/// <summary>产品管理权限目录和覆盖语义的唯一来源；管理员身份只从真实MAP角色判定。</summary>
public static class ProductPermissionRules
{
    public const string ConfigurationId = "product-agent";
    public const string Scoped = "product-agent.menu-scoped";
    public const string MapAdmin = "product-agent.map-admin";
    public const string MenuPrefix = "product-agent.menu.";
    public const string ReviewViewAll = "product-agent.review-view-all";
    public const string ReviewManage = "product-agent.review-manage";
    public const string ReviewAppeal = "product-agent.review-appeal-review";
    public static readonly IReadOnlyList<ProductMenuDefinition> Menus = new[]
    {
        new ProductMenuDefinition("dashboard", "概览", Array.Empty<string>()),
        new ProductMenuDefinition("products", "产品", Array.Empty<string>()),
        new ProductMenuDefinition("requirements", "需求", Array.Empty<string>()),
        new ProductMenuDefinition("review", "评审", new[] { ReviewViewAll, ReviewManage, ReviewAppeal }),
        new ProductMenuDefinition("features", "功能", Array.Empty<string>()),
        new ProductMenuDefinition("defects", "缺陷", Array.Empty<string>()),
        new ProductMenuDefinition("versions", "版本", new[] { AdminPermissionCatalog.ProductAgentVersionApply, AdminPermissionCatalog.ProductAgentVersionClaimTest }),
        new ProductMenuDefinition("customers", "客户", Array.Empty<string>()),
        new ProductMenuDefinition("knowledge", "知识库", Array.Empty<string>()),
        new ProductMenuDefinition("graph", "图谱", Array.Empty<string>()),
        new ProductMenuDefinition("settings", "设置", new[] { AdminPermissionCatalog.ProductAgentManage, AdminPermissionCatalog.ProductAgentAdmin }),
    };
    public static readonly IReadOnlyDictionary<string, string> Functions = new Dictionary<string, string>
    {
        [AdminPermissionCatalog.ProductAgentVersionApply] = "版本号申领",
        [AdminPermissionCatalog.ProductAgentVersionClaimTest] = "申领测试（可用所有人的已通过方案）",
        [AdminPermissionCatalog.ProductAgentManage] = "产品管理配置及管理操作",
        [AdminPermissionCatalog.ProductAgentAdmin] = "跨全部产品的数据总览",
        [ReviewViewAll] = "查看全部评审与排行榜",
        [ReviewManage] = "评审维度与通知配置",
        [ReviewAppeal] = "评审申诉处理",
    };
    public static IEnumerable<AdminPermissionDef> AdditionalDefinitions =>
        Menus.Select(x => new AdminPermissionDef(MenuPrefix + x.Key, "产品菜单-" + x.Label, "产品管理工作簿配置的独立菜单准入"))
        .Concat(new[] { new AdminPermissionDef(Scoped, "产品菜单覆盖模式", "由产品工作簿状态计算，不作为身份授权"), new AdminPermissionDef(MapAdmin, "MAP管理员产品管理入口", "仅真实MAP管理员身份计算，不能通过权限例外获取") })
        .Concat(Functions.Where(x => x.Key is ReviewViewAll or ReviewManage or ReviewAppeal).Select(x => new AdminPermissionDef(x.Key, x.Value, "仅产品管理内评审使用，不改变独立评审授权")));

    public static bool IsMapAdministrator(User user) => user.Role == UserRole.ADMIN && user.Status == UserStatus.Active && user.UserType == UserType.Human;

    public static IReadOnlyList<string> Apply(User user, IEnumerable<string> original, ProductPermissionConfiguration? configuration)
    {
        var result = new HashSet<string>(original, StringComparer.Ordinal);
        // 该标记不可通过角色或个人例外伪造。
        result.Remove(MapAdmin);
        if (IsMapAdministrator(user))
        {
            result.UnionWith(AdditionalDefinitions.Select(x => x.Key));
            result.UnionWith(Functions.Keys);
            result.Add(AdminPermissionCatalog.ProductAgentUse);
            result.Add(MapAdmin);
            return result.OrderBy(x => x, StringComparer.Ordinal).ToArray();
        }
        if (configuration == null) return result.OrderBy(x => x, StringComparer.Ordinal).ToArray();
        result.RemoveWhere(x => x.StartsWith("product-agent.", StringComparison.Ordinal));
        result.Add(Scoped);
        var row = configuration.Users.SingleOrDefault(x => x.UserId == user.UserId);
        if (row != null)
        {
            foreach (var menu in Menus.Where(x => row.Menus.Contains(x.Key))) result.Add(MenuPrefix + menu.Key);
            if (row.Menus.Count > 0) result.Add(AdminPermissionCatalog.ProductAgentUse);
            result.UnionWith(row.Permissions.Where(Functions.ContainsKey));
        }
        return result.OrderBy(x => x, StringComparer.Ordinal).ToArray();
    }

    public static List<ProductPermissionRow> Normalize(ProductPermissionWorkbook book, IReadOnlyList<User> directory)
    {
        if (book == null || string.IsNullOrWhiteSpace(book.ExpectedRevision) || book.SchemaVersion != 1 || book.Sheets == null || book.Sheets.Any(x => x == null) || book.Sheets.Count != Menus.Count || book.Sheets.Select(x => x.Menu).Distinct(StringComparer.Ordinal).Count() != Menus.Count)
            throw new ArgumentException("请使用完整的产品权限工作簿：每个菜单一张表，不能缺表或重复。");
        if (book.Sheets.Any(x => !Menus.Any(m => m.Key == x.Menu))) throw new ArgumentException("存在未知菜单，未导入任何权限。");
        HashSet<string>? expectedUsers = null;
        var normalized = new Dictionary<string, ProductPermissionRow>(StringComparer.Ordinal);
        foreach (var sheet in book.Sheets)
        {
            var definition = Menus.Single(x => x.Key == sheet.Menu);
            if (sheet.Rows == null || sheet.Rows.Any(x => x == null || x.UserId == null || x.Username == null || x.DisplayName == null || x.Functions == null))
                throw new ArgumentException("人员行及功能列不能为空，请重新导出模板填写。");
            if (sheet.Rows.Count is 0 or > 5000) throw new ArgumentException($"{definition.Label}表必须包含1至5000人，空表不会作为清空命令。");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in sheet.Rows)
            {
                var id = item.UserId.Trim(); var username = item.Username.Trim(); var name = item.DisplayName.Trim();
                var matches = directory.Where(x => id.Length > 0 ? x.UserId == id : username.Length > 0 ? x.Username == username : name.Length > 0 && x.DisplayName == name).ToList();
                if (matches.Count != 1) throw new ArgumentException($"{definition.Label}表中“{(name.Length > 0 ? name : username)}”未能唯一匹配MAP账号，请填写账号或用户ID。");
                var user = matches[0];
                if ((username.Length > 0 && user.Username != username) || (name.Length > 0 && user.DisplayName != name)) throw new ArgumentException($"账号与姓名不一致：{name}，请核对后重试。");
                if (!seen.Add(user.UserId)) throw new ArgumentException($"{definition.Label}表存在重复人员：{name}。");
                if (!definition.Functions.ToHashSet(StringComparer.Ordinal).SetEquals(item.Functions.Keys)) throw new ArgumentException($"{definition.Label}表的功能列不完整或包含未知权限。");
                if (!item.Visible && item.Functions.Values.Any(x => x)) throw new ArgumentException($"{name}的{definition.Label}菜单已关闭，但仍勾选了该菜单的功能，请先修正。");
                if (!normalized.TryGetValue(user.UserId, out var row)) normalized[user.UserId] = row = new ProductPermissionRow { UserId = user.UserId };
                if (item.Visible) row.Menus.Add(definition.Key);
                row.Permissions.AddRange(item.Functions.Where(x => x.Value).Select(x => x.Key));
            }
            if (expectedUsers == null) expectedUsers = seen;
            else if (!expectedUsers.SetEquals(seen)) throw new ArgumentException("各菜单表的人员名单必须完全一致，不能漏人；未导入任何权限。");
        }
        return normalized.Values.OrderBy(x => x.UserId, StringComparer.Ordinal).ToList();
    }
}
