using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

public class SkillService : ISkillService
{
    private readonly MongoDbContext _db;
    private readonly IIdGenerator _idGenerator;

    public SkillService(MongoDbContext db, IIdGenerator idGenerator)
    {
        _db = db;
        _idGenerator = idGenerator;
    }

    public async Task<List<Skill>> GetAvailableSkillsAsync(string? userId, string? role = null, CancellationToken ct = default)
    {
        // 内置技能（所有人可见）+ 当前用户创建的自定义技能
        var filter = Builders<Skill>.Filter.Or(
            Builders<Skill>.Filter.Eq(s => s.IsBuiltIn, true),
            string.IsNullOrEmpty(userId)
                ? Builders<Skill>.Filter.Empty
                : Builders<Skill>.Filter.Eq(s => s.OwnerUserId, userId)
        );

        var skills = await _db.Skills
            .Find(filter)
            .SortBy(s => s.Order)
            .ThenBy(s => s.CreatedAt)
            .ToListAsync(ct);

        // 如果指定了角色，过滤掉不允许的技能
        if (!string.IsNullOrEmpty(role))
        {
            skills = skills.Where(s =>
                s.AllowedRoles.Count == 0 ||
                s.AllowedRoles.Contains(role, StringComparer.OrdinalIgnoreCase)
            ).ToList();
        }

        return skills;
    }

    public async Task<Skill?> GetByIdAsync(string skillId, CancellationToken ct = default)
    {
        return await _db.Skills
            .Find(s => s.Id == skillId)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<Skill> CreateAsync(Skill skill, CancellationToken ct = default)
    {
        skill.Id = _idGenerator.GenerateId();
        skill.IsBuiltIn = false;
        skill.CreatedAt = DateTime.UtcNow;
        skill.UpdatedAt = DateTime.UtcNow;
        await _db.Skills.InsertOneAsync(skill, cancellationToken: ct);
        return skill;
    }

    public async Task<Skill?> UpdateAsync(string skillId, string userId, Skill updates, CancellationToken ct = default)
    {
        var existing = await GetByIdAsync(skillId, ct);
        if (existing == null) return null;

        // 内置技能不允许普通用户修改
        if (existing.IsBuiltIn) return null;

        // 只允许 owner 修改
        if (existing.OwnerUserId != userId) return null;

        var update = Builders<Skill>.Update
            .Set(s => s.Title, updates.Title)
            .Set(s => s.Description, updates.Description)
            .Set(s => s.Icon, updates.Icon)
            .Set(s => s.Category, updates.Category)
            .Set(s => s.Order, updates.Order)
            .Set(s => s.SystemPromptTemplate, updates.SystemPromptTemplate)
            .Set(s => s.UserPromptTemplate, updates.UserPromptTemplate)
            .Set(s => s.AllowedRoles, updates.AllowedRoles)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);

        var result = await _db.Skills.FindOneAndUpdateAsync(
            s => s.Id == skillId,
            update,
            new FindOneAndUpdateOptions<Skill> { ReturnDocument = ReturnDocument.After },
            ct);

        return result;
    }

    public async Task<bool> DeleteAsync(string skillId, string userId, CancellationToken ct = default)
    {
        var existing = await GetByIdAsync(skillId, ct);
        if (existing == null) return false;
        if (existing.IsBuiltIn) return false;
        if (existing.OwnerUserId != userId) return false;

        var result = await _db.Skills.DeleteOneAsync(s => s.Id == skillId, ct);
        return result.DeletedCount > 0;
    }

    public async Task SeedBuiltInSkillsAsync(CancellationToken ct = default)
    {
        var existingCount = await _db.Skills.CountDocumentsAsync(s => s.IsBuiltIn, cancellationToken: ct);
        if (existingCount > 0) return; // 已经 seed 过了

        var builtInSkills = GetBuiltInSkillDefinitions();
        if (builtInSkills.Count > 0)
        {
            await _db.Skills.InsertManyAsync(builtInSkills, cancellationToken: ct);
        }
    }

    private List<Skill> GetBuiltInSkillDefinitions()
    {
        var skills = new List<Skill>();
        var order = 0;

        // ── PM 视角技能 ──
        skills.Add(MakeBuiltIn(++order, "项目背景与问题定义",
            "从商业价值和用户痛点角度分析 PRD 的项目背景",
            "FileSearch", "requirement-analysis", new[] { "PM" },
            "请用 Markdown 输出：用 3-5 个要点概述项目背景与要解决的核心问题；补充 1-2 个关键假设/风险（如有）。"));

        skills.Add(MakeBuiltIn(++order, "核心用户与使用场景",
            "梳理目标用户群体和典型使用场景",
            "Users", "requirement-analysis", new[] { "PM" },
            "请用 Markdown 输出：列出目标用户与主要使用场景（列表），并给出 1-2 个典型场景示例（如 PRD 有）。"));

        skills.Add(MakeBuiltIn(++order, "解决方案概述",
            "概述产品解决方案的核心功能与设计思路",
            "Lightbulb", "requirement-analysis", new[] { "PM" },
            "请用 Markdown 输出：概述解决方案（分点），包含核心功能与设计思路；如果 PRD 有范围/边界，请单独小节说明。"));

        skills.Add(MakeBuiltIn(++order, "核心功能清单",
            "按优先级提取 PRD 中的核心功能点",
            "ListChecks", "requirement-analysis", new[] { "PM" },
            "请用 Markdown 输出：按优先级列出核心功能点（列表/表格均可），并标注每项的验收要点（如 PRD 有）。"));

        skills.Add(MakeBuiltIn(++order, "优先级与迭代规划",
            "分析功能优先级划分与迭代路线",
            "CalendarRange", "requirement-analysis", new[] { "PM" },
            "请用 Markdown 输出：说明功能优先级划分与迭代规划（分点/表格），并指出依赖与风险（如有）。"));

        skills.Add(MakeBuiltIn(++order, "成功指标与验收标准",
            "列出成功指标与验收标准",
            "Target", "requirement-analysis", new[] { "PM" },
            "请用 Markdown 输出：列出成功指标与验收标准（列表），缺失之处要明确写"PRD 未覆盖"。"));

        // ── DEV 视角技能 ──
        skills.Add(MakeBuiltIn(++order, "技术方案概述",
            "从技术架构角度分析 PRD 的实现要点",
            "Code", "technical-design", new[] { "DEV" },
            "请用 Markdown 输出：概述技术架构/关键技术点（分点），并给出 3 条实现建议（如 PRD 可推导）。"));

        skills.Add(MakeBuiltIn(++order, "核心数据模型",
            "提取 PRD 中涉及的核心数据实体与字段",
            "Database", "technical-design", new[] { "DEV" },
            "请用 Markdown 输出：列出核心数据实体（列表）与关键字段（可用表格）；PRD 未给出的字段请标注为"待确认"。"));

        skills.Add(MakeBuiltIn(++order, "主流程与状态流转",
            "描述主要业务流程和状态机",
            "GitBranch", "technical-design", new[] { "DEV" },
            "请用 Markdown 输出：用步骤列表描述主流程；如适合请给出状态机表（状态/事件/迁移）。"));

        skills.Add(MakeBuiltIn(++order, "接口清单与规格",
            "生成 API 接口清单与规格说明",
            "Plug", "technical-design", new[] { "DEV" },
            "请用 Markdown 输出：列出接口清单（表格：路径/方法/入参/出参/错误码）；PRD 缺失要明确写"未覆盖"。"));

        skills.Add(MakeBuiltIn(++order, "技术约束与依赖",
            "分析技术约束、依赖和潜在风险",
            "AlertTriangle", "technical-design", new[] { "DEV" },
            "请用 Markdown 输出：列出技术约束/依赖/限制（分点），并指出潜在风险与规避建议。"));

        skills.Add(MakeBuiltIn(++order, "开发工作量要点",
            "拆解开发工作量要点与高风险项",
            "Hammer", "technical-design", new[] { "DEV" },
            "请用 Markdown 输出：拆解工作量要点（列表），标注高风险点与需要提前验证的事项。"));

        // ── QA 视角技能 ──
        skills.Add(MakeBuiltIn(++order, "功能模块清单",
            "列出需测试的功能模块并标注优先级",
            "LayoutList", "test-planning", new[] { "QA" },
            "请用 Markdown 输出：列出需测试的功能模块（列表/表格），并标注优先级（P0/P1/P2）。"));

        skills.Add(MakeBuiltIn(++order, "核心业务流程",
            "给出主测试路径和关键校验点",
            "Route", "test-planning", new[] { "QA" },
            "请用 Markdown 输出：给出测试主路径（步骤列表），并在每步标注关键校验点。"));

        skills.Add(MakeBuiltIn(++order, "边界条件与约束",
            "分析边界条件和输入约束规则",
            "Fence", "test-planning", new[] { "QA" },
            "请用 Markdown 输出：列出边界条件/输入约束/限制规则（列表），并给出对应的测试设计建议。"));

        skills.Add(MakeBuiltIn(++order, "异常场景汇总",
            "汇总异常场景和错误处理策略",
            "Bug", "test-planning", new[] { "QA" },
            "请用 Markdown 输出：汇总异常场景（列表），包含触发条件/预期提示/恢复方式（如 PRD 有）。"));

        skills.Add(MakeBuiltIn(++order, "验收标准明细",
            "逐条列出验收标准与预期结果",
            "ClipboardCheck", "test-planning", new[] { "QA" },
            "请用 Markdown 输出：逐条列出验收标准与预期结果（列表），缺失项写"PRD 未覆盖"。"));

        skills.Add(MakeBuiltIn(++order, "测试重点与风险",
            "总结测试重点和需关注的风险",
            "ShieldAlert", "test-planning", new[] { "QA" },
            "请用 Markdown 输出：总结测试重点与风险（分点），并列出需要产品补充确认的问题清单。"));

        return skills;
    }

    private Skill MakeBuiltIn(int order, string title, string description, string icon, string category, string[] roles, string userPromptTemplate)
    {
        return new Skill
        {
            Id = _idGenerator.GenerateId(),
            Title = title,
            Description = description,
            Icon = icon,
            Category = category,
            Order = order,
            AllowedRoles = roles.ToList(),
            SystemPromptTemplate = string.Empty, // 内置技能使用角色默认 system prompt，不额外注入
            UserPromptTemplate = userPromptTemplate,
            IsBuiltIn = true,
            OwnerUserId = null,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
    }
}
