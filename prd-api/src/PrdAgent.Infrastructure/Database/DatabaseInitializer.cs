using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using System.Security.Cryptography;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 数据库初始化器
/// </summary>
public class DatabaseInitializer
{
    private readonly MongoDbContext _db;
    private readonly IIdGenerator _idGenerator;
    private readonly IConfiguration _configuration;

    public DatabaseInitializer(
        MongoDbContext db,
        IIdGenerator idGenerator,
        IConfiguration configuration)
    {
        _db = db;
        _idGenerator = idGenerator;
        _configuration = configuration;
    }

    /// <summary>
    /// 初始化管理员账号和初始邀请码
    /// </summary>
    public async Task InitializeAsync()
    {
        await EnsureAdminUserAsync();
        await EnsureInitialInviteCodeAsync();
        await EnsureSystemRolesAsync();
        await EnsureWorkflowSkillAsync();
        await EnsureBuiltInGuideSkillsAsync();
        await EnsureShortcutTemplateAsync();
        await EnsureShortcutExpirationsAsync();
    }

    /// <summary>
    /// 显式要求把管理员口令重置成配置里那一份的开关。
    ///
    /// 为什么需要它：播种只在「库里一个管理员都没有」时发生。一旦那个账号存在，
    /// 之后再改 <c>MAP_INITIAL_ADMIN_PASSWORD</c> 就永远不生效——真实后果是本仓库
    /// 2026-08 撞上的那种：库里躺着一个 admin，谁也不知道它的口令，配置里那把强口令
    /// 对不上，只能靠 env 破窗账号 root 进系统。而 root 不在 users 集合里，
    /// 界面上一切按 userId 查人的地方都显示「未知用户」。
    ///
    /// 所以给一条明确的纠正路径：置 1 启动时把管理员口令改成配置里的值。
    /// 做成开关而不是默认行为，是因为「每次启动都按配置重置口令」会把用户
    /// 自己在界面上改过的密码悄悄改回去。
    /// </summary>
    private const string ForceResetKey = "MAP_ADMIN_FORCE_RESET";

    /// <summary>
    /// 「这次救场已经做过了」记在哪。刻意不放 AppSettings——那一行是可导出的，
    /// 跨实例同步会把别处的标记搬进来，等于把本站的一次性动作重新武装或提前吞掉。
    /// </summary>
    private const string ForceResetMarkerId = "admin-force-reset";

    private async Task EnsureAdminUserAsync()
    {
        // 检查是否已存在管理员
        var existingAdmin = await _db.Users
            .Find(u => u.Role == UserRole.ADMIN)
            .FirstOrDefaultAsync();

        if (existingAdmin != null)
        {
            await MaybeForceResetAdminAsync(existingAdmin);
            return;
        }

        var credentials = InitialAdminCredentials.Resolve(_configuration);

        // 创建部署环境注入的初始管理员账号
        var adminUser = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = credentials.Username,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(credentials.Password),
            DisplayName = "系统管理员",
            Role = UserRole.ADMIN,
            Status = UserStatus.Active
        };

        await _db.Users.InsertOneAsync(adminUser);
        Console.WriteLine($"Created initial admin user: {adminUser.Username}");
    }

    /// <summary>
    /// 按 <see cref="ForceResetKey"/> 把既有管理员的用户名与口令对齐到配置。
    /// 只在开关明确为真时动手；改完清掉「必须重设密码」标记，让人能直接登进去，
    /// 之后在界面上自己改成想要的密码。
    /// </summary>
    private async Task MaybeForceResetAdminAsync(User existingAdmin)
    {
        var flag = (_configuration[ForceResetKey] ?? string.Empty).Trim();
        if (flag.Length == 0) return;
        var off = flag is "0" or "false" or "False" or "FALSE" or "no" or "off";
        if (off) return;

        // 一次性。容器环境变量是持久的，这段代码每次进程启动都会跑到——不记「这个值
        // 已经用过了」的话，运维某天例行重新部署，就会把管理员后来在界面上自己改的
        // 密码悄悄改回那个写在部署配置里、众所周知的救场口令，而且没有任何提示。
        //
        // 记的是**开关的值**，不是口令，库里不落任何口令派生物。要再救一次就把开关
        // 换个值（1 → 2），语义上也更诚实：那确实是另一次救场。
        var marker = await _db.DeploymentMarkers.Find(x => x.Id == ForceResetMarkerId).FirstOrDefaultAsync();
        if (string.Equals(marker?.Value, flag, StringComparison.Ordinal))
        {
            return;
        }

        InitialAdminCredentials credentials;
        try
        {
            credentials = InitialAdminCredentials.Resolve(_configuration);
        }
        catch (InvalidOperationException ex)
        {
            // 开了开关却没给合法凭据：说清楚，不要静默跳过——否则用户会以为已经重置了。
            Console.WriteLine($"[admin-reset] {ForceResetKey} 已开启，但凭据不合法，未执行重置：{ex.Message}");
            return;
        }

        // 目标用户名可能已经被另一个账号占着（多个 ADMIN 的部署很常见，上面那句
        // Find 只取到了「某一个」）。这种情况下重命名会撞唯一索引、或者更糟——
        // 悄悄留下两个同名账号。所以先按用户名找：找得到就重置它，找不到才把
        // 手上这个管理员改名过去。
        var target = await _db.Users
            .Find(u => u.Username == credentials.Username)
            .FirstOrDefaultAsync() ?? existingAdmin;

        var update = Builders<User>.Update
            .Set(u => u.Username, credentials.Username)
            .Set(u => u.PasswordHash, BCrypt.Net.BCrypt.HashPassword(credentials.Password))
            .Set(u => u.Status, UserStatus.Active)
            .Set(u => u.MustResetPassword, false);

        // 按用户名捞到的那个不一定是管理员——既然操作者点名要用它登进来救场，
        // 就把角色一起对齐，否则登进去也是个什么都干不了的账号。
        if (target.Role != UserRole.ADMIN)
        {
            update = update.Set(u => u.Role, UserRole.ADMIN);
        }

        await _db.Users.UpdateOneAsync(Builders<User>.Filter.Eq(u => u.UserId, target.UserId), update);

        // 记下这个开关值已经用过了。放在重置之后：万一上面那步抛了，这一笔就不落，
        // 下次启动还会再试一次——宁可重试，也不要「记成用过了但其实没改成」。
        await _db.DeploymentMarkers.UpdateOneAsync(
            Builders<DeploymentMarker>.Filter.Eq(x => x.Id, ForceResetMarkerId),
            Builders<DeploymentMarker>.Update
                .Set(x => x.Value, flag)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true });

        // 已知边界：这里不吊销既有会话。会话版本由 IAuthSessionService 管，
        // 而它按 clientType 分桶、不在 Infrastructure 的依赖面上。重置口令的场景是
        // 「我进不去了」而不是「有人偷了我的会话」，所以先不为它把依赖拉过来；
        // 真要踢下线，管理员登进去后走「强制下线」即可。已记入债务。

        Console.WriteLine(
            $"[admin-reset] 已按 {ForceResetKey}={flag} 重置管理员 {credentials.Username} 的口令；"
            + $"该值已记为用过，重启不会再执行。要再救一次请把 {ForceResetKey} 换成别的值。");
    }

    private async Task EnsureInitialInviteCodeAsync()
    {
        // 检查是否已存在可用的邀请码
        var existingCode = await _db.InviteCodes
            .Find(c => !c.IsUsed && (c.ExpiresAt == null || c.ExpiresAt > DateTime.UtcNow))
            .FirstOrDefaultAsync();

        if (existingCode != null)
            return;

        // 创建初始邀请码
        var inviteCode = new InviteCode
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Code = $"PRD-{Convert.ToHexString(RandomNumberGenerator.GetBytes(12))}",
            CreatorId = "system",
            IsUsed = false,
            ExpiresAt = DateTime.UtcNow.AddDays(30)
        };

        await _db.InviteCodes.InsertOneAsync(inviteCode);
        Console.WriteLine("Created a random initial invite code (expires in 30 days)");
    }

    private async Task EnsureSystemRolesAsync()
    {
        // 启动时仅“补齐缺失的内置角色”，不覆盖用户对已有角色的编辑（覆盖应由显式“重置内置角色”触发）
        var defs = PrdAgent.Core.Security.BuiltInSystemRoles.Definitions;
        foreach (var def in defs)
        {
            var existed = await _db.SystemRoles.Find(x => x.Key == def.Key).FirstOrDefaultAsync();
            if (existed != null)
            {
                // 对所有内置角色做”增量补齐”：只加不减，确保升级后新权限自动生效
                if (existed.IsBuiltIn)
                {
                    var current = existed.Permissions ?? new List<string>();
                    var merged = current
                        .Concat(def.Permissions ?? new List<string>())
                        .Select(x => (x ?? string.Empty).Trim())
                        .Where(x => !string.IsNullOrWhiteSpace(x))
                        .Distinct(StringComparer.Ordinal)
                        .ToList();
                    if (merged.Count != current.Count)
                    {
                        var update = Builders<SystemRole>.Update
                            .Set(x => x.Permissions, merged)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow)
                            .Set(x => x.UpdatedBy, "system");
                        await _db.SystemRoles.UpdateOneAsync(x => x.Id == existed.Id, update);
                    }
                }
                continue;
            }

            var role = new SystemRole
            {
                Id = await _idGenerator.GenerateIdAsync("config"),
                Key = def.Key,
                Name = def.Name,
                Permissions = (def.Permissions ?? new List<string>()).Distinct(StringComparer.Ordinal).ToList(),
                IsBuiltIn = true,
                UpdatedAt = DateTime.UtcNow,
                UpdatedBy = "system"
            };

            await _db.SystemRoles.InsertOneAsync(role);
        }
    }

    private async Task EnsureWorkflowSkillAsync()
    {
        const string skillKey = "workflow-from-code";
        var existing = await _db.Skills
            .Find(s => s.SkillKey == skillKey)
            .FirstOrDefaultAsync();

        if (existing != null)
            return;

        var skill = new Skill
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            SkillKey = skillKey,
            Title = "代码转工作流",
            Description = "将 Python/JS 代码片段或 GitHub URL 转换为自动化工作流。支持 HTTP 请求、数据提取、格式转换等舱类型的自动识别和映射。",
            Icon = "🔄",
            Category = "workflow",
            Tags = new List<string> { "工作流", "代码转换", "自动化" },
            Visibility = SkillVisibility.System,
            IsBuiltIn = true,
            IsEnabled = true,
            Order = 10,
            Input = new SkillInputConfig
            {
                ContextScope = "none",
                AcceptsUserInput = true,
                UserInputPlaceholder = "粘贴 Python/JS 代码，或输入 GitHub URL，或描述你想要的工作流",
                AcceptsAttachments = false,
                Parameters = new List<SkillParameter>
                {
                    new()
                    {
                        Key = "codeUrl",
                        Label = "代码仓库 URL（可选）",
                        Type = "text",
                        Required = false,
                    },
                },
            },
            Execution = new SkillExecutionConfig
            {
                PromptTemplate = @"请将以下内容转换为工作流配置：

{{userInput}}

{{#if codeUrl}}
代码仓库：{{codeUrl}}
{{/if}}

请分析代码中的：
1. HTTP 请求（URL、Method、Headers、Body）→ 映射为 http-request 或 smart-http 舱
2. 数据处理逻辑 → 映射为 data-extractor / data-merger / format-converter 舱
3. 文件操作 → 映射为 file-exporter 舱
4. Cookie/Token → 提取为工作流变量

返回完整的工作流 JSON 配置。",
                SystemPromptOverride = null,
                AppCallerCode = "workflow-agent.chat-assistant::chat",
                ModelType = "chat",
            },
            Output = new SkillOutputConfig
            {
                Mode = "chat",
                EchoToChat = true,
            },
        };

        await _db.Skills.InsertOneAsync(skill);
    }

    /// <summary>
    /// 种子：将 PromptManager 中的 18 个内置引导提示词迁移为 Skill（按角色区分）
    /// </summary>
    private async Task EnsureBuiltInGuideSkillsAsync()
    {
        var guideSkills = BuildGuideSkillDefinitions();

        foreach (var def in guideSkills)
        {
            var existing = await _db.Skills
                .Find(s => s.SkillKey == def.SkillKey)
                .FirstOrDefaultAsync();

            if (existing != null)
                continue;

            def.Id = await _idGenerator.GenerateIdAsync("config");
            await _db.Skills.InsertOneAsync(def);
        }
    }

    private async Task EnsureShortcutTemplateAsync()
    {
        const string defaultICloudUrl = "https://www.icloud.com/shortcuts/287ac5dffbee4411b186ec7c0e4b9ebd";

        var existingDefault = await _db.ShortcutTemplates
            .Find(x => x.IsDefault && x.IsActive)
            .FirstOrDefaultAsync();

        if (existingDefault != null)
        {
            if (!string.Equals(existingDefault.ICloudUrl, defaultICloudUrl, StringComparison.Ordinal))
            {
                await _db.ShortcutTemplates.UpdateOneAsync(
                    x => x.Id == existingDefault.Id,
                    Builders<ShortcutTemplate>.Update
                        .Set(x => x.ICloudUrl, defaultICloudUrl)
                        .Set(x => x.Version, "1.1")
                        .Set(x => x.UpdatedAt, DateTime.UtcNow));
            }
            return;
        }

        var existingByUrl = await _db.ShortcutTemplates
            .Find(x => x.ICloudUrl == defaultICloudUrl)
            .FirstOrDefaultAsync();

        if (existingByUrl != null)
        {
            await _db.ShortcutTemplates.UpdateOneAsync(
                x => x.Id == existingByUrl.Id,
                Builders<ShortcutTemplate>.Update
                    .Set(x => x.IsDefault, true)
                    .Set(x => x.IsActive, true)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));
            return;
        }

        var template = new ShortcutTemplate
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Name = "PrdAgent 收藏",
            Description = "从 iOS 分享菜单收藏链接或文本到 MAP。",
            ICloudUrl = defaultICloudUrl,
            Version = "1.1",
            IsDefault = true,
            IsActive = true,
            CreatedBy = "system",
        };

        await _db.ShortcutTemplates.InsertOneAsync(template);
    }

    private async Task EnsureShortcutExpirationsAsync()
    {
        var filter = Builders<UserShortcut>.Filter.Or(
            Builders<UserShortcut>.Filter.Eq(x => x.ExpiresAt, null),
            Builders<UserShortcut>.Filter.Exists(x => x.ExpiresAt, false));

        var shortcuts = await _db.UserShortcuts.Find(filter).ToListAsync();
        foreach (var shortcut in shortcuts)
        {
            var basis = shortcut.CreatedAt == default ? DateTime.UtcNow : shortcut.CreatedAt;
            await _db.UserShortcuts.UpdateOneAsync(
                x => x.Id == shortcut.Id,
                Builders<UserShortcut>.Update
                    .Set(x => x.ExpiresAt, basis.AddYears(1))
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));
        }
    }

    private List<Skill> BuildGuideSkillDefinitions()
    {
        var now = DateTime.UtcNow;
        var skills = new List<Skill>();

        // ── PM 角色（6 个引导步骤） ──
        var pmSteps = new (string key, string title, string prompt, string icon)[]
        {
            ("pm-guide-background", "项目背景与问题定义",
                "请用 Markdown 输出：用 3-5 个要点概述项目背景与要解决的核心问题；补充 1-2 个关键假设/风险（如有）。", "🎯"),
            ("pm-guide-users", "核心用户与使用场景",
                "请用 Markdown 输出：列出目标用户与主要使用场景（列表），并给出 1-2 个典型场景示例（如 PRD 有）。", "👥"),
            ("pm-guide-solution", "解决方案概述",
                "请用 Markdown 输出：概述解决方案（分点），包含核心功能与设计思路；如果 PRD 有范围/边界，请单独小节说明。", "💡"),
            ("pm-guide-features", "核心功能清单",
                "请用 Markdown 输出：按优先级列出核心功能点（列表/表格均可），并标注每项的验收要点（如 PRD 有）。", "📋"),
            ("pm-guide-priority", "优先级与迭代规划",
                "请用 Markdown 输出：说明功能优先级划分与迭代规划（分点/表格），并指出依赖与风险（如有）。", "📊"),
            ("pm-guide-metrics", "成功指标与验收标准",
                "请用 Markdown 输出：列出成功指标与验收标准（列表），缺失之处要明确写\"PRD 未覆盖\"。", "✅"),
        };
        for (int i = 0; i < pmSteps.Length; i++)
        {
            var s = pmSteps[i];
            skills.Add(BuildGuideSkill(s.key, s.title, s.prompt, s.icon, UserRole.PM, i + 1, now));
        }

        // ── DEV 角色（6 个引导步骤） ──
        var devSteps = new (string key, string title, string prompt, string icon)[]
        {
            ("dev-guide-architecture", "技术方案概述",
                "请用 Markdown 输出：概述技术架构/关键技术点（分点），并给出 3 条实现建议（如 PRD 可推导）。", "🏗️"),
            ("dev-guide-datamodel", "核心数据模型",
                "请用 Markdown 输出：列出核心数据实体（列表）与关键字段（可用表格）；PRD 未给出的字段请标注为\"待确认\"。", "🗄️"),
            ("dev-guide-flow", "主流程与状态流转",
                "请用 Markdown 输出：用步骤列表描述主流程；如适合请给出状态机表（状态/事件/迁移）。", "🔄"),
            ("dev-guide-api", "接口清单与规格",
                "请用 Markdown 输出：列出接口清单（表格：路径/方法/入参/出参/错误码）；PRD 缺失要明确写\"未覆盖\"。", "🔌"),
            ("dev-guide-constraints", "技术约束与依赖",
                "请用 Markdown 输出：列出技术约束/依赖/限制（分点），并指出潜在风险与规避建议。", "⚠️"),
            ("dev-guide-workload", "开发工作量要点",
                "请用 Markdown 输出：拆解工作量要点（列表），标注高风险点与需要提前验证的事项。", "📐"),
        };
        for (int i = 0; i < devSteps.Length; i++)
        {
            var s = devSteps[i];
            skills.Add(BuildGuideSkill(s.key, s.title, s.prompt, s.icon, UserRole.DEV, i + 1, now));
        }

        // ── QA 角色（6 个引导步骤） ──
        var qaSteps = new (string key, string title, string prompt, string icon)[]
        {
            ("qa-guide-modules", "功能模块清单",
                "请用 Markdown 输出：列出需测试的功能模块（列表/表格），并标注优先级（P0/P1/P2）。", "📦"),
            ("qa-guide-mainflow", "核心业务流程",
                "请用 Markdown 输出：给出测试主路径（步骤列表），并在每步标注关键校验点。", "🛤️"),
            ("qa-guide-boundary", "边界条件与约束",
                "请用 Markdown 输出：列出边界条件/输入约束/限制规则（列表），并给出对应的测试设计建议。", "🔍"),
            ("qa-guide-exceptions", "异常场景汇总",
                "请用 Markdown 输出：汇总异常场景（列表），包含触发条件/预期提示/恢复方式（如 PRD 有）。", "🚨"),
            ("qa-guide-acceptance", "验收标准明细",
                "请用 Markdown 输出：逐条列出验收标准与预期结果（列表），缺失项写\"PRD 未覆盖\"。", "📝"),
            ("qa-guide-risk", "测试重点与风险",
                "请用 Markdown 输出：总结测试重点与风险（分点），并列出需要产品补充确认的问题清单。", "🎯"),
        };
        for (int i = 0; i < qaSteps.Length; i++)
        {
            var s = qaSteps[i];
            skills.Add(BuildGuideSkill(s.key, s.title, s.prompt, s.icon, UserRole.QA, i + 1, now));
        }

        return skills;
    }

    private static Skill BuildGuideSkill(
        string skillKey, string title, string promptTemplate, string icon,
        UserRole role, int order, DateTime now)
    {
        return new Skill
        {
            SkillKey = skillKey,
            Title = title,
            Description = $"{role} 视角：{title}",
            Icon = icon,
            Category = "analysis",
            Tags = new List<string> { "PRD", "引导", role.ToString() },
            Visibility = SkillVisibility.System,
            IsBuiltIn = true,
            IsEnabled = true,
            Roles = new List<UserRole> { role },
            Order = order,
            Input = new SkillInputConfig
            {
                ContextScope = "prd",
                AcceptsUserInput = false,
                AcceptsAttachments = false,
            },
            Execution = new SkillExecutionConfig
            {
                PromptTemplate = promptTemplate,
                SystemPromptOverride = null, // 使用默认角色系统提示词
                AppCallerCode = "prd-agent.guide::chat",
                ModelType = "chat",
            },
            Output = new SkillOutputConfig
            {
                Mode = "chat",
                EchoToChat = true,
            },
            CreatedAt = now,
            UpdatedAt = now,
        };
    }
}
