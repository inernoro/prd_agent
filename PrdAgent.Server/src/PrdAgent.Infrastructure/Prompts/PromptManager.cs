using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Prompts;

/// <summary>
/// Prompt模板管理器
/// </summary>
public class PromptManager
{
    private readonly Dictionary<UserRole, string> _rolePrompts;
    private readonly Dictionary<UserRole, List<GuideOutlineItem>> _guideOutlines;

    public PromptManager()
    {
        _rolePrompts = InitializeRolePrompts();
        _guideOutlines = InitializeGuideOutlines();
    }

    /// <summary>获取角色系统Prompt</summary>
    public string GetRolePrompt(UserRole role)
    {
        return _rolePrompts.TryGetValue(role, out var prompt) 
            ? prompt 
            : _rolePrompts[UserRole.PM];
    }

    /// <summary>获取引导讲解大纲</summary>
    public List<GuideOutlineItem> GetGuideOutline(UserRole role)
    {
        return _guideOutlines.TryGetValue(role, out var outline)
            ? outline
            : _guideOutlines[UserRole.PM];
    }

    /// <summary>构建完整的系统Prompt</summary>
    public string BuildSystemPrompt(UserRole role, string prdContent)
    {
        var rolePrompt = GetRolePrompt(role);
        return $@"{rolePrompt}

---

# PRD文档内容

{prdContent}

---

请基于上述PRD文档内容回答用户问题。如果问题涉及文档中未提及的内容，请明确告知"文档中未找到相关信息"。";
    }

    private Dictionary<UserRole, string> InitializeRolePrompts()
    {
        return new Dictionary<UserRole, string>
        {
            [UserRole.PM] = @"# 角色定义
你是一位资深产品经理，正在为团队成员讲解产品需求文档（PRD）。

# 核心职责
- 从业务价值和用户体验角度解读需求
- 帮助团队理解产品决策背后的思考
- 明确优先级和迭代节奏

# 关注领域
1. 业务背景与问题定义
2. 目标用户与使用场景
3. 核心价值主张
4. 功能优先级与迭代规划
5. 成功指标与验收标准

# 回答风格
- 使用业务语言，避免过度技术化
- 多解释"为什么"，而不仅是"是什么"
- 用具体案例和场景辅助说明
- 主动提及可能的风险和权衡

# 边界约束
- 只回答与当前PRD文档相关的问题
- 如果问题超出PRD范围，友好告知并引导回到文档内容
- 不编造文档中不存在的信息",

            [UserRole.DEV] = @"# 角色定义
你是一位资深技术架构师，正在为开发团队解读产品需求文档（PRD）中的技术要求。

# 核心职责
- 从技术实现角度解读需求
- 识别技术方案和架构设计要点
- 明确接口规格和数据模型

# 关注领域
1. 技术架构与系统设计
2. 数据模型与数据库设计
3. 接口设计与API规格
4. 状态流转与业务逻辑
5. 技术约束与依赖
6. 性能要求与边界条件

# 回答风格
- 使用精确的技术语言
- 关注"怎么实现"和"实现细节"
- 用伪代码、数据结构辅助说明
- 主动指出可能的技术风险和坑点

# 边界约束
- 只回答与当前PRD文档相关的问题
- 如果问题超出PRD范围，友好告知并引导回到文档内容
- 不编造文档中不存在的信息",

            [UserRole.QA] = @"# 角色定义
你是一位资深测试工程师，正在为测试团队解读产品需求文档（PRD）中的测试要点。

# 核心职责
- 从质量保障角度解读需求
- 识别测试重点和测试边界
- 明确验收标准和测试场景

# 关注领域
1. 功能测试点清单
2. 边界条件与约束
3. 异常场景与错误处理
4. 验收标准与预期结果
5. 测试优先级与风险评估
6. 兼容性与性能要求

# 回答风格
- 注重完备性和边界覆盖
- 关注"怎么验证"和"预期结果"
- 用测试用例格式辅助说明
- 主动提出可能遗漏的测试场景

# 边界约束
- 只回答与当前PRD文档相关的问题
- 如果问题超出PRD范围，友好告知并引导回到文档内容
- 不编造文档中不存在的信息",

            [UserRole.ADMIN] = @"# 角色定义
你是系统管理员助手，帮助回答关于PRD文档的问题。

# 回答风格
- 提供全面、中立的回答
- 涵盖业务、技术和测试各个角度

# 边界约束
- 只回答与当前PRD文档相关的问题
- 不编造文档中不存在的信息"
        };
    }

    private Dictionary<UserRole, List<GuideOutlineItem>> InitializeGuideOutlines()
    {
        return new Dictionary<UserRole, List<GuideOutlineItem>>
        {
            [UserRole.PM] = new List<GuideOutlineItem>
            {
                new() { Step = 1, Title = "项目背景与问题定义", PromptTemplate = "请概述这份PRD的项目背景和要解决的核心问题。" },
                new() { Step = 2, Title = "核心用户与使用场景", PromptTemplate = "请介绍这份PRD中定义的目标用户群体和主要使用场景。" },
                new() { Step = 3, Title = "解决方案概述", PromptTemplate = "请概述这份PRD提出的解决方案，包括核心功能和设计思路。" },
                new() { Step = 4, Title = "核心功能清单", PromptTemplate = "请详细列出这份PRD中的核心功能点，按优先级排列。" },
                new() { Step = 5, Title = "优先级与迭代规划", PromptTemplate = "请说明这份PRD中的功能优先级划分和迭代规划。" },
                new() { Step = 6, Title = "成功指标与验收标准", PromptTemplate = "请说明这份PRD定义的成功指标和验收标准。" }
            },
            [UserRole.DEV] = new List<GuideOutlineItem>
            {
                new() { Step = 1, Title = "技术方案概述", PromptTemplate = "请从技术角度概述这份PRD涉及的技术架构和关键技术点。" },
                new() { Step = 2, Title = "核心数据模型", PromptTemplate = "请分析这份PRD中涉及的核心数据实体和数据模型设计。" },
                new() { Step = 3, Title = "主流程与状态流转", PromptTemplate = "请详细说明这份PRD中的主要业务流程和状态流转逻辑。" },
                new() { Step = 4, Title = "接口清单与规格", PromptTemplate = "请列出这份PRD中涉及的接口清单和接口规格要求。" },
                new() { Step = 5, Title = "技术约束与依赖", PromptTemplate = "请说明这份PRD中提到的技术约束、依赖和限制条件。" },
                new() { Step = 6, Title = "开发工作量要点", PromptTemplate = "请从开发角度分析这份PRD的关键工作量要点和技术风险。" }
            },
            [UserRole.QA] = new List<GuideOutlineItem>
            {
                new() { Step = 1, Title = "功能模块清单", PromptTemplate = "请列出这份PRD中需要测试的功能模块清单。" },
                new() { Step = 2, Title = "核心业务流程", PromptTemplate = "请分析这份PRD中的核心业务流程，确定测试主路径。" },
                new() { Step = 3, Title = "边界条件与约束", PromptTemplate = "请列出这份PRD中的边界条件、输入约束和限制规则。" },
                new() { Step = 4, Title = "异常场景汇总", PromptTemplate = "请汇总这份PRD中涉及的异常场景和错误处理逻辑。" },
                new() { Step = 5, Title = "验收标准明细", PromptTemplate = "请详细列出这份PRD中的验收标准和预期结果。" },
                new() { Step = 6, Title = "测试重点与风险", PromptTemplate = "请总结这份PRD的测试重点和潜在风险点。" }
            }
        };
    }
}

/// <summary>
/// 引导大纲项（重新定义以避免循环引用）
/// </summary>
public class GuideOutlineItem
{
    public int Step { get; set; }
    public string Title { get; set; } = string.Empty;
    public string PromptTemplate { get; set; } = string.Empty;
}

