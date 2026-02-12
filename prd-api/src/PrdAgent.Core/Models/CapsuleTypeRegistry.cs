namespace PrdAgent.Core.Models;

// ─────────────────────────────────────────────────────────────
// 舱类型注册表：定义所有可用的舱类型及其元数据
// ─────────────────────────────────────────────────────────────

/// <summary>
/// 舱分类：触发 → 处理 → 输出
/// </summary>
public static class CapsuleCategory
{
    public const string Trigger = "trigger";
    public const string Processor = "processor";
    public const string Output = "output";
}

/// <summary>
/// 舱配置字段 Schema（用于前端动态渲染配置表单）
/// </summary>
public class CapsuleConfigField
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;

    /// <summary>text | password | number | textarea | cron | select | json | code</summary>
    public string FieldType { get; set; } = "text";

    public string? Placeholder { get; set; }
    public string? HelpTip { get; set; }
    public bool Required { get; set; }
    public string? DefaultValue { get; set; }
    public List<SelectOption>? Options { get; set; }
}

public class SelectOption
{
    public string Value { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
}

/// <summary>
/// 舱类型元数据定义
/// </summary>
public class CapsuleTypeMeta
{
    public string TypeKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Icon { get; set; } = string.Empty;
    public string Category { get; set; } = CapsuleCategory.Processor;
    public int AccentHue { get; set; } = 210;

    /// <summary>该舱类型的配置字段 Schema</summary>
    public List<CapsuleConfigField> ConfigSchema { get; set; } = new();

    /// <summary>默认输入插槽</summary>
    public List<ArtifactSlot> DefaultInputSlots { get; set; } = new();

    /// <summary>默认输出插槽</summary>
    public List<ArtifactSlot> DefaultOutputSlots { get; set; } = new();

    /// <summary>是否支持单独测试运行</summary>
    public bool Testable { get; set; } = true;
}

/// <summary>
/// 舱类型注册表 —— 所有可用舱的元数据定义
/// </summary>
public static class CapsuleTypeRegistry
{
    // ──────────── 触发类 ────────────

    public static readonly CapsuleTypeMeta Timer = new()
    {
        TypeKey = CapsuleTypes.Timer,
        Name = "定时器",
        Description = "按 Cron 表达式定时触发流水线，适合周期性数据采集与报告生成",
        Icon = "timer",
        Category = CapsuleCategory.Trigger,
        AccentHue = 30,
        Testable = false,
        ConfigSchema = new()
        {
            new() { Key = "cronExpression", Label = "Cron 表达式", FieldType = "cron", Required = true, Placeholder = "0 9 1 * *", HelpTip = "标准 5 位 Cron：分 时 日 月 周。例如 '0 9 1 * *' 表示每月 1 号早上 9 点" },
            new() { Key = "timezone", Label = "时区", FieldType = "select", Required = false, DefaultValue = "Asia/Shanghai", Options = new() {
                new() { Value = "Asia/Shanghai", Label = "Asia/Shanghai (UTC+8)" },
                new() { Value = "UTC", Label = "UTC" },
                new() { Value = "Asia/Tokyo", Label = "Asia/Tokyo (UTC+9)" },
            }},
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "trigger-out", Name = "trigger", DataType = "json", Required = true, Description = "触发上下文（包含触发时间、Cron 表达式等）" },
        },
    };

    public static readonly CapsuleTypeMeta WebhookReceiver = new()
    {
        TypeKey = CapsuleTypes.WebhookReceiver,
        Name = "Webhook 接收",
        Description = "生成唯一 URL，外部系统 POST 触发流水线",
        Icon = "webhook",
        Category = CapsuleCategory.Trigger,
        AccentHue = 200,
        Testable = true,
        ConfigSchema = new()
        {
            new() { Key = "secret", Label = "验签密钥", FieldType = "password", Required = false, HelpTip = "可选。设置后外部请求需携带 HMAC-SHA256 签名" },
            new() { Key = "payloadFilter", Label = "Payload 过滤 (JSONPath)", FieldType = "text", Required = false, Placeholder = "$.data", HelpTip = "仅提取 Payload 中的指定部分传给下一舱" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "webhook-out", Name = "payload", DataType = "json", Required = true, Description = "Webhook 请求体 (JSON)" },
        },
    };

    public static readonly CapsuleTypeMeta ManualTrigger = new()
    {
        TypeKey = CapsuleTypes.ManualTrigger,
        Name = "手动触发",
        Description = "点击按钮手动执行，适合调试和一次性任务",
        Icon = "hand",
        Category = CapsuleCategory.Trigger,
        AccentHue = 280,
        Testable = false,
        ConfigSchema = new()
        {
            new() { Key = "inputPrompt", Label = "输入提示", FieldType = "text", Required = false, Placeholder = "请输入参数…", HelpTip = "执行时显示给用户的输入提示文字" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "manual-out", Name = "input", DataType = "json", Required = true, Description = "用户填写的参数" },
        },
    };

    public static readonly CapsuleTypeMeta FileUpload = new()
    {
        TypeKey = CapsuleTypes.FileUpload,
        Name = "文件上传",
        Description = "上传 CSV / JSON / TXT 文件作为流水线的数据源",
        Icon = "upload",
        Category = CapsuleCategory.Trigger,
        AccentHue = 170,
        Testable = true,
        ConfigSchema = new()
        {
            new() { Key = "acceptTypes", Label = "接受的文件类型", FieldType = "text", Required = false, DefaultValue = ".csv,.json,.txt,.xlsx", HelpTip = "逗号分隔，如 .csv,.json,.txt" },
            new() { Key = "maxSizeMB", Label = "最大文件大小 (MB)", FieldType = "number", Required = false, DefaultValue = "10" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "file-out", Name = "fileContent", DataType = "text", Required = true, Description = "文件内容（文本格式）" },
        },
    };

    // ──────────── 处理类 ────────────

    public static readonly CapsuleTypeMeta TapdCollector = new()
    {
        TypeKey = CapsuleTypes.TapdCollector,
        Name = "TAPD 数据采集",
        Description = "通过 TAPD Open API 拉取 Bug、Story 等项目数据",
        Icon = "database",
        Category = CapsuleCategory.Processor,
        AccentHue = 30,
        ConfigSchema = new()
        {
            new() { Key = "workspaceId", Label = "工作空间 ID", FieldType = "text", Required = true, Placeholder = "20000001", HelpTip = "TAPD 项目首页地址栏中的数字 ID" },
            new() { Key = "apiToken", Label = "API 访问凭证", FieldType = "password", Required = true, Placeholder = "dXNlcjpwYXNzd29yZA==", HelpTip = "在 TAPD「公司管理 → API」中创建的 Base64 Token" },
            new() { Key = "dataType", Label = "数据类型", FieldType = "select", Required = true, DefaultValue = "bugs", Options = new() {
                new() { Value = "bugs", Label = "缺陷 (Bugs)" },
                new() { Value = "stories", Label = "需求 (Stories)" },
                new() { Value = "tasks", Label = "任务 (Tasks)" },
                new() { Value = "iterations", Label = "迭代 (Iterations)" },
            }},
            new() { Key = "dateRange", Label = "时间范围", FieldType = "text", Required = false, Placeholder = "2026-01", HelpTip = "留空取全部，填月份(YYYY-MM)按月筛选" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "tapd-in", Name = "trigger", DataType = "json", Required = false, Description = "触发上下文（可选，来自定时器等）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "tapd-out", Name = "data", DataType = "json", Required = true, Description = "TAPD 数据列表 (JSON Array)" },
        },
    };

    public static readonly CapsuleTypeMeta HttpRequest = new()
    {
        TypeKey = CapsuleTypes.HttpRequest,
        Name = "HTTP 请求",
        Description = "发送通用 REST API 请求，获取外部数据",
        Icon = "globe",
        Category = CapsuleCategory.Processor,
        AccentHue = 210,
        ConfigSchema = new()
        {
            new() { Key = "url", Label = "请求 URL", FieldType = "text", Required = true, Placeholder = "https://api.example.com/data" },
            new() { Key = "method", Label = "请求方法", FieldType = "select", Required = true, DefaultValue = "GET", Options = new() {
                new() { Value = "GET", Label = "GET" },
                new() { Value = "POST", Label = "POST" },
                new() { Value = "PUT", Label = "PUT" },
                new() { Value = "DELETE", Label = "DELETE" },
            }},
            new() { Key = "headers", Label = "请求头", FieldType = "json", Required = false, Placeholder = "{\"Authorization\": \"Bearer xxx\"}" },
            new() { Key = "body", Label = "请求体", FieldType = "json", Required = false, HelpTip = "POST/PUT 时的请求体，支持 {{变量}} 模板替换" },
            new() { Key = "responseExtract", Label = "响应提取 (JSONPath)", FieldType = "text", Required = false, Placeholder = "$.data", HelpTip = "从响应 JSON 中提取指定部分" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "http-in", Name = "input", DataType = "json", Required = false, Description = "上游数据（可用于模板替换）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "http-out", Name = "response", DataType = "json", Required = true, Description = "HTTP 响应数据" },
        },
    };

    public static readonly CapsuleTypeMeta LlmAnalyzer = new()
    {
        TypeKey = CapsuleTypes.LlmAnalyzer,
        Name = "LLM 分析",
        Description = "使用大语言模型对输入数据进行智能分析、总结、分类",
        Icon = "brain",
        Category = CapsuleCategory.Processor,
        AccentHue = 270,
        ConfigSchema = new()
        {
            new() { Key = "systemPrompt", Label = "系统提示词", FieldType = "textarea", Required = true, Placeholder = "你是一个数据分析专家…", HelpTip = "定义 AI 的角色和任务" },
            new() { Key = "userPromptTemplate", Label = "用户提示词模板", FieldType = "textarea", Required = true, Placeholder = "请分析以下数据：\n{{input}}", HelpTip = "{{input}} 将被替换为上游输入数据" },
            new() { Key = "outputFormat", Label = "输出格式", FieldType = "select", Required = false, DefaultValue = "json", Options = new() {
                new() { Value = "json", Label = "JSON" },
                new() { Value = "markdown", Label = "Markdown" },
                new() { Value = "text", Label = "纯文本" },
            }},
            new() { Key = "temperature", Label = "Temperature", FieldType = "number", Required = false, DefaultValue = "0.3", HelpTip = "0~1，越低越稳定，越高越有创意" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "llm-in", Name = "input", DataType = "json", Required = true, Description = "待分析的数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "llm-out", Name = "result", DataType = "json", Required = true, Description = "LLM 分析结果" },
        },
    };

    public static readonly CapsuleTypeMeta ScriptExecutor = new()
    {
        TypeKey = CapsuleTypes.ScriptExecutor,
        Name = "代码脚本",
        Description = "运行自定义 JavaScript / Python 脚本处理数据",
        Icon = "code",
        Category = CapsuleCategory.Processor,
        AccentHue = 150,
        ConfigSchema = new()
        {
            new() { Key = "language", Label = "脚本语言", FieldType = "select", Required = true, DefaultValue = "javascript", Options = new() {
                new() { Value = "javascript", Label = "JavaScript (Node.js)" },
                new() { Value = "python", Label = "Python 3" },
            }},
            new() { Key = "code", Label = "脚本代码", FieldType = "code", Required = true, HelpTip = "输入变量 `input` 为上游数据，返回值为输出数据。JS: module.exports = (input) => { ... }; Python: def main(input): ..." },
            new() { Key = "timeoutSeconds", Label = "超时时间(秒)", FieldType = "number", Required = false, DefaultValue = "30" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "script-in", Name = "input", DataType = "json", Required = true, Description = "脚本输入数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "script-out", Name = "output", DataType = "json", Required = true, Description = "脚本返回值" },
        },
    };

    public static readonly CapsuleTypeMeta DataExtractor = new()
    {
        TypeKey = CapsuleTypes.DataExtractor,
        Name = "数据提取",
        Description = "使用 JSONPath 表达式从 JSON 数据中提取子集",
        Icon = "filter",
        Category = CapsuleCategory.Processor,
        AccentHue = 180,
        ConfigSchema = new()
        {
            new() { Key = "expression", Label = "JSONPath 表达式", FieldType = "text", Required = true, Placeholder = "$.data[*].name", HelpTip = "标准 JSONPath 语法，如 $.data[*] 提取所有元素" },
            new() { Key = "flattenArray", Label = "展平数组", FieldType = "select", Required = false, DefaultValue = "false", Options = new() {
                new() { Value = "true", Label = "是" },
                new() { Value = "false", Label = "否" },
            }},
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "extract-in", Name = "input", DataType = "json", Required = true, Description = "待提取的 JSON 数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "extract-out", Name = "extracted", DataType = "json", Required = true, Description = "提取后的数据子集" },
        },
    };

    public static readonly CapsuleTypeMeta DataMerger = new()
    {
        TypeKey = CapsuleTypes.DataMerger,
        Name = "数据合并",
        Description = "合并多个上游舱的输出数据为一个 JSON 对象",
        Icon = "merge",
        Category = CapsuleCategory.Processor,
        AccentHue = 60,
        ConfigSchema = new()
        {
            new() { Key = "mergeStrategy", Label = "合并策略", FieldType = "select", Required = false, DefaultValue = "object", Options = new() {
                new() { Value = "object", Label = "合并为对象 { a: ..., b: ... }" },
                new() { Value = "array", Label = "合并为数组 [ a, b, ... ]" },
                new() { Value = "concat", Label = "拼接数组元素 [ ...a, ...b ]" },
            }},
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "merge-in-1", Name = "input1", DataType = "json", Required = true, Description = "第一个数据源" },
            new() { SlotId = "merge-in-2", Name = "input2", DataType = "json", Required = true, Description = "第二个数据源" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "merge-out", Name = "merged", DataType = "json", Required = true, Description = "合并后的数据" },
        },
    };

    // ──────────── 输出类 ────────────

    public static readonly CapsuleTypeMeta ReportGenerator = new()
    {
        TypeKey = CapsuleTypes.ReportGenerator,
        Name = "报告生成",
        Description = "使用 LLM 将结构化数据渲染为可读的 Markdown 报告",
        Icon = "file-text",
        Category = CapsuleCategory.Output,
        AccentHue = 150,
        ConfigSchema = new()
        {
            new() { Key = "reportTemplate", Label = "报告模板/指令", FieldType = "textarea", Required = true, Placeholder = "将以下统计数据整理为月度质量报告，包含…", HelpTip = "LLM 会基于此指令将输入数据格式化为报告" },
            new() { Key = "format", Label = "输出格式", FieldType = "select", Required = false, DefaultValue = "markdown", Options = new() {
                new() { Value = "markdown", Label = "Markdown" },
                new() { Value = "html", Label = "HTML" },
            }},
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "report-in", Name = "data", DataType = "json", Required = true, Description = "待格式化的结构数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "report-out", Name = "report", DataType = "text", Required = true, Description = "生成的报告内容" },
        },
    };

    public static readonly CapsuleTypeMeta FileExporter = new()
    {
        TypeKey = CapsuleTypes.FileExporter,
        Name = "文件导出",
        Description = "将数据打包为可下载文件（JSON / CSV / Markdown）",
        Icon = "download",
        Category = CapsuleCategory.Output,
        AccentHue = 100,
        ConfigSchema = new()
        {
            new() { Key = "fileFormat", Label = "导出格式", FieldType = "select", Required = true, DefaultValue = "json", Options = new() {
                new() { Value = "json", Label = "JSON" },
                new() { Value = "csv", Label = "CSV" },
                new() { Value = "markdown", Label = "Markdown (.md)" },
                new() { Value = "txt", Label = "纯文本 (.txt)" },
            }},
            new() { Key = "fileName", Label = "文件名", FieldType = "text", Required = false, Placeholder = "report-{{date}}", HelpTip = "支持 {{date}} 等变量替换" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "export-in", Name = "data", DataType = "json", Required = true, Description = "待导出的数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "export-out", Name = "file", DataType = "binary", Required = true, Description = "生成的可下载文件" },
        },
    };

    public static readonly CapsuleTypeMeta WebhookSender = new()
    {
        TypeKey = CapsuleTypes.WebhookSender,
        Name = "Webhook 发送",
        Description = "将数据通过 HTTP POST 推送到外部系统",
        Icon = "send",
        Category = CapsuleCategory.Output,
        AccentHue = 200,
        ConfigSchema = new()
        {
            new() { Key = "targetUrl", Label = "目标 URL", FieldType = "text", Required = true, Placeholder = "https://hooks.example.com/callback" },
            new() { Key = "headers", Label = "自定义请求头", FieldType = "json", Required = false, Placeholder = "{\"X-Token\": \"abc\"}" },
            new() { Key = "payloadTemplate", Label = "Payload 模板", FieldType = "json", Required = false, HelpTip = "留空则直接转发上游数据；填写则使用模板，{{data}} 代表上游数据" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "wh-send-in", Name = "data", DataType = "json", Required = true, Description = "要推送的数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "wh-send-out", Name = "response", DataType = "json", Required = true, Description = "目标系统的响应" },
        },
    };

    public static readonly CapsuleTypeMeta NotificationSender = new()
    {
        TypeKey = CapsuleTypes.NotificationSender,
        Name = "站内通知",
        Description = "发送管理后台通知，提醒相关人员查看结果",
        Icon = "bell",
        Category = CapsuleCategory.Output,
        AccentHue = 340,
        ConfigSchema = new()
        {
            new() { Key = "title", Label = "通知标题", FieldType = "text", Required = true, Placeholder = "月度质量报告已生成", HelpTip = "支持 {{变量}} 替换" },
            new() { Key = "content", Label = "通知内容", FieldType = "textarea", Required = false, Placeholder = "请查看最新的质量分析报告…" },
            new() { Key = "level", Label = "通知级别", FieldType = "select", Required = false, DefaultValue = "info", Options = new() {
                new() { Value = "info", Label = "普通" },
                new() { Value = "success", Label = "成功" },
                new() { Value = "warning", Label = "警告" },
                new() { Value = "error", Label = "错误" },
            }},
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "notify-in", Name = "data", DataType = "json", Required = false, Description = "上游数据（可用于模板替换）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "notify-out", Name = "result", DataType = "json", Required = true, Description = "通知发送结果" },
        },
    };

    /// <summary>
    /// 按分类排序的全部舱类型
    /// </summary>
    public static readonly IReadOnlyList<CapsuleTypeMeta> All = new List<CapsuleTypeMeta>
    {
        // 触发类
        Timer, WebhookReceiver, ManualTrigger, FileUpload,
        // 处理类
        TapdCollector, HttpRequest, LlmAnalyzer, ScriptExecutor, DataExtractor, DataMerger,
        // 输出类
        ReportGenerator, FileExporter, WebhookSender, NotificationSender,
    };

    /// <summary>按 TypeKey 查找</summary>
    public static CapsuleTypeMeta? Get(string typeKey) => All.FirstOrDefault(t => t.TypeKey == typeKey);
}
