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

    /// <summary>执行编排身份；HTML PPT 固定为 html-ppt-pipeline。</summary>
    public string Runtime { get; set; } = "html-ppt-pipeline";

    /// <summary>设计实现适配器身份；用于区分未来可替换的设计插件。</summary>
    public string Provider { get; set; } = "open-design-html-ppt";

    /// <summary>
    /// 与公共 DesignArtifact 生命周期合同绑定的版本。0 表示历史专用 Run；
    /// 当前新建 Run 固定写 v2，恢复器只枚举显式标记过的记录，禁止猜测升级历史数据。
    /// </summary>
    public int ArtifactContractVersion { get; set; }

    /// <summary>
    /// 专用 Run 当前事实已投影到公共账本的时间。生成新事实时先清空，投影完成后再写入，
    /// 使进程中断后的半完成状态可被数据库枚举恢复。
    /// </summary>
    public DateTime? ArtifactContractSynchronizedAt { get; set; }

    public string Theme { get; set; } = string.Empty;

    /// <summary>convert | patch | manual-edit | outline</summary>
    public string Op { get; set; } = "convert";

    /// <summary>精修任务所依据的上一条 run；只接受同一用户已持久化的服务端 run。</summary>
    public string? ParentRunId { get; set; }

    /// <summary>最终生成所依据的大纲 Run；用于把人工确认的大纲绑定到同一组知识哈希。</summary>
    public string? ParentOutlineRunId { get; set; }

    /// <summary>公共规划任务完成时冻结的原始大纲哈希；生成任务据此校验父规划输出。</summary>
    public string? ParentPlanContentHash { get; set; }

    /// <summary>区分客户端输入与服务端知识快照，禁止把混合输入整体标成知识权威。</summary>
    public string InputAuthority { get; set; } = DesignArtifactInputAuthorities.UserSupplied;

    /// <summary>客户端提供的内容分区 SHA-256；知识正文仍以 KnowledgeReferences 为权威。</summary>
    public string? UserSuppliedContentHash { get; set; }

    /// <summary>用于历史列表展示的标题（取自首个标题行或内容前缀）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>输入内容前缀（历史预览用，截断）</summary>
    public string ContentPreview { get; set; } = string.Empty;

    /// <summary>生成完成的 HTML（convert/patch done 时填充）</summary>
    public string Html { get; set; } = string.Empty;

    /// <summary>当前完成态 HTML 的 SHA-256；用于精修与发布内容绑定。</summary>
    public string? HtmlHash { get; set; }

    /// <summary>精修任务所依据父产物的 SHA-256。</summary>
    public string? ParentHtmlHash { get; set; }

    /// <summary>
    /// 大纲结果 JSON（op=outline done 时填充）。服务器权威性：大纲生成不随
    /// 客户端断开/刷新而消亡，刷新后前端按 runId 取回这里的结果继续。
    /// 形如 {"totalPages":N,"summary":"...","clarify":[...],"outline":[{title,bullets,design}...]}
    /// </summary>
    public string? OutlineJson { get; set; }

    /// <summary>模型生成大纲的规范化 SHA-256，用于区分原始建议与用户确认稿。</summary>
    public string? OutlineHash { get; set; }

    /// <summary>用户点击确认时提交、由服务器规范化后保存的大纲；convert 只能使用这一份。</summary>
    public string? ConfirmedOutlineJson { get; set; }

    /// <summary>用户确认稿的规范化 SHA-256；convert 必须与客户端本次提交逐字义一致。</summary>
    public string? ConfirmedOutlineHash { get; set; }

    /// <summary>用户确认时完整 convert 输入的 SHA-256，防止确认后替换正文或澄清答案。</summary>
    public string? ConfirmedContentHash { get; set; }

    public DateTime? OutlineConfirmedAt { get; set; }

    public string? Error { get; set; }

    public string? Model { get; set; }

    public string? Platform { get; set; }

    /// <summary>并行页级生成最终被采用的实际模型集合；不记录被丢弃重试的模型。</summary>
    public List<string> ResolvedModels { get; set; } = new();

    /// <summary>与最终被采用页面对应的实际模型平台集合。</summary>
    public List<string> ResolvedPlatforms { get; set; } = new();

    /// <summary>html-ppt | knowledge-base，记录本次生成从哪个业务入口发起。</summary>
    public string SourceSurface { get; set; } = DesignArtifactSourceSurfaces.HtmlPpt;

    /// <summary>生成时使用的知识快照，用于跨知识库、PPT 与托管站点追溯。</summary>
    public List<DesignKnowledgeSnapshot> KnowledgeReferences { get; set; } = new();

    /// <summary>发布到网页托管后的站点 ID。</summary>
    public string? PublishedSiteId { get; set; }

    /// <summary>网页托管侧的稳定版本标识；与源 manifest 哈希分开保存。</summary>
    public string? PublishedVersionId { get; set; }

    /// <summary>实际发布内容的 SHA-256，必须与当前完成态 HTML 一致。</summary>
    public string? PublishedHtmlHash { get; set; }

    /// <summary>发布意图的稳定幂等键；同一个完成态 Run 和内容哈希只能对应一个意图。</summary>
    public string? PublishIntentId { get; set; }

    /// <summary>pending | running | retry | completed | dead-letter。</summary>
    public string? PublishIntentStatus { get; set; }

    /// <summary>CreateFromHtml 最终实际发布字节的 SHA-256。</summary>
    public string? PublishIntentHtmlHash { get; set; }

    public string? PublishIntentTitle { get; set; }
    public string? PublishIntentDescription { get; set; }
    public List<string> PublishIntentTags { get; set; } = new();
    public List<string> PublishIntentTeamIds { get; set; } = new();
    public string? PublishIntentLeaseOwnerId { get; set; }
    public DateTime? PublishIntentLeaseExpiresAt { get; set; }
    public int PublishIntentAttemptCount { get; set; }
    public DateTime? PublishIntentNextAttemptAt { get; set; }
    public string? PublishIntentLastFailureCode { get; set; }
    public DateTime? PublishIntentCompletedAt { get; set; }

    /// <summary>公共生命周期恢复的失败退避；到达上限后进入 dead-letter，避免永久热循环。</summary>
    public int ArtifactRecoveryAttemptCount { get; set; }
    public DateTime? ArtifactRecoveryNextAttemptAt { get; set; }
    public string? ArtifactRecoveryLastFailureCode { get; set; }
    public DateTime? ArtifactRecoveryDeadLetteredAt { get; set; }

    /// <summary>退化为「标题+要点」兜底的页数（并行逐页路径 done 时落库，刷新恢复仍能如实告警）</summary>
    public int Degraded { get; set; }

    /// <summary>总页数（与 Degraded 配对，恢复路径据此还原「共 N 页其中 X 页降级」文案）</summary>
    public int Total { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
