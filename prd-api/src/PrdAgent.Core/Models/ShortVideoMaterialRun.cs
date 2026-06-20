namespace PrdAgent.Core.Models;

/// <summary>
/// 短视频素材解析运行记录。
/// </summary>
public class ShortVideoMaterialRun
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>发起用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 归属实例（创建该 run 的部署实例 = git 分支，见 InstanceIdentity）。
    /// 后台 Worker 只领取属于自己实例（或历史无主 null/空）的 run，避免共享 Mongo 下多容器互抢。
    /// </summary>
    public string? OwnerInstanceId { get; set; }

    /// <summary>原始短视频链接</summary>
    public string VideoUrl { get; set; } = string.Empty;

    /// <summary>识别到的平台</summary>
    public string Platform { get; set; } = "unknown";

    /// <summary>素材标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>用户提交时传入的标题，用于后台任务恢复</summary>
    public string? RequestedTitle { get; set; }

    /// <summary>用户提交时附带的字幕/文案，用于后台任务恢复</summary>
    public string? InputSourceText { get; set; }

    /// <summary>素材来源：manual / tikhub-video / metadata-fallback</summary>
    public string SourceMode { get; set; } = "manual";

    /// <summary>短视频解析器返回的元数据 JSON</summary>
    public string? ParsedMetadataJson { get; set; }

    /// <summary>原始视频的 COS 永久地址（source 阶段入库后填充，供卡片稳定播放）</summary>
    public string? SourceVideoUrl { get; set; }

    /// <summary>短视频展示卡片数据（封面/作者/统计等，前端直接渲染，无需解析嵌套 JSON）</summary>
    public ShortVideoCard? Card { get; set; }

    /// <summary>解析过程说明</summary>
    public string? ParserMessage { get; set; }

    /// <summary>状态：queued / running / done / failed。默认 queued——绝不能默认 running，
    /// 否则任何缺省/反序列化出的 run 会被当成"处理中"却永远没人 claim/recover，变成僵尸卡死。</summary>
    public string Status { get; set; } = "queued";

    /// <summary>阶段记录</summary>
    public List<ShortVideoMaterialStage> Stages { get; set; } = new();

    /// <summary>知识库 ID</summary>
    public string? StoreId { get; set; }

    /// <summary>默认选中的产物条目 ID</summary>
    public string? EntryId { get; set; }

    /// <summary>原始视频文件条目 ID</summary>
    public string? SourceEntryId { get; set; }

    /// <summary>原始转写文字条目 ID</summary>
    public string? TranscriptEntryId { get; set; }

    /// <summary>时间轴片段条目 ID（旧运行记录兼容字段，不再默认生成）</summary>
    public string? TimelineEntryId { get; set; }

    /// <summary>错误信息</summary>
    public string? ErrorMessage { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 短视频展示卡片（仿真短视频页面所需的干净字段，由后端从平台原始元数据抽取）。
/// </summary>
public class ShortVideoCard
{
    /// <summary>封面图地址（长效）</summary>
    public string? CoverUrl { get; set; }

    /// <summary>可播放视频地址（优先 COS 永久地址，入库前为空）</summary>
    public string? VideoUrl { get; set; }

    /// <summary>标题/文案首句</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>作者昵称</summary>
    public string? AuthorName { get; set; }

    /// <summary>作者头像地址</summary>
    public string? AuthorAvatarUrl { get; set; }

    /// <summary>平台（douyin / tiktok / ...）</summary>
    public string Platform { get; set; } = "unknown";

    /// <summary>时长（秒）</summary>
    public int? DurationSec { get; set; }

    /// <summary>话题标签（不含 # 前缀）</summary>
    public List<string> Hashtags { get; set; } = new();

    /// <summary>点赞数</summary>
    public long? LikeCount { get; set; }

    /// <summary>评论数</summary>
    public long? CommentCount { get; set; }

    /// <summary>分享数</summary>
    public long? ShareCount { get; set; }

    /// <summary>收藏数</summary>
    public long? CollectCount { get; set; }

    /// <summary>播放数</summary>
    public long? PlayCount { get; set; }
}

public class ShortVideoMaterialStage
{
    /// <summary>阶段键</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>阶段标题</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>阶段状态：pending / running / done / failed</summary>
    public string Status { get; set; } = "pending";

    /// <summary>阶段说明</summary>
    public string Message { get; set; } = string.Empty;

    public DateTime At { get; set; } = DateTime.UtcNow;
}
