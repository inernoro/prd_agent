using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 数据库初始化器
/// </summary>
public class DatabaseInitializer
{
    private readonly MongoDbContext _db;
    private readonly IIdGenerator _idGenerator;

    public DatabaseInitializer(MongoDbContext db, IIdGenerator idGenerator)
    {
        _db = db;
        _idGenerator = idGenerator;
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
    }

    private async Task EnsureAdminUserAsync()
    {
        // 检查是否已存在管理员
        var existingAdmin = await _db.Users
            .Find(u => u.Role == UserRole.ADMIN)
            .FirstOrDefaultAsync();

        if (existingAdmin != null)
            return;

        // 创建默认管理员账号
        var adminUser = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = "admin",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword("admin"),
            DisplayName = "系统管理员",
            Role = UserRole.ADMIN,
            Status = UserStatus.Active
        };

        await _db.Users.InsertOneAsync(adminUser);
        Console.WriteLine("Created default admin user: admin / admin");
        Console.WriteLine("Please change the password after first login!");
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
            Code = "PRD-INIT-2024",
            CreatorId = "system",
            IsUsed = false,
            ExpiresAt = DateTime.UtcNow.AddDays(30)
        };

        await _db.InviteCodes.InsertOneAsync(inviteCode);
        Console.WriteLine($"Created initial invite code: {inviteCode.Code} (expires in 30 days)");
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
