namespace PrdAgent.Core.Models;

/// <summary>
/// 文件批量转换任务
/// </summary>
public class FileConvertTask
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;

    /// <summary>任务状态：queued / running / done / error</summary>
    public string Status { get; set; } = FileConvertTaskStatus.Queued;

    /// <summary>源文件 URL（已上传到存储）</summary>
    public string SourceFileUrl { get; set; } = string.Empty;

    /// <summary>源文件原始文件名</summary>
    public string SourceFileName { get; set; } = string.Empty;

    /// <summary>模板文件 URL</summary>
    public string TemplateFileUrl { get; set; } = string.Empty;

    /// <summary>模板文件原始文件名</summary>
    public string TemplateFileName { get; set; } = string.Empty;

    /// <summary>字段映射列表</summary>
    public List<FileConvertFieldMapping> FieldMappings { get; set; } = new();

    /// <summary>复用的规则 ID（可选）</summary>
    public string? RuleId { get; set; }

    /// <summary>生成的 ZIP 下载 URL</summary>
    public string? ResultZipUrl { get; set; }

    /// <summary>总行数（不含表头）</summary>
    public int TotalRows { get; set; }

    /// <summary>已处理行数</summary>
    public int ProcessedRows { get; set; }

    /// <summary>错误信息（Status=error 时填充）</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>进度日志（简要文本，SSE 增量推送）</summary>
    public List<string> ProgressLogs { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class FileConvertTaskStatus
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string Done = "done";
    public const string Error = "error";
}

/// <summary>
/// 单个字段映射：源文件的哪一列 → 模板的哪个占位符
/// </summary>
public class FileConvertFieldMapping
{
    /// <summary>源文件列名</summary>
    public string SourceColumn { get; set; } = string.Empty;

    /// <summary>模板占位符名（不含 {{ }}）</summary>
    public string TemplatePlaceholder { get; set; } = string.Empty;
}

/// <summary>
/// 已保存的转换规则（方便下次复用）
/// </summary>
public class FileConvertRule
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;

    /// <summary>规则名称，用户自定义</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>规则备注</summary>
    public string? Description { get; set; }

    /// <summary>字段映射列表（快照，不含文件 URL）</summary>
    public List<FileConvertFieldMapping> FieldMappings { get; set; } = new();

    /// <summary>上次成功使用的源文件名（仅供参考展示）</summary>
    public string? LastSourceFileName { get; set; }

    /// <summary>上次成功使用的模板文件名（仅供参考展示）</summary>
    public string? LastTemplateFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
