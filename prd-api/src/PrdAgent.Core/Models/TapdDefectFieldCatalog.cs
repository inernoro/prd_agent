namespace PrdAgent.Core.Models;

/// <summary>
/// TAPD 缺陷字段 SSOT（与 CapsuleExecutor.MapBugFieldsToChinese / TAPD API custom_field_* 对齐）。
/// 导入与产品内详情页共用同一套中文 key，值落在 DefectReport.StructuredData 或实体字段。
/// </summary>
public static class TapdDefectFieldCatalog
{
    public const string DefectId = "缺陷ID";
    public const string Title = "标题";
    public const string Reporter = "创建人";
    public const string Created = "创建时间";
    public const string IssueStartTime = "问题开始时间";
    public const string Resolved = "解决时间";
    public const string Closed = "关闭时间";
    public const string Due = "预计结束时间";
    public const string CurrentOwner = "处理人";
    public const string Status = "状态";
    public const string ResponsiblePerson = "责任人";
    public const string Overdue = "是否逾期";
    public const string ValidReport = "有效报告";
    /// <summary>TAPD 自定义「缺陷等级」(custom_field_6)，与标准导出列「严重程度」不同。</summary>
    public const string DefectGrade = "缺陷等级";
    /// <summary>产品管理 V2.6 严重程度（致命/严重/一般/轻微），存 StructuredData。</summary>
    public const string DefectSeverity = "严重程度";
    /// <summary>TAPD 导出「严重程度」列原文（紧急/高/中/低/无关紧要），导入镜像。</summary>
    public const string TapdSeveritySource = "TAPD严重程度";
    public const string DefectDivision = "缺陷划分";
    public const string FeedbackPerson = "反馈人";
    public const string CompanyName = "公司名称";
    public const string MerchantNo = "商户编号";
    public const string IntroducedProject = "引入项目";
    public const string FeedbackTime = "反馈时间";
    public const string ImpactScope = "影响范围";
    public const string StructureParent = "结构归母";
    public const string LogicAttribution = "逻辑归因";
    public const string UrlLink = "URL链接";
    public const string LinksInDescription = "描述中的链接";
    public const string IsHistorical = "是否历史问题";
    public const string TimelyFixed = "及时处理";

    /// <summary>详情页右侧属性栏展示顺序（与 TAPD 查看页一致）。</summary>
    public static readonly string[] SidebarFieldKeys =
    {
        DefectId, Status, CurrentOwner, Reporter, Created, DefectSeverity, DefectDivision,
        ResponsiblePerson, Overdue, ValidReport, FeedbackPerson, CompanyName, MerchantNo,
        IntroducedProject, FeedbackTime, ImpactScope, StructureParent, LogicAttribution,
        IssueStartTime, Due, Resolved, Closed, UrlLink, IsHistorical, TimelyFixed,
    };

    /// <summary>写入 StructuredData 时同步缺陷划分到 ProductDefectClassification。</summary>
    public static void SyncClassificationToEntity(DefectReport defect)
    {
        if (defect.StructuredData.TryGetValue(DefectDivision, out var div) && !string.IsNullOrWhiteSpace(div))
            defect.ProductDefectClassification = ProductDefectLinkageCatalog.NormalizeClassification(div);
        else if (!string.IsNullOrWhiteSpace(defect.ProductDefectClassification)
                 && !defect.StructuredData.ContainsKey(DefectDivision))
            defect.StructuredData[DefectDivision] = defect.ProductDefectClassification;
    }

    public static Dictionary<string, string> MergeStructuredData(
        Dictionary<string, string>? existing,
        Dictionary<string, string>? patch)
    {
        var merged = existing != null ? new Dictionary<string, string>(existing) : new Dictionary<string, string>();
        if (patch == null) return merged;
        foreach (var (k, v) in patch)
            merged[k] = v ?? string.Empty;
        return merged;
    }
}
