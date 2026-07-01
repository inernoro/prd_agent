using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 邮件模板：把常用流程（审批 / 申请 / 汇报 / 通知 / 交接 等）的写法沉淀下来，
/// 包含内容描述（审批对象 + 正文）、发送对象、抄送对象、可微调的占位符变量。
/// 目标：一键复制成品后只需填几个变量即可发送，省去每次咨询相关人员 / 翻历史邮件 / 问 AI 的时间。
/// </summary>
[AppOwnership(AppNames.EmailAgent, AppNames.EmailAgentDisplay, IsPrimary = true)]
public class EmailTemplate
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称（如 "请假审批申请"）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>流程分类 key（见 <see cref="EmailTemplateCategory"/>）</summary>
    public string Category { get; set; } = EmailTemplateCategory.Other;

    /// <summary>适用场景描述（什么时候用这个模板）</summary>
    public string? Scenario { get; set; }

    /// <summary>邮件主题（可含占位符 {{变量}}）</summary>
    public string Subject { get; set; } = string.Empty;

    /// <summary>审批对象 / 内容描述（谁来审批、要点是什么，可含占位符）</summary>
    public string? ApprovalTarget { get; set; }

    /// <summary>邮件正文（可含占位符 {{变量}}）</summary>
    public string Body { get; set; } = string.Empty;

    /// <summary>发送对象（收件人）</summary>
    public List<EmailRecipient> ToRecipients { get; set; } = new();

    /// <summary>抄送对象</summary>
    public List<EmailRecipient> CcRecipients { get; set; } = new();

    /// <summary>占位符变量定义（用于一键复制前的快速微调）</summary>
    public List<EmailTemplateVariable> Variables { get; set; } = new();

    /// <summary>是否为系统预置模板（不可删除；用户可 "另存为" 派生自己的副本）</summary>
    public bool IsSystem { get; set; }

    /// <summary>系统预置模板的稳定 key（仅 IsSystem = true 时有值）</summary>
    public string? TemplateKey { get; set; }

    /// <summary>复用次数（点击 "一键复制" 时 +1，用于热门排序）</summary>
    public int UsageCount { get; set; }

    /// <summary>创建人 UserId（系统模板为 "system"）</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建人显示名（快照，便于介绍页展示作者）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 邮件收件人 / 抄送人。Email 可空——很多时候只知道 "直属主管 / 人事" 这样的角色，
/// 由使用者复制后自行补全实际邮箱，模板负责记住 "该发给谁 / 抄给谁"。
/// </summary>
public class EmailRecipient
{
    /// <summary>显示名 / 角色（如 "直属主管"、"张三"、"人事部"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>邮箱地址（可空）</summary>
    public string? Email { get; set; }

    /// <summary>备注（如 "审批人"、"知会即可"）</summary>
    public string? Note { get; set; }
}

/// <summary>
/// 模板占位符变量定义。正文 / 主题里用 {{Key}} 引用，前端渲染成表单让用户填，
/// 一键复制时把 {{Key}} 替换成填写值，实现 "复制后微调一下就能用"。
/// </summary>
public class EmailTemplateVariable
{
    /// <summary>变量 key（在正文里以 {{key}} 引用，稳定标识）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>显示标签（中文）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>输入占位提示</summary>
    public string? Placeholder { get; set; }

    /// <summary>默认值</summary>
    public string? DefaultValue { get; set; }

    /// <summary>是否多行文本（正文类变量）</summary>
    public bool Multiline { get; set; }
}

/// <summary>
/// 邮件模板流程分类。
/// </summary>
public static class EmailTemplateCategory
{
    public const string Approval = "approval";   // 审批
    public const string Apply = "apply";         // 申请
    public const string Report = "report";       // 汇报
    public const string Notice = "notice";       // 通知
    public const string Handover = "handover";   // 交接
    public const string Other = "other";         // 其他

    public static readonly string[] All = { Approval, Apply, Report, Notice, Handover, Other };

    /// <summary>分类 key -> 中文标签</summary>
    public static readonly IReadOnlyDictionary<string, string> Labels = new Dictionary<string, string>
    {
        [Approval] = "审批",
        [Apply] = "申请",
        [Report] = "汇报",
        [Notice] = "通知",
        [Handover] = "交接",
        [Other] = "其他",
    };

    public static bool IsValid(string? category) =>
        !string.IsNullOrWhiteSpace(category) && Array.IndexOf(All, category) >= 0;
}

/// <summary>
/// 系统预置邮件模板：覆盖职场高频流程，开箱即用。首次访问时按 TemplateKey 幂等注入到数据库。
/// </summary>
public static class SystemEmailTemplates
{
    public const string LeaveApproval = "leave-approval";
    public const string OvertimeApply = "overtime-apply";
    public const string ProjectReport = "project-report";
    public const string MeetingNotice = "meeting-notice";
    public const string WorkHandover = "work-handover";
    public const string ReimbursementApproval = "reimbursement-approval";

    public static List<EmailTemplate> GetAll() => new()
    {
        new EmailTemplate
        {
            Title = "请假审批申请",
            Category = EmailTemplateCategory.Approval,
            Scenario = "向直属主管申请请假，抄送人事备案。",
            TemplateKey = LeaveApproval,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【请假申请】{{name}} {{startDate}} 至 {{endDate}}（{{leaveType}}）",
            ApprovalTarget = "审批人：直属主管；内容：{{name}} 因 {{reason}} 申请 {{leaveType}}，共 {{days}} 天。",
            Body =
                "尊敬的 {{approver}}：\n\n" +
                "您好！我是 {{name}}（{{dept}}）。因 {{reason}}，特申请 {{leaveType}}，" +
                "时间为 {{startDate}} 至 {{endDate}}，共计 {{days}} 天。\n\n" +
                "请假期间的工作已交接给 {{backup}}，紧急事项可通过 {{phone}} 联系我。\n\n" +
                "恳请批准，谢谢！\n\n{{name}}\n{{applyDate}}",
            ToRecipients = new List<EmailRecipient>
            {
                new() { Name = "直属主管", Note = "审批人" },
            },
            CcRecipients = new List<EmailRecipient>
            {
                new() { Name = "人事部", Note = "备案知会" },
            },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "approver", Label = "审批人称呼", Placeholder = "如：王经理", DefaultValue = "王经理" },
                new() { Key = "name", Label = "本人姓名", Placeholder = "你的姓名" },
                new() { Key = "dept", Label = "部门", Placeholder = "如：研发部" },
                new() { Key = "leaveType", Label = "请假类型", Placeholder = "年假 / 事假 / 病假", DefaultValue = "年假" },
                new() { Key = "reason", Label = "请假事由", Placeholder = "简述原因", Multiline = true },
                new() { Key = "startDate", Label = "开始日期", Placeholder = "2026-07-10" },
                new() { Key = "endDate", Label = "结束日期", Placeholder = "2026-07-11" },
                new() { Key = "days", Label = "天数", Placeholder = "2" },
                new() { Key = "backup", Label = "工作交接人", Placeholder = "同事姓名" },
                new() { Key = "phone", Label = "紧急联系电话", Placeholder = "手机号" },
                new() { Key = "applyDate", Label = "申请日期", Placeholder = "2026-07-08" },
            },
        },
        new EmailTemplate
        {
            Title = "加班申请",
            Category = EmailTemplateCategory.Apply,
            Scenario = "因项目需要申请加班，主管审批、人事抄送。",
            TemplateKey = OvertimeApply,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【加班申请】{{name}} {{overtimeDate}}（{{hours}} 小时）",
            ApprovalTarget = "审批人：直属主管；内容：因 {{reason}} 申请加班 {{hours}} 小时。",
            Body =
                "{{approver}}，您好：\n\n" +
                "因 {{reason}}，需在 {{overtimeDate}} {{timeRange}} 加班，预计 {{hours}} 小时，" +
                "主要处理：{{tasks}}。\n\n" +
                "特此申请，请审批，谢谢！\n\n{{name}}\n{{dept}}",
            ToRecipients = new List<EmailRecipient> { new() { Name = "直属主管", Note = "审批人" } },
            CcRecipients = new List<EmailRecipient> { new() { Name = "人事部", Note = "考勤备案" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "approver", Label = "审批人称呼", DefaultValue = "王经理" },
                new() { Key = "name", Label = "本人姓名" },
                new() { Key = "dept", Label = "部门" },
                new() { Key = "reason", Label = "加班原因", Multiline = true },
                new() { Key = "overtimeDate", Label = "加班日期", Placeholder = "2026-07-12" },
                new() { Key = "timeRange", Label = "时间段", Placeholder = "19:00-22:00" },
                new() { Key = "hours", Label = "时长（小时）", Placeholder = "3" },
                new() { Key = "tasks", Label = "加班事项", Multiline = true },
            },
        },
        new EmailTemplate
        {
            Title = "项目进展汇报",
            Category = EmailTemplateCategory.Report,
            Scenario = "周期性向项目干系人同步进展、风险与下一步计划。",
            TemplateKey = ProjectReport,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【项目周报】{{projectName}} {{weekLabel}} 进展同步",
            ApprovalTarget = "知会对象：项目干系人；内容：本周进展 / 风险 / 下周计划。",
            Body =
                "各位好：\n\n" +
                "现同步 {{projectName}} {{weekLabel}} 进展如下：\n\n" +
                "一、本周完成\n{{done}}\n\n" +
                "二、进行中\n{{inProgress}}\n\n" +
                "三、风险与阻塞\n{{risks}}\n\n" +
                "四、下周计划\n{{nextPlan}}\n\n" +
                "如有疑问欢迎随时沟通，谢谢！\n\n{{name}}\n{{applyDate}}",
            ToRecipients = new List<EmailRecipient>
            {
                new() { Name = "项目经理", Note = "主送" },
                new() { Name = "产品负责人", Note = "主送" },
            },
            CcRecipients = new List<EmailRecipient> { new() { Name = "团队成员", Note = "知会" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "projectName", Label = "项目名称" },
                new() { Key = "weekLabel", Label = "周期标签", Placeholder = "第 28 周 / 7月第2周" },
                new() { Key = "done", Label = "本周完成", Multiline = true },
                new() { Key = "inProgress", Label = "进行中", Multiline = true },
                new() { Key = "risks", Label = "风险与阻塞", Multiline = true, DefaultValue = "暂无" },
                new() { Key = "nextPlan", Label = "下周计划", Multiline = true },
                new() { Key = "name", Label = "本人姓名" },
                new() { Key = "applyDate", Label = "日期" },
            },
        },
        new EmailTemplate
        {
            Title = "会议通知",
            Category = EmailTemplateCategory.Notice,
            Scenario = "组织会议时通知参会人时间、地点、议程。",
            TemplateKey = MeetingNotice,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【会议通知】{{meetingTopic}}（{{meetingTime}}）",
            ApprovalTarget = "通知对象：参会人；内容：会议时间 / 地点 / 议程 / 需准备事项。",
            Body =
                "各位好：\n\n" +
                "现定于 {{meetingTime}} 在 {{location}} 召开「{{meetingTopic}}」会议，请准时参加。\n\n" +
                "会议议程：\n{{agenda}}\n\n" +
                "需提前准备：{{prepare}}\n\n" +
                "如无法参加请提前告知 {{name}}。谢谢！\n\n{{name}}\n{{dept}}",
            ToRecipients = new List<EmailRecipient> { new() { Name = "全体参会人", Note = "主送" } },
            CcRecipients = new List<EmailRecipient> { new() { Name = "部门负责人", Note = "知会" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "meetingTopic", Label = "会议主题" },
                new() { Key = "meetingTime", Label = "会议时间", Placeholder = "2026-07-15 14:00" },
                new() { Key = "location", Label = "会议地点", Placeholder = "3楼会议室 / 腾讯会议" },
                new() { Key = "agenda", Label = "会议议程", Multiline = true },
                new() { Key = "prepare", Label = "需准备事项", DefaultValue = "无" },
                new() { Key = "name", Label = "组织人姓名" },
                new() { Key = "dept", Label = "部门" },
            },
        },
        new EmailTemplate
        {
            Title = "工作交接",
            Category = EmailTemplateCategory.Handover,
            Scenario = "转岗 / 离职 / 休假前向接手人和主管说明交接内容。",
            TemplateKey = WorkHandover,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【工作交接】{{name}} 交接给 {{receiver}}",
            ApprovalTarget = "接手人：{{receiver}}；确认人：直属主管；内容：待办 / 权限 / 文档清单。",
            Body =
                "{{receiver}}、{{approver}}，您好：\n\n" +
                "因 {{reason}}，现将本人工作交接给 {{receiver}}，清单如下：\n\n" +
                "一、进行中的工作\n{{ongoing}}\n\n" +
                "二、账号 / 权限\n{{accounts}}\n\n" +
                "三、关键文档与联系人\n{{docs}}\n\n" +
                "四、注意事项\n{{notes}}\n\n" +
                "交接如有遗漏请随时联系我（{{phone}}）。谢谢！\n\n{{name}}\n{{applyDate}}",
            ToRecipients = new List<EmailRecipient> { new() { Name = "接手人", Note = "主送" } },
            CcRecipients = new List<EmailRecipient>
            {
                new() { Name = "直属主管", Note = "确认" },
                new() { Name = "人事部", Note = "备案" },
            },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "receiver", Label = "接手人姓名" },
                new() { Key = "approver", Label = "主管称呼", DefaultValue = "王经理" },
                new() { Key = "reason", Label = "交接原因", Placeholder = "转岗 / 离职 / 休假" },
                new() { Key = "ongoing", Label = "进行中的工作", Multiline = true },
                new() { Key = "accounts", Label = "账号/权限", Multiline = true },
                new() { Key = "docs", Label = "关键文档与联系人", Multiline = true },
                new() { Key = "notes", Label = "注意事项", Multiline = true, DefaultValue = "无" },
                new() { Key = "name", Label = "本人姓名" },
                new() { Key = "phone", Label = "联系电话" },
                new() { Key = "applyDate", Label = "日期" },
            },
        },
        new EmailTemplate
        {
            Title = "费用报销审批",
            Category = EmailTemplateCategory.Approval,
            Scenario = "提交报销申请给主管审批，抄送财务。",
            TemplateKey = ReimbursementApproval,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【报销申请】{{name}} {{expenseType}} 合计 {{amount}} 元",
            ApprovalTarget = "审批人：直属主管；内容：{{expenseType}} 报销 {{amount}} 元，附发票 {{invoiceCount}} 张。",
            Body =
                "{{approver}}，您好：\n\n" +
                "现提交 {{expenseType}} 报销申请，明细如下：\n\n" +
                "- 事由：{{reason}}\n" +
                "- 金额：{{amount}} 元\n" +
                "- 发生日期：{{expenseDate}}\n" +
                "- 发票数量：{{invoiceCount}} 张（附件）\n\n" +
                "请审批，谢谢！\n\n{{name}}\n{{dept}}",
            ToRecipients = new List<EmailRecipient> { new() { Name = "直属主管", Note = "审批人" } },
            CcRecipients = new List<EmailRecipient> { new() { Name = "财务部", Note = "打款" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "approver", Label = "审批人称呼", DefaultValue = "王经理" },
                new() { Key = "expenseType", Label = "费用类型", Placeholder = "差旅 / 招待 / 采购" },
                new() { Key = "reason", Label = "报销事由", Multiline = true },
                new() { Key = "amount", Label = "金额（元）" },
                new() { Key = "expenseDate", Label = "发生日期" },
                new() { Key = "invoiceCount", Label = "发票数量", DefaultValue = "1" },
                new() { Key = "name", Label = "本人姓名" },
                new() { Key = "dept", Label = "部门" },
            },
        },
    };
}
