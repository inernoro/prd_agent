namespace PrdAgent.Core.Models;

/// <summary>
/// MD 转网页 PPT 的生成运行记录（server-authority）。
/// 生成在服务端用 CancellationToken.None 执行，客户端断开/刷新不取消；
/// 结果持久化到此集合，刷新后前端可凭 runId 重连/查看，杜绝「刷新就丢、找不到」。
/// </summary>
public class MdToPptRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    /// <summary>running | done | error</summary>
    public string Status { get; set; } = "running";

    /// <summary>map | agent</summary>
    public string Engine { get; set; } = "map";

    public string Theme { get; set; } = string.Empty;

    /// <summary>convert | patch | outline</summary>
    public string Op { get; set; } = "convert";

    /// <summary>用于历史列表展示的标题（取自首个标题行或内容前缀）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>输入内容前缀（历史预览用，截断）</summary>
    public string ContentPreview { get; set; } = string.Empty;

    /// <summary>生成完成的 HTML（convert/patch done 时填充）</summary>
    public string Html { get; set; } = string.Empty;

    /// <summary>
    /// 大纲结果 JSON（op=outline done 时填充）。服务器权威性：大纲生成不随
    /// 客户端断开/刷新而消亡，刷新后前端按 runId 取回这里的结果继续。
    /// 形如 {"totalPages":N,"summary":"...","clarify":[...],"outline":[{title,bullets,design}...]}
    /// </summary>
    public string? OutlineJson { get; set; }

    public string? Error { get; set; }

    public string? Model { get; set; }

    public string? Platform { get; set; }

    /// <summary>退化为「标题+要点」兜底的页数（并行逐页路径 done 时落库，刷新恢复仍能如实告警）</summary>
    public int Degraded { get; set; }

    /// <summary>总页数（与 Degraded 配对，恢复路径据此还原「共 N 页其中 X 页降级」文案）</summary>
    public int Total { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
