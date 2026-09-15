using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 智能体经 MCP 调用平台能力的一条记录 —— 接入台「刚刚发生了什么」那一列的数据源。
///
/// 为什么单独一张表而不是复用 OpenApiRequestLog：那张表记的是 OpenAI 兼容网关的
/// token 计费流水，字段与语义都不同；这里要记的是「哪台客户端、用哪个工具、
/// 做了什么、产出了什么、能不能点开看」。
///
/// 记录只增不改，产物删了记录仍在（用户要能回溯「智能体当时到底干了什么」）。
/// </summary>
[BsonIgnoreExtraElements]
public class McpCallLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>密钥主人（= 记录的可见范围）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>哪把密钥（= 哪台客户端）</summary>
    public string KeyId { get; set; } = string.Empty;

    /// <summary>密钥当时的名字，写死在记录里；密钥改名或撤销后历史记录仍读得懂</summary>
    public string KeyName { get; set; } = string.Empty;

    /// <summary>工具名，如 map_web_publish_page</summary>
    public string ToolName { get; set; } = string.Empty;

    /// <summary>归属的能力卡 key（visual / literary / knowledge / web / market），无法归类时为空</summary>
    public string? Capability { get; set; }

    /// <summary>success | error | denied（scope 不足、配额触顶、白名单拦截都算 denied）</summary>
    public string Status { get; set; } = "success";

    /// <summary>失败原因（给用户看的中文说明，不是堆栈）</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>回环调用真实接口拿到的 HTTP 状态；denied 时为 0</summary>
    public int HttpStatus { get; set; }

    public int DurationMs { get; set; }

    /// <summary>入参摘要（截断），让用户看得懂它当时要干什么；不存完整 body</summary>
    public string? ArgumentsPreview { get; set; }

    /// <summary>产物类型：site | entry | store | workspace | image-run | skill；没有产物时为空</summary>
    public string? ArtifactKind { get; set; }

    public string? ArtifactId { get; set; }

    /// <summary>产物的可点击地址（站点 URL、分享链等），没有就为空</summary>
    public string? ArtifactUrl { get; set; }

    public string? ArtifactTitle { get; set; }

    /// <summary>
    /// 是不是「写入类动作」（会在平台里留下东西：建站、写文档、建工作区…）。
    /// 判据取自工具定义的 HTTP 方法（非 GET 即写），落库存一份是为了日额度统计不必回头解析工具表。
    /// </summary>
    public bool IsWrite { get; set; }

    /// <summary>这次请求了几张图（生图工具专用，用于日额度统计）</summary>
    public int ImageCount { get; set; }

    /// <summary>
    /// 这次是幂等命中（同一个 clientRequestId 重试，下游把已存在的东西原样回给它）。
    /// 命中时不算新的副作用：占的配额要退回去，而动作分类（ImageCount / IsWrite）**照实写** —— 这次要干的确实是写入 / 出图，账本本来就不从这两个字段加，抹掉只会让记录说谎，
    /// 否则一次丢响应的重试会被当成两次真实产出扣两回额度。
    /// </summary>
    public bool Deduplicated { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 入队时所在部署的作用域（同 ImageGenRun.DeploymentSlug）。共享 Mongo 下多条分支预览
    /// 共用一个库，记录不带作用域的话，接入台会把别的部署的调用混进来当成自己的。
    /// </summary>
    public string? DeploymentSlug { get; set; }
}
