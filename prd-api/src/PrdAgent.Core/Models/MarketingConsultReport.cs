namespace PrdAgent.Core.Models;

/// <summary>
/// 营销问策报告 — AI 基于客户全量信息 + 问策知识库（全域粉销 / 4FM 范式）生成的专业营销评估，
/// 服务端固定模板渲染为自包含 HTML（4 套专业模版）。生成即落库；分享走 ShareToken（可撤销），
/// 保存到网页托管记 HostedSiteId。全链路对照「项目简报 PmBriefing」复用。
/// </summary>
public class MarketingConsultReport
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属客户 Id</summary>
    public string CustomerId { get; set; } = string.Empty;

    /// <summary>报告标题（如「XX 商户 营销问策 · 2026-06-15」）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>用户输入的客户情况 / 一键问策聚合的客户信息（生成时给 LLM 的业务输入，留档便于复盘）</summary>
    public string InputText { get; set; } = string.Empty;

    /// <summary>生成所用模型（取自 Gateway Resolution，规则 ai-model-visibility 要求落库）</summary>
    public string? Model { get; set; }

    /// <summary>报告模版 key：exec | consulting | dashboard | magazine（MarketingReportRenderer 模版）</summary>
    public string Template { get; set; } = "exec";

    /// <summary>自包含 HTML 正文（内联样式，可直接下载/托管）</summary>
    public string Html { get; set; } = string.Empty;

    /// <summary>渲染数据快照 JSON（客户硬数据 + AI 结构化内容）。切换模版时据此重渲染，不重新调 LLM；旧数据为空则不支持切换</summary>
    public string? RenderDataJson { get; set; }

    /// <summary>AI 结构化评估内容 JSON（MarketingConsultAiContent 序列化，单独留存便于二次消费/调试）</summary>
    public string? AiContentJson { get; set; }

    /// <summary>分享 token：非空 = 分享已开启，匿名可通过 /api/product/consult/shared/{token} 查看；置空即撤销</summary>
    public string? ShareToken { get; set; }

    /// <summary>保存到网页托管后的站点 Id（HostedSite，可空）</summary>
    public string? HostedSiteId { get; set; }

    /// <summary>托管站点入口 URL（冗余，便于列表/详情直接展示可点链接）</summary>
    public string? HostedSiteUrl { get; set; }

    public string CreatedByUserId { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }

    /// <summary>生成 URL-safe 分享 token（与 PmBriefing / DefectShareLink 同款约定）</summary>
    public static string GenerateShareToken()
        => Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

/// <summary>营销问策 AI 结构化评估内容（LLM 产出 JSON，服务端渲染进固定模板）。对齐全域粉销 / 4FM 语境。</summary>
public class MarketingConsultAiContent
{
    /// <summary>总体评估摘要（2-4 句，给没时间看细节的决策者）</summary>
    public string Summary { get; set; } = string.Empty;

    /// <summary>总体健康判定：healthy | watch | risk（绿/黄/红）</summary>
    public string Verdict { get; set; } = "watch";

    /// <summary>一句话判定依据</summary>
    public string VerdictNote { get; set; } = string.Empty;

    /// <summary>四力评分（产品力 / 渠道力 / 场景力 / 传播力，全域粉销 4FM）</summary>
    public List<MarketingForceScore> Forces { get; set; } = new();

    /// <summary>核心优势（3-6 条）</summary>
    public List<string> Strengths { get; set; } = new();

    /// <summary>风险与问题（含等级）</summary>
    public List<MarketingConsultRisk> Risks { get; set; } = new();

    /// <summary>营销建议（3-6 条，专业可落地）</summary>
    public List<string> Suggestions { get; set; } = new();

    /// <summary>下一步行动（2-5 条，具体可验收，含责任建议）</summary>
    public List<string> NextActions { get; set; } = new();
}

/// <summary>四力（4FM）单维评分。</summary>
public class MarketingForceScore
{
    /// <summary>维度名称：产品力 / 渠道力 / 场景力 / 传播力</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>评分 0-100</summary>
    public int Score { get; set; }

    /// <summary>一句话点评</summary>
    public string Comment { get; set; } = string.Empty;
}

/// <summary>营销问策风险条目。</summary>
public class MarketingConsultRisk
{
    public string Text { get; set; } = string.Empty;
    /// <summary>high | medium | low</summary>
    public string Level { get; set; } = "medium";
}
