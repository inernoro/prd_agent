using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 周计划内置模板定义
/// </summary>
public static class WeeklyPlanBuiltInTemplates
{
    public static List<WeeklyPlanTemplate> GetAll(string adminId)
    {
        return new List<WeeklyPlanTemplate>
        {
            CreateRnDTeamWeeklyPlan(adminId),
            CreateDevTeamWeeklyReport(adminId),
            CreatePmWeeklyPlan(adminId),
            CreateQaTeamWeeklyPlan(adminId),
            CreatePersonalGrowthPlan(adminId),
            CreateSprintRetrospective(adminId),
        };
    }

    /// <summary>
    /// 产研团队周计划 - 适用于整个产研团队的通用周计划
    /// </summary>
    private static WeeklyPlanTemplate CreateRnDTeamWeeklyPlan(string adminId) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = "产研团队周计划",
        Description = "适用于产研团队的通用周计划模板，涵盖工作重点、任务追踪、风险管理等核心要素",
        IsBuiltIn = true,
        IsActive = true,
        SubmitDeadline = "monday 10:00",
        CreatedBy = adminId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
        Sections = new List<TemplateSectionDef>
        {
            new()
            {
                Id = "focus", Title = "本周工作重点", Type = "text", Required = true, Order = 0,
                Placeholder = "用 1-3 句话描述本周最核心的目标和重点方向"
            },
            new()
            {
                Id = "tasks", Title = "具体任务清单", Type = "table", Required = true, Order = 1,
                Placeholder = "列出本周要完成的具体任务",
                Columns = new List<TableColumnDef>
                {
                    new() { Name = "任务名称", Type = "text", Width = "2fr" },
                    new() { Name = "优先级", Type = "select", Options = new List<string> { "P0-紧急", "P1-重要", "P2-一般", "P3-低" } },
                    new() { Name = "预计完成日", Type = "date" },
                    new() { Name = "负责人", Type = "text" },
                    new() { Name = "状态", Type = "select", Options = new List<string> { "未开始", "进行中", "已完成", "已阻塞" } },
                }
            },
            new()
            {
                Id = "risks", Title = "风险与阻碍", Type = "list", Required = false, Order = 2,
                Placeholder = "列出可能影响本周计划完成的风险因素和阻碍", MaxItems = 10
            },
            new()
            {
                Id = "coordination", Title = "需要协调的事项", Type = "list", Required = false, Order = 3,
                Placeholder = "需要跨部门/跨团队协调的事项", MaxItems = 10
            },
            new()
            {
                Id = "carryover", Title = "上周未完成事项", Type = "checklist", Required = false, Order = 4,
                Placeholder = "从上周遗留下来需要继续跟进的事项"
            },
        }
    };

    /// <summary>
    /// 开发团队周报 - 侧重技术实现和代码交付
    /// </summary>
    private static WeeklyPlanTemplate CreateDevTeamWeeklyReport(string adminId) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = "开发团队周报",
        Description = "面向开发工程师的周报模板，关注代码交付、技术债务和工程效率",
        IsBuiltIn = true,
        IsActive = true,
        SubmitDeadline = "friday 18:00",
        CreatedBy = adminId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
        Sections = new List<TemplateSectionDef>
        {
            new()
            {
                Id = "completed", Title = "本周已完成", Type = "list", Required = true, Order = 0,
                Placeholder = "本周完成的需求/功能/修复（含 MR/PR 链接）", MaxItems = 20
            },
            new()
            {
                Id = "in-progress", Title = "进行中任务", Type = "table", Required = true, Order = 1,
                Placeholder = "正在开发中的任务",
                Columns = new List<TableColumnDef>
                {
                    new() { Name = "任务/需求", Type = "text", Width = "2fr" },
                    new() { Name = "进度%", Type = "number" },
                    new() { Name = "预计完成日", Type = "date" },
                    new() { Name = "阻塞点", Type = "text" },
                }
            },
            new()
            {
                Id = "next-week", Title = "下周计划", Type = "list", Required = true, Order = 2,
                Placeholder = "下周计划开发的任务", MaxItems = 10
            },
            new()
            {
                Id = "tech-debt", Title = "技术债务追踪", Type = "list", Required = false, Order = 3,
                Placeholder = "发现或需要处理的技术债务（如代码重构、性能问题等）", MaxItems = 10
            },
            new()
            {
                Id = "code-review", Title = "Code Review 与协作", Type = "text", Required = false, Order = 4,
                Placeholder = "本周 Review/合并情况，跨团队协作记录"
            },
            new()
            {
                Id = "learning", Title = "技术沉淀", Type = "text", Required = false, Order = 5,
                Placeholder = "本周的技术学习、最佳实践沉淀或分享"
            },
        }
    };

    /// <summary>
    /// 产品经理周计划 - 关注需求管理和产品迭代
    /// </summary>
    private static WeeklyPlanTemplate CreatePmWeeklyPlan(string adminId) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = "产品经理周计划",
        Description = "产品经理专属模板，覆盖需求排期、用户反馈、数据分析和竞品跟踪",
        IsBuiltIn = true,
        IsActive = true,
        SubmitDeadline = "monday 10:00",
        CreatedBy = adminId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
        Sections = new List<TemplateSectionDef>
        {
            new()
            {
                Id = "sprint-goal", Title = "本周迭代目标", Type = "text", Required = true, Order = 0,
                Placeholder = "用 1-2 句话描述本周产品迭代的核心目标"
            },
            new()
            {
                Id = "requirements", Title = "需求排期", Type = "table", Required = true, Order = 1,
                Placeholder = "本周需要推进的需求",
                Columns = new List<TableColumnDef>
                {
                    new() { Name = "需求名称", Type = "text", Width = "2fr" },
                    new() { Name = "优先级", Type = "select", Options = new List<string> { "P0", "P1", "P2", "P3" } },
                    new() { Name = "阶段", Type = "select", Options = new List<string> { "调研中", "PRD编写", "评审中", "开发中", "验收中", "已上线" } },
                    new() { Name = "目标版本", Type = "text" },
                }
            },
            new()
            {
                Id = "user-feedback", Title = "用户反馈跟踪", Type = "list", Required = false, Order = 2,
                Placeholder = "本周收集到的重要用户反馈和处理进展", MaxItems = 10
            },
            new()
            {
                Id = "data-analysis", Title = "数据分析计划", Type = "list", Required = false, Order = 3,
                Placeholder = "本周需要关注的数据指标和分析任务", MaxItems = 10
            },
            new()
            {
                Id = "competitor", Title = "竞品动态", Type = "text", Required = false, Order = 4,
                Placeholder = "竞品近期动态和对我们的启示"
            },
            new()
            {
                Id = "stakeholder", Title = "干系人沟通计划", Type = "list", Required = false, Order = 5,
                Placeholder = "本周需要与哪些干系人沟通、推进哪些决策", MaxItems = 10
            },
        }
    };

    /// <summary>
    /// 测试团队周计划 - 关注质量保证和自动化
    /// </summary>
    private static WeeklyPlanTemplate CreateQaTeamWeeklyPlan(string adminId) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = "测试团队周计划",
        Description = "QA 团队专属模板，覆盖测试计划、缺陷管理、自动化推进和发布验证",
        IsBuiltIn = true,
        IsActive = true,
        SubmitDeadline = "monday 10:00",
        CreatedBy = adminId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
        Sections = new List<TemplateSectionDef>
        {
            new()
            {
                Id = "coverage", Title = "测试覆盖范围", Type = "text", Required = true, Order = 0,
                Placeholder = "本周测试重点覆盖的模块/功能/版本"
            },
            new()
            {
                Id = "test-plan", Title = "测试用例规划", Type = "table", Required = true, Order = 1,
                Placeholder = "本周计划执行的测试用例",
                Columns = new List<TableColumnDef>
                {
                    new() { Name = "模块/功能", Type = "text", Width = "2fr" },
                    new() { Name = "测试类型", Type = "select", Options = new List<string> { "功能测试", "回归测试", "性能测试", "兼容性测试", "安全测试" } },
                    new() { Name = "用例数", Type = "number" },
                    new() { Name = "负责人", Type = "text" },
                    new() { Name = "状态", Type = "select", Options = new List<string> { "待执行", "执行中", "已完成", "已阻塞" } },
                }
            },
            new()
            {
                Id = "bug-stats", Title = "缺陷统计", Type = "text", Required = false, Order = 2,
                Placeholder = "本周发现/关闭/遗留的缺陷统计（可含严重级别分布）"
            },
            new()
            {
                Id = "automation", Title = "自动化进展", Type = "progress", Required = false, Order = 3,
                Placeholder = "自动化测试覆盖率或本周自动化任务进展"
            },
            new()
            {
                Id = "release-verify", Title = "发布验证计划", Type = "list", Required = false, Order = 4,
                Placeholder = "本周计划发布的版本及验证计划", MaxItems = 5
            },
            new()
            {
                Id = "env-issues", Title = "环境问题", Type = "list", Required = false, Order = 5,
                Placeholder = "测试环境相关问题和诉求", MaxItems = 5
            },
        }
    };

    /// <summary>
    /// 个人成长周计划 - 关注学习和职业发展
    /// </summary>
    private static WeeklyPlanTemplate CreatePersonalGrowthPlan(string adminId) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = "个人成长周计划",
        Description = "个人职业发展模板，帮助团队成员规划学习目标、OKR 进展和分享计划",
        IsBuiltIn = true,
        IsActive = true,
        CreatedBy = adminId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
        Sections = new List<TemplateSectionDef>
        {
            new()
            {
                Id = "learning-goals", Title = "本周学习目标", Type = "list", Required = true, Order = 0,
                Placeholder = "本周计划学习的技术/知识/技能", MaxItems = 5
            },
            new()
            {
                Id = "okr-progress", Title = "OKR 进展", Type = "table", Required = false, Order = 1,
                Placeholder = "个人 OKR 本周进展",
                Columns = new List<TableColumnDef>
                {
                    new() { Name = "目标 (O)", Type = "text", Width = "2fr" },
                    new() { Name = "关键结果 (KR)", Type = "text", Width = "2fr" },
                    new() { Name = "进度%", Type = "number" },
                    new() { Name = "本周动作", Type = "text" },
                }
            },
            new()
            {
                Id = "sharing", Title = "技术分享计划", Type = "text", Required = false, Order = 2,
                Placeholder = "本周计划进行的技术分享主题、文章撰写等"
            },
            new()
            {
                Id = "mentorship", Title = "导师交流/1on1", Type = "text", Required = false, Order = 3,
                Placeholder = "与导师/主管的交流计划和待讨论议题"
            },
            new()
            {
                Id = "reflection", Title = "上周反思", Type = "text", Required = false, Order = 4,
                Placeholder = "上周的收获、不足和改进方向"
            },
        }
    };

    /// <summary>
    /// Sprint 回顾 - 适用于敏捷迭代的回顾总结
    /// </summary>
    private static WeeklyPlanTemplate CreateSprintRetrospective(string adminId) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = "Sprint 回顾与下周规划",
        Description = "敏捷团队迭代回顾模板，总结做得好的、需要改进的，以及下个迭代的行动项",
        IsBuiltIn = true,
        IsActive = true,
        SubmitDeadline = "friday 17:00",
        CreatedBy = adminId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
        Sections = new List<TemplateSectionDef>
        {
            new()
            {
                Id = "went-well", Title = "做得好的 (Keep)", Type = "list", Required = true, Order = 0,
                Placeholder = "本周/本迭代中做得好的事情，值得继续保持", MaxItems = 10
            },
            new()
            {
                Id = "improve", Title = "待改进的 (Improve)", Type = "list", Required = true, Order = 1,
                Placeholder = "本周/本迭代中需要改进的点", MaxItems = 10
            },
            new()
            {
                Id = "action-items", Title = "行动项 (Action)", Type = "table", Required = true, Order = 2,
                Placeholder = "针对改进点制定的具体行动",
                Columns = new List<TableColumnDef>
                {
                    new() { Name = "行动项", Type = "text", Width = "2fr" },
                    new() { Name = "负责人", Type = "text" },
                    new() { Name = "截止日期", Type = "date" },
                    new() { Name = "状态", Type = "select", Options = new List<string> { "待开始", "进行中", "已完成" } },
                }
            },
            new()
            {
                Id = "velocity", Title = "交付速率", Type = "text", Required = false, Order = 3,
                Placeholder = "本迭代实际交付的故事点/需求数 vs 计划"
            },
            new()
            {
                Id = "next-sprint", Title = "下个迭代目标", Type = "text", Required = true, Order = 4,
                Placeholder = "下个迭代的核心目标和关键交付件"
            },
        }
    };
}
