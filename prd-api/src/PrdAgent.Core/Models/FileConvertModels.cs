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

    /// <summary>源文件存储 Key（用于 TryDownloadBytesAsync / DeleteByKeyAsync）</summary>
    public string SourceFileKey { get; set; } = string.Empty;

    /// <summary>源文件原始文件名</summary>
    public string SourceFileName { get; set; } = string.Empty;

    /// <summary>
    /// 输出模式：
    /// - template：基于上传的模板文件生成（Word/Excel）
    /// - expression：无模板，直接用表达式输出文本行
    /// </summary>
    public string OutputMode { get; set; } = FileConvertOutputMode.Template;

    /// <summary>expression 模式下的输出列定义（每列一个表达式，生成 CSV / TXT）</summary>
    public List<FileConvertOutputColumn> OutputColumns { get; set; } = new();

    /// <summary>模板文件存储 Key（template 模式必填）</summary>
    public string? TemplateFileKey { get; set; }

    /// <summary>模板文件原始文件名</summary>
    public string? TemplateFileName { get; set; }

    /// <summary>字段映射列表（template 模式使用）</summary>
    public List<FileConvertFieldMapping> FieldMappings { get; set; } = new();

    /// <summary>复用的规则 ID（可选）</summary>
    public string? RuleId { get; set; }

    /// <summary>生成的 ZIP 存储 Key（用于下载和删除）</summary>
    public string? ResultZipKey { get; set; }

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

public static class FileConvertOutputMode
{
    public const string Template = "template";
    public const string Expression = "expression";
}

/// <summary>expression 模式下的输出列（每列一个标题 + 值表达式）</summary>
public class FileConvertOutputColumn
{
    /// <summary>输出列标题（CSV 表头 / TXT 前缀）</summary>
    public string Header { get; set; } = string.Empty;

    /// <summary>值表达式，同 FieldMapping.ValueExpression 语法</summary>
    public string ValueExpression { get; set; } = string.Empty;
}

public static class FileConvertTaskStatus
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string Done = "done";
    public const string Error = "error";
}

/// <summary>
/// 单个字段映射：模板占位符 → 值表达式
/// </summary>
public class FileConvertFieldMapping
{
    /// <summary>模板占位符名（不含 {{ }}）</summary>
    public string TemplatePlaceholder { get; set; } = string.Empty;

    /// <summary>
    /// 值表达式：用 {列名} 引用源文件列值，支持自由拼接。
    /// 示例: "{姓} {名}" / "北京-{区县}" / "{电话}"
    /// 旧版兼容：若此字段为空且 SourceColumn 有值，则等价于 "{SourceColumn}"
    /// </summary>
    public string ValueExpression { get; set; } = string.Empty;

    /// <summary>旧版直接列映射（已废弃，保留用于向后兼容）</summary>
    public string SourceColumn { get; set; } = string.Empty;
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

    /// <summary>
    /// 保存的模板文件存储 Key（永久存储，前缀 file-convert/rules/）。
    /// null 表示规则不附带模板，用户下次需自行上传。
    /// </summary>
    public string? TemplateFileKey { get; set; }

    /// <summary>保存的模板文件原始文件名（用于展示）</summary>
    public string? TemplateFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
