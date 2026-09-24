namespace PrdAgent.Core.Models;

/// <summary>
/// 网页生成设置（单例文档：Id 固定为 global）。
/// 默认执行器、自查强度、风格预设与三段可编辑提示词都存在这里，管理员改完下一次运行即生效；
/// 每次运行创建时把当时的取值冻结进 <see cref="DesignArtifactDesignDirection"/>，之后再改设置不影响在途运行。
/// 字段为 null 表示「沿用内置默认」，内置默认值由 API 层的 DesignGenerationDefaults 统一给出。
/// </summary>
[MongoDB.Bson.Serialization.Attributes.BsonIgnoreExtraElements]
public class DesignGenerationSettings
{
    public const string SingletonId = "global";

    public string Id { get; set; } = SingletonId;

    /// <summary>默认执行器（map-gateway / open-design）；null 表示内置默认 open-design。</summary>
    public string? DefaultRuntime { get; set; }

    /// <summary>自查强度（off / light / strict）；null 表示内置默认 light。</summary>
    public string? ReviewMode { get; set; }

    /// <summary>风格预设全集；null 表示内置 8 套。管理员保存过一次后整份落库。</summary>
    public List<DesignStylePreset>? Styles { get; set; }

    /// <summary>创作提示词覆盖；null 表示内置默认。</summary>
    public string? GeneratePrompt { get; set; }

    /// <summary>修改提示词覆盖；null 表示内置默认。</summary>
    public string? EditPrompt { get; set; }

    /// <summary>自查提示词覆盖；null 表示内置默认。</summary>
    public string? ReviewPrompt { get; set; }

    public DateTime? UpdatedAt { get; set; }

    public string? UpdatedByUserId { get; set; }

    public string? UpdatedByName { get; set; }
}

public class DesignStylePreset
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Description { get; set; } = string.Empty;

    /// <summary>OpenDesign 设计系统编号（/app/design-systems/&lt;id&gt;）；直连执行器只把它当风格说明的一部分。</summary>
    public string DesignSystemId { get; set; } = string.Empty;

    /// <summary>
    /// 界面上的三枚色块 [ink, paper, accent]。2026-09-24 起不再可编辑：API 层读取时从 OpenDesign 设计系统快照的
    /// 真实 tokens 派生（--fg / --bg / --accent），保存时不落库；存量文档里的旧值读取时被忽略。
    /// </summary>
    public List<string> Swatches { get; set; } = new();

    public bool Enabled { get; set; } = true;

    public bool IsDefault { get; set; }

    public bool BuiltIn { get; set; }
}

/// <summary>
/// 一次运行创建时冻结下来的设计方向：用了哪套风格、哪版提示词、多强的自查。
/// 缺失仅代表改动之前的旧运行，执行器按内置默认处理，读取时不得回填。
/// </summary>
public sealed class DesignArtifactDesignDirection
{
    public int Version { get; set; } = 1;

    public string StyleId { get; set; } = string.Empty;

    public string StyleName { get; set; } = string.Empty;

    public string DesignSystemId { get; set; } = string.Empty;

    public string StyleDescription { get; set; } = string.Empty;

    public string ReviewMode { get; set; } = DesignReviewModes.Light;

    public string GeneratePrompt { get; set; } = string.Empty;

    public string EditPrompt { get; set; } = string.Empty;

    public string ReviewPrompt { get; set; } = string.Empty;

    /// <summary>风格、自查强度与三段提示词的内容指纹（sha256 前 12 位），用来回答「这次用的是哪一版」。</summary>
    public string PromptFingerprint { get; set; } = string.Empty;
}

/// <summary>直接上传、作为事实来源的文档（附件的已提取正文）。</summary>
public sealed class DesignUploadedSource
{
    public string AttachmentId { get; set; } = string.Empty;

    public string FileName { get; set; } = string.Empty;

    public string MimeType { get; set; } = string.Empty;

    public string Content { get; set; } = string.Empty;

    public string ContentHash { get; set; } = string.Empty;
}

/// <summary>修改时附上的截图，原样放进工作区 reference/ 目录，只作视觉参考、不是事实来源。</summary>
public sealed class DesignReferenceImage
{
    public string AttachmentId { get; set; } = string.Empty;

    public string FileName { get; set; } = string.Empty;

    public string MimeType { get; set; } = string.Empty;

    public long Size { get; set; }

    /// <summary>对象存储 key（只由 MAP 读取，不出现在对外 DTO）。</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string? StorageKey { get; set; }

    [System.Text.Json.Serialization.JsonIgnore]
    public string? Url { get; set; }
}

public static class DesignReviewModes
{
    public const string Off = "off";
    public const string Light = "light";
    public const string Strict = "strict";

    public static bool IsValid(string? value) => value is Off or Light or Strict;
}
