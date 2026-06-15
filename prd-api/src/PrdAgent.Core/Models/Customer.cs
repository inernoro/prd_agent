namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 客户实体（轻量）。
///
/// 需求连接客户：一条需求可关联多个客户(Requirement.CustomerIds)，用于回答
/// "这个需求是哪些客户提的 / 影响哪些客户"。客户为产品维度下的轻量档案，
/// 不与系统用户体系强绑定（可只填名称 + 联系方式）。
/// </summary>
public class Customer
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>遗留字段：旧版客户按产品绑定；客户已改为全局共享，新建客户此字段为空。</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>客户名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>客户短码（可选）</summary>
    public string? Code { get; set; }

    /// <summary>所属公司 / 组织</summary>
    public string? Company { get; set; }

    /// <summary>联系方式（电话 / 邮箱 / 微信等，自由文本）</summary>
    public string? Contact { get; set; }

    /// <summary>客户描述 / 备注</summary>
    public string? Description { get; set; }

    /// <summary>标签（行业 / 等级 / 来源等）</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>绑定的表单模板 ID（客户也可自定义表单）</summary>
    public string? TemplateId { get; set; }

    /// <summary>自定义表单填写值</summary>
    public Dictionary<string, string> FormData { get; set; } = new();

    // ── 客户信息「基础模块」默认字段（商户名称复用 Name）──

    /// <summary>商户编号</summary>
    public string? MerchantNo { get; set; }

    /// <summary>商户简称</summary>
    public string? ShortName { get; set; }

    /// <summary>商户状态（自由文本，如 正常 / 停用）</summary>
    public string? Status { get; set; }

    /// <summary>认证状态（未认证 / 已认证 / 认证失败）</summary>
    public string? CertStatus { get; set; }

    /// <summary>所在区域</summary>
    public string? Region { get; set; }

    /// <summary>所属行业</summary>
    public string? Industry { get; set; }

    /// <summary>开户时间</summary>
    public DateTime? OpenedAt { get; set; }

    /// <summary>过期时间</summary>
    public DateTime? ExpireAt { get; set; }

    public string OwnerId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}
