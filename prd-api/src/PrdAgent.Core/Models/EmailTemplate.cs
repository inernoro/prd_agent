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
/// 系统预置邮件模板：聚焦费用报销、维修申请、设备采购三类高频审批/申请流程，开箱即用。
/// 以代码内置 + sys: 前缀合成返回（不落库），用户可「另存为」派生可编辑副本。
/// </summary>
public static class SystemEmailTemplates
{
    public const string ReimbursementApproval = "reimbursement-approval";
    public const string RepairApply = "repair-apply";
    public const string EquipmentPurchase = "equipment-purchase";

    public static List<EmailTemplate> GetAll() => new()
    {
        new EmailTemplate
        {
            Title = "费用报销审批",
            Category = EmailTemplateCategory.Approval,
            Scenario = "提交报销申请给主管审批，抄送财务打款。",
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
        new EmailTemplate
        {
            Title = "维修申请",
            Category = EmailTemplateCategory.Apply,
            Scenario = "设备 / 设施出现故障，向设备或后勤主管申请安排维修，抄送使用部门。",
            TemplateKey = RepairApply,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【维修申请】{{assetName}} 故障报修（{{urgency}}）",
            ApprovalTarget = "审批人：设备 / 后勤主管；内容：{{assetName}}（{{location}}）出现 {{fault}}，申请安排维修。",
            Body =
                "{{approver}}，您好：\n\n" +
                "现报修如下设备 / 设施，请安排维修处理：\n\n" +
                "- 设备 / 设施名称：{{assetName}}\n" +
                "- 所在位置：{{location}}\n" +
                "- 故障现象：{{fault}}\n" +
                "- 紧急程度：{{urgency}}\n" +
                "- 影响范围：{{impact}}\n" +
                "- 期望完成时间：{{expectDate}}\n\n" +
                "请协调尽快处理，谢谢！\n\n{{name}}\n{{dept}}\n{{applyDate}}",
            ToRecipients = new List<EmailRecipient> { new() { Name = "设备/后勤主管", Note = "审批人" } },
            CcRecipients = new List<EmailRecipient> { new() { Name = "使用部门负责人", Note = "知会" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "approver", Label = "审批人称呼", DefaultValue = "张主管" },
                new() { Key = "assetName", Label = "设备/设施名称", Placeholder = "如：3号裹包机" },
                new() { Key = "location", Label = "所在位置", Placeholder = "如：二车间东侧" },
                new() { Key = "fault", Label = "故障现象", Multiline = true },
                new() { Key = "urgency", Label = "紧急程度", Placeholder = "一般 / 紧急 / 停产", DefaultValue = "一般" },
                new() { Key = "impact", Label = "影响范围", Multiline = true, DefaultValue = "暂不影响生产" },
                new() { Key = "expectDate", Label = "期望完成时间", Placeholder = "2026-07-12" },
                new() { Key = "name", Label = "报修人姓名" },
                new() { Key = "dept", Label = "部门" },
                new() { Key = "applyDate", Label = "申请日期" },
            },
        },
        new EmailTemplate
        {
            Title = "设备采购申请",
            Category = EmailTemplateCategory.Apply,
            Scenario = "需新增 / 更换设备，向部门主管申请采购，抄送采购与财务。",
            TemplateKey = EquipmentPurchase,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "【采购申请】{{itemName}} ×{{quantity}}（预算 {{totalAmount}} 元）",
            ApprovalTarget = "审批人：部门主管 + 采购 / 财务；内容：采购 {{itemName}} {{quantity}} 台/件，预算 {{totalAmount}} 元。",
            Body =
                "{{approver}}，您好：\n\n" +
                "因 {{reason}}，现申请采购以下设备，请审批：\n\n" +
                "- 名称：{{itemName}}\n" +
                "- 规格 / 型号：{{spec}}\n" +
                "- 数量：{{quantity}}\n" +
                "- 预估单价：{{unitPrice}} 元\n" +
                "- 预算合计：{{totalAmount}} 元\n" +
                "- 建议供应商：{{vendor}}\n" +
                "- 期望到货时间：{{expectDate}}\n\n" +
                "用途说明：{{purpose}}\n\n" +
                "请审批，谢谢！\n\n{{name}}\n{{dept}}",
            ToRecipients = new List<EmailRecipient> { new() { Name = "部门主管", Note = "审批人" } },
            CcRecipients = new List<EmailRecipient>
            {
                new() { Name = "采购部", Note = "询价采购" },
                new() { Name = "财务部", Note = "预算" },
            },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "approver", Label = "审批人称呼", DefaultValue = "王经理" },
                new() { Key = "reason", Label = "采购原因", Multiline = true },
                new() { Key = "itemName", Label = "设备名称" },
                new() { Key = "spec", Label = "规格/型号" },
                new() { Key = "quantity", Label = "数量", DefaultValue = "1" },
                new() { Key = "unitPrice", Label = "预估单价（元）" },
                new() { Key = "totalAmount", Label = "预算合计（元）" },
                new() { Key = "vendor", Label = "建议供应商", DefaultValue = "待询价" },
                new() { Key = "expectDate", Label = "期望到货时间", Placeholder = "2026-07-20" },
                new() { Key = "purpose", Label = "用途说明", Multiline = true },
                new() { Key = "name", Label = "申请人姓名" },
                new() { Key = "dept", Label = "部门" },
            },
        },
    };
}
