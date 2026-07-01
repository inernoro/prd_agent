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
        // 设备采购单盖章申请：贴近真实业务的成品邮件，默认值即样例，复制后按本次单据改几处即可。
        new EmailTemplate
        {
            Title = "设备采购单盖章申请",
            Category = EmailTemplateCategory.Apply,
            Scenario = "与客户签订产线改造合同后，向供应商下单产线设备，提交采购单盖章审批。",
            TemplateKey = EquipmentPurchase,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "{{client}}{{project}}设备采购单盖章申请",
            ApprovalTarget = "审批链：先 @{{approver1}} 审批 → 通过后 @{{approver2}} 复核后盖章。",
            Body =
                "各位下午好：\n" +
                "商户编号：{{merchantNo}}；\n" +
                "公司名称：{{companyName}}；\n" +
                "申请：{{date}}【客户-{{client}}】{{project}}设备采购单【供应商{{supplier}}】采购单盖章申请；\n" +
                "原因：{{reason}}；\n\n" +
                "备注：\n" +
                "{{remark}}\n\n" +
                "请@{{approver1}} 审批。审批通过后请@{{approver2}} 审批，确认后盖章。",
            ToRecipients = new List<EmailRecipient>
            {
                new() { Name = "潘洪玉", Note = "审批" },
                new() { Name = "王冰倩", Note = "复核盖章" },
            },
            CcRecipients = new List<EmailRecipient> { new() { Name = "采购/相关同事", Note = "知会" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "client", Label = "客户简称", DefaultValue = "石湾酒厂" },
                new() { Key = "project", Label = "项目/产线", DefaultValue = "精玉线产线改造" },
                new() { Key = "merchantNo", Label = "商户编号", DefaultValue = "10003295" },
                new() { Key = "companyName", Label = "公司名称", DefaultValue = "广东石湾酒厂集团营销有限公司" },
                new() { Key = "date", Label = "单据日期", DefaultValue = "20260528" },
                new() { Key = "supplier", Label = "供应商", DefaultValue = "腾坤" },
                new() { Key = "reason", Label = "申请原因", Multiline = true, DefaultValue = "与客户石湾酒厂签订了产线改造合同，需要从供应商腾坤下单产线设备以供产线完成安装" },
                new() { Key = "remark", Label = "备注", Multiline = true, DefaultValue = "采购单整体复用以前采购模板，调整部分：\n1、新增第三小节，需要供应商补充硬件通信清单和资料、技术支持以完成 米多赋码采集关联系统 的研发；\n2、第二小节中的《中华人民共和国合同法》已于2021年1月1日被 《中华人民共和国民法典》 取代，已修正。" },
                new() { Key = "approver1", Label = "一级审批人", DefaultValue = "潘洪玉" },
                new() { Key = "approver2", Label = "复核盖章人", DefaultValue = "王冰倩" },
            },
        },
        // 费用报销盖章申请
        new EmailTemplate
        {
            Title = "费用报销盖章申请",
            Category = EmailTemplateCategory.Approval,
            Scenario = "现场支持/差旅等费用报销，提交审批并转财务打款。",
            TemplateKey = ReimbursementApproval,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "{{title}}费用报销盖章申请",
            ApprovalTarget = "审批：@{{approver}} 审批通过后转财务打款。",
            Body =
                "各位好：\n" +
                "现提交费用报销申请如下：\n" +
                "事由：{{reason}}；\n" +
                "金额：{{amount}} 元；\n" +
                "发生日期：{{date}}；\n" +
                "随附发票 {{invoiceCount}} 张；\n\n" +
                "请@{{approver}} 审批，审批通过后转财务打款，谢谢。",
            ToRecipients = new List<EmailRecipient> { new() { Name = "潘洪玉", Note = "审批" } },
            CcRecipients = new List<EmailRecipient> { new() { Name = "财务部", Note = "打款" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "title", Label = "费用主题", DefaultValue = "石湾酒厂现场支持" },
                new() { Key = "reason", Label = "报销事由", Multiline = true, DefaultValue = "赴石湾酒厂精玉线现场支持产线改造调试产生的交通及住宿费用" },
                new() { Key = "amount", Label = "金额（元）", DefaultValue = "2860" },
                new() { Key = "date", Label = "发生日期", DefaultValue = "20260528" },
                new() { Key = "invoiceCount", Label = "发票张数", DefaultValue = "3" },
                new() { Key = "approver", Label = "审批人", DefaultValue = "潘洪玉" },
            },
        },
        // 设备维修申请
        new EmailTemplate
        {
            Title = "设备维修申请",
            Category = EmailTemplateCategory.Apply,
            Scenario = "产线设备/设施出现故障，申请安排维修。",
            TemplateKey = RepairApply,
            IsSystem = true,
            CreatedBy = "system",
            Subject = "{{assetName}}维修申请",
            ApprovalTarget = "审批：@{{approver}} 审批后安排维修。",
            Body =
                "各位好：\n" +
                "现报修设备如下：\n" +
                "设备/设施：{{assetName}}（{{location}}）；\n" +
                "故障现象：{{fault}}；\n" +
                "紧急程度：{{urgency}}；\n" +
                "影响范围：{{impact}}；\n\n" +
                "请@{{approver}} 安排维修，谢谢。",
            ToRecipients = new List<EmailRecipient> { new() { Name = "潘洪玉", Note = "审批" } },
            CcRecipients = new List<EmailRecipient> { new() { Name = "设备/后勤", Note = "执行" } },
            Variables = new List<EmailTemplateVariable>
            {
                new() { Key = "assetName", Label = "设备/设施", DefaultValue = "精玉线裹包机" },
                new() { Key = "location", Label = "所在位置", DefaultValue = "精玉线" },
                new() { Key = "fault", Label = "故障现象", Multiline = true, DefaultValue = "裹膜频繁卡带，无法连续正常运行" },
                new() { Key = "urgency", Label = "紧急程度", DefaultValue = "紧急" },
                new() { Key = "impact", Label = "影响范围", DefaultValue = "影响精玉线正常生产" },
                new() { Key = "approver", Label = "审批人", DefaultValue = "潘洪玉" },
            },
        },
    };
}
