namespace PrdAgent.Core.Security;

/// <summary>
/// 管理后台权限点清单（代码侧稳定定义，分配关系存储在 DB）。
/// 说明：
/// - 权限点是"合约"，需要稳定；不建议频繁改 key。
/// - 菜单/路由/接口的准入建议都绑定到这些 key 上，避免"只藏菜单不控访问"的不一致。
/// - 权限格式：appKey.action（如 users.read, mds.write）
/// </summary>
public static class AdminPermissionCatalog
{
    /// <summary>后台访问权限（基础准入）</summary>
    public const string Access = "access";

    /// <summary>权限管理权限</summary>
    public const string AuthzManage = "authz.manage";

    public const string UsersRead = "users.read";
    public const string UsersWrite = "users.write";

    public const string GroupsRead = "groups.read";
    public const string GroupsWrite = "groups.write";

    public const string ModelsRead = "mds.read";
    public const string ModelsWrite = "mds.write";

    public const string LogsRead = "logs.read";

    public const string OpenPlatformManage = "open-platform.manage";

    /// <summary>自动化规则管理权限</summary>
    public const string AutomationsManage = "automations.manage";

    public const string DataRead = "data.read";
    public const string DataWrite = "data.write";

    public const string AssetsRead = "assets.read";
    public const string AssetsWrite = "assets.write";

    public const string SettingsRead = "settings.read";
    public const string SettingsWrite = "settings.write";

    public const string PromptsRead = "prompts.read";
    public const string PromptsWrite = "prompts.write";

    public const string SkillsRead = "skills.read";
    public const string SkillsWrite = "skills.write";

    public const string LabRead = "lab.read";
    public const string LabWrite = "lab.write";

    /// <summary>
    /// PRD Agent 权限：PRD 智能解读与问答功能
    /// </summary>
    public const string PrdAgentUse = "prd-agent.use";

    /// <summary>
    /// 视觉创作 Agent 权限：高级视觉创作工作区
    /// </summary>
    public const string VisualAgentUse = "visual-agent.use";

    /// <summary>
    /// 文学创作 Agent 权限：文章配图智能生成
    /// </summary>
    public const string LiteraryAgentUse = "literary-agent.use";

    /// <summary>
    /// 缺陷管理 Agent 权限：提交和查看缺陷
    /// </summary>
    public const string DefectAgentUse = "defect-agent.use";

    /// <summary>
    /// 缺陷管理 Agent 管理权限：设置模板、指派处理人
    /// </summary>
    public const string DefectAgentManage = "defect-agent.manage";

    /// <summary>
    /// 视频 Agent 权限：文章转视频教程生成
    /// </summary>
    public const string VideoAgentUse = "video-agent.use";

    /// <summary>
    /// AI 百宝箱权限：使用百宝箱功能
    /// </summary>
    public const string AiToolboxUse = "ai-toolbox.use";

    /// <summary>
    /// AI 百宝箱管理权限：管理工作流、配置等
    /// </summary>
    public const string AiToolboxManage = "ai-toolbox.manage";

    /// <summary>
    /// 数据迁移 Agent 权限（读）：查看实体与集合映射、数据预览
    /// </summary>
    public const string DataMigrationAgentUse = "data-migration-agent.use";

    /// <summary>
    /// 数据迁移 Agent 权限（写）：删除集合、删除文档、修复数据
    /// </summary>
    public const string DataMigrationAgentWrite = "data-migration-agent.write";

    /// <summary>
    /// 总裁面板权限：查看总裁面板和周报
    /// </summary>
    public const string ExecutiveRead = "executive.read";

    /// <summary>
    /// 教程邮件管理权限（读）：查看序列、模板、发送记录
    /// </summary>
    public const string TutorialEmailRead = "tutorial-email.read";

    /// <summary>
    /// 教程邮件管理权限（写）：编辑序列、模板、触发发送
    /// </summary>
    public const string TutorialEmailWrite = "tutorial-email.write";

    /// <summary>
    /// 工作流引擎权限：使用工作流（创建、执行、查看自己的）
    /// </summary>
    public const string WorkflowAgentUse = "workflow-agent.use";

    /// <summary>
    /// 工作流引擎管理权限：管理所有工作流 + 查看所有执行记录
    /// </summary>
    public const string WorkflowAgentManage = "workflow-agent.manage";

    /// <summary>
    /// 超级权限（当路由未配置映射时，用于兜底放行；同时也可用于 root 破窗全权限）。
    /// </summary>
    public const string Super = "super";

    public static readonly IReadOnlyList<AdminPermissionDef> All = new List<AdminPermissionDef>
    {
        new(Access, "后台访问", "允许进入管理后台"),
        new(AuthzManage, "权限管理", "管理系统角色/用户权限"),
        new(PrdAgentUse, "PRD Agent", "PRD 智能解读与问答"),
        new(VisualAgentUse, "视觉创作 Agent", "高级视觉创作工作区"),
        new(LiteraryAgentUse, "文学创作 Agent", "文章配图智能生成"),
        new(DefectAgentUse, "缺陷管理 Agent", "提交和查看缺陷"),
        new(DefectAgentManage, "缺陷管理 Agent-管理", "设置模板、指派处理人"),
        new(VideoAgentUse, "视频 Agent", "文章转视频教程生成"),
        new(AiToolboxUse, "AI 百宝箱", "使用 AI 百宝箱功能"),
        new(AiToolboxManage, "AI 百宝箱-管理", "管理工作流、配置等"),
        new(DataMigrationAgentUse, "数据迁移 Agent-读", "查看实体与集合映射、数据预览"),
        new(DataMigrationAgentWrite, "数据迁移 Agent-写", "删除集合、删除文档、修复数据"),

        new(UsersRead, "用户管理-读", "查看用户列表/详情"),
        new(UsersWrite, "用户管理-写", "创建/编辑/禁用/重置密码等"),

        new(GroupsRead, "群组管理-读", "查看群组与成员"),
        new(GroupsWrite, "群组管理-写", "编辑群组/成员等"),

        new(ModelsRead, "模型管理-读", "查看平台/模型/配置"),
        new(ModelsWrite, "模型管理-写", "编辑平台/模型/配置/调度等"),

        new(LogsRead, "日志-读", "查看系统/LLM/API 请求日志"),

        new(OpenPlatformManage, "开放平台", "管理开放平台 App / 调用方 / 日志"),

        new(AutomationsManage, "自动化", "管理自动化规则与事件通知"),

        new(DataRead, "数据管理-读", "查看导入导出/摘要"),
        new(DataWrite, "数据管理-写", "执行导入/清理等危险操作"),

        new(AssetsRead, "资产-读", "查看/下载资产"),
        new(AssetsWrite, "资产-写", "上传/删除资产"),

        new(SettingsRead, "设置-读", "查看系统设置"),
        new(SettingsWrite, "设置-写", "修改系统设置"),

        new(PromptsRead, "提示词-读", "查看提示词配置"),
        new(PromptsWrite, "提示词-写", "编辑提示词配置"),

        new(SkillsRead, "技能-读", "查看技能配置"),
        new(SkillsWrite, "技能-写", "创建/编辑/删除技能"),

        new(LabRead, "实验室-读", "查看实验室功能"),
        new(LabWrite, "实验室-写", "使用实验室功能"),

        new(ExecutiveRead, "总裁面板-读", "查看总裁面板和周报"),

        new(TutorialEmailRead, "教程邮件-读", "查看教程邮件序列、模板与发送记录"),
        new(TutorialEmailWrite, "教程邮件-写", "编辑序列、模板、触发发送"),

        new(WorkflowAgentUse, "工作流引擎", "创建和执行自动化工作流"),
        new(WorkflowAgentManage, "工作流引擎-管理", "管理所有工作流与执行记录"),

        new(Super, "超级权限", "兜底放行：建议仅给 root/超级管理员"),
    };
}

public sealed record AdminPermissionDef(string Key, string Name, string? Description);
