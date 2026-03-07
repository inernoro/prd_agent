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
    public const string Control = "control";
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

    /// <summary>非空时表示该舱不可用，内容为不可用原因（前端灰显 + tooltip）</summary>
    public string? DisabledReason { get; set; }
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
        DisabledReason = "🚧 需要后端 Cron 调度器支持，开发中",
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
        DisabledReason = "🚧 需要后端 Webhook 接收入口，开发中",
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
        DisabledReason = "🚧 需要执行时文件选择器支持，开发中",
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
        Description = "通过 Cookie 或 Open API 拉取 Bug、Story 等项目数据",
        Icon = "database",
        Category = CapsuleCategory.Processor,
        AccentHue = 30,
        ConfigSchema = new()
        {
            new() { Key = "authMode", Label = "认证方式", FieldType = "select", Required = true, DefaultValue = "cookie", Options = new() {
                new() { Value = "cookie", Label = "Cookie (浏览器登录)" },
                new() { Value = "basic", Label = "Open API (Basic Auth)" },
            }, HelpTip = "Cookie 方式：从浏览器复制 Cookie，数据更全。Open API：需在公司管理中申请 API 账号" },
            new() { Key = "workspaceId", Label = "工作空间 ID", FieldType = "text", Required = true, Placeholder = "50116108", HelpTip = "TAPD 项目 URL 中的数字 ID，如 tapd.cn/50116108" },
            new() { Key = "cookie", Label = "Cookie 字符串", FieldType = "textarea", Required = false, Placeholder = "tapdsession=xxx; t_u=xxx; ...", HelpTip = "浏览器登录 TAPD → F12 → Network → 任意请求 → Headers → Cookie，复制整段粘贴。认证方式选 Cookie 时必填" },
            new() { Key = "dscToken", Label = "dsc-token", FieldType = "text", Required = false, Placeholder = "xgoJSmV1VxqW6fLm", HelpTip = "从 Cookie 中的 dsc-token 值，或从请求中获取。Cookie 模式必填" },
            new() { Key = "authToken", Label = "API 访问凭证", FieldType = "password", Required = false, Placeholder = "dXNlcjpwYXNzd29yZA==", HelpTip = "Open API 模式使用。Base64(api_user:api_password)" },
            new() { Key = "dataType", Label = "数据类型", FieldType = "select", Required = true, DefaultValue = "bugs", Options = new() {
                new() { Value = "bugs", Label = "缺陷 (Bugs)" },
                new() { Value = "stories", Label = "需求 (Stories)" },
                new() { Value = "tasks", Label = "任务 (Tasks)" },
                new() { Value = "iterations", Label = "迭代 (Iterations)" },
            }},
            new() { Key = "dateRange", Label = "时间范围", FieldType = "text", Required = false, Placeholder = "2026-01", HelpTip = "留空取全部，填月份 (YYYY-MM) 按月筛选" },
            new() { Key = "maxPages", Label = "最大页数", FieldType = "number", Required = false, DefaultValue = "50", HelpTip = "防止无限翻页，每页 20 条" },
            new() { Key = "fetchDetail", Label = "获取缺陷详情", FieldType = "select", Required = false, DefaultValue = "true", Options = new() {
                new() { Value = "true", Label = "是 (调用 common_get_info 获取完整字段)" },
                new() { Value = "false", Label = "否 (仅使用搜索列表数据)" },
            }, HelpTip = "开启后会逐条调用详情接口获取全部自定义字段（缺陷等级、缺陷划分、有效报告等），用于统计分析" },
            new() { Key = "customCurl", Label = "自定义 cURL（兜底）", FieldType = "textarea", Required = false,
                Placeholder = "curl 'https://www.tapd.cn/api/...' -H 'Cookie: ...' --data-raw '{...}'",
                HelpTip = "从浏览器 / Postman 复制可用的 cURL 命令粘贴到这里。填写后将直接执行此请求，不再自动构造请求。支持自动分页" },
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

    public static readonly CapsuleTypeMeta SmartHttp = new()
    {
        TypeKey = CapsuleTypes.SmartHttp,
        Name = "智能 HTTP",
        Description = "粘贴 cURL 命令，AI 自动识别分页参数并拉取全量数据",
        Icon = "globe",
        Category = CapsuleCategory.Processor,
        AccentHue = 250,
        ConfigSchema = new()
        {
            new() { Key = "curlCommand", Label = "cURL 命令", FieldType = "textarea", Required = true,
                Placeholder = "curl 'https://api.tapd.cn/bugs?workspace_id=123&page=1&limit=200' -H 'Authorization: Basic dXNlcjpwYXNz'",
                HelpTip = "从浏览器 DevTools → Network → 右键请求 → Copy as cURL，也可点击上方「从浏览器粘贴 cURL」按钮自动填入" },
            new() { Key = "url", Label = "请求 URL", FieldType = "text", Required = false, HelpTip = "从 cURL 自动解析，也可手动修改" },
            new() { Key = "method", Label = "请求方法", FieldType = "select", Required = false, DefaultValue = "GET", Options = new() {
                new() { Value = "GET", Label = "GET" },
                new() { Value = "POST", Label = "POST" },
            }},
            new() { Key = "headers", Label = "请求头", FieldType = "json", Required = false },
            new() { Key = "body", Label = "请求体", FieldType = "json", Required = false },
            new() { Key = "paginationType", Label = "分页策略", FieldType = "select", Required = false, DefaultValue = "auto",
                HelpTip = "auto = AI 自动检测分页参数；也可手动指定",
                Options = new() {
                    new() { Value = "auto", Label = "AI 自动检测" },
                    new() { Value = "offset", Label = "offset/limit 偏移分页" },
                    new() { Value = "page", Label = "page/pageSize 页码分页" },
                    new() { Value = "cursor", Label = "cursor 游标分页" },
                    new() { Value = "none", Label = "不分页（单次请求）" },
                }},
            new() { Key = "maxPages", Label = "最大页数", FieldType = "number", Required = false, DefaultValue = "10", HelpTip = "防止无限请求，最大抓取页数上限" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "smart-in", Name = "context", DataType = "json", Required = false, Description = "上游上下文（可选，用于变量替换）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "smart-out", Name = "data", DataType = "json", Required = true, Description = "合并后的全量 API 数据 (JSON Array)" },
            new() { SlotId = "smart-meta", Name = "meta", DataType = "json", Required = false, Description = "分页元信息（总页数、总条数、分页策略）" },
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
        Description = "运行 JavaScript 脚本处理数据（Jint 沙箱引擎，支持 ES6+语法）",
        Icon = "code",
        Category = CapsuleCategory.Processor,
        AccentHue = 150,
        ConfigSchema = new()
        {
            new() { Key = "language", Label = "脚本语言", FieldType = "select", Required = true, DefaultValue = "javascript", Options = new() {
                new() { Value = "javascript", Label = "JavaScript (Jint 引擎)" },
            }},
            new() { Key = "code", Label = "脚本代码", FieldType = "code", Required = true, HelpTip = "上游数据注入为全局变量 `data`（JSON 数组或对象）。将处理结果赋值给 `result` 变量。\n\n示例：\nconst bugs = data.filter(i => i.status === '新建');\nresult = { total: data.length, newBugs: bugs.length, rate: (bugs.length / data.length * 100).toFixed(1) + '%' };" },
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

    public static readonly CapsuleTypeMeta FormatConverter = new()
    {
        TypeKey = CapsuleTypes.FormatConverter,
        Name = "格式转换",
        Description = "在 JSON / XML / CSV / YAML 等格式之间相互转换",
        Icon = "repeat",
        Category = CapsuleCategory.Processor,
        AccentHue = 45,
        Testable = true,
        ConfigSchema = new()
        {
            new() { Key = "sourceFormat", Label = "源格式", FieldType = "select", Required = true, DefaultValue = "json", Options = new() {
                new() { Value = "json", Label = "JSON" },
                new() { Value = "csv", Label = "CSV" },
                new() { Value = "xml", Label = "XML" },
                new() { Value = "yaml", Label = "YAML" },
                new() { Value = "tsv", Label = "TSV (Tab 分隔)" },
                new() { Value = "text", Label = "纯文本" },
            }},
            new() { Key = "targetFormat", Label = "目标格式", FieldType = "select", Required = true, DefaultValue = "csv", Options = new() {
                new() { Value = "json", Label = "JSON" },
                new() { Value = "csv", Label = "CSV" },
                new() { Value = "xml", Label = "XML" },
                new() { Value = "yaml", Label = "YAML" },
                new() { Value = "tsv", Label = "TSV (Tab 分隔)" },
                new() { Value = "markdown-table", Label = "Markdown 表格" },
                new() { Value = "text", Label = "纯文本" },
            }},
            new() { Key = "csvDelimiter", Label = "CSV 分隔符", FieldType = "text", Required = false, DefaultValue = ",",
                HelpTip = "仅在源/目标格式为 CSV 时生效" },
            new() { Key = "xmlRootTag", Label = "XML 根标签", FieldType = "text", Required = false, DefaultValue = "root",
                HelpTip = "仅在目标格式为 XML 时生效" },
            new() { Key = "prettyPrint", Label = "美化输出", FieldType = "select", Required = false, DefaultValue = "true", Options = new() {
                new() { Value = "true", Label = "是" },
                new() { Value = "false", Label = "否" },
            }},
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "convert-in", Name = "input", DataType = "text", Required = true, Description = "待转换的源数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "convert-out", Name = "converted", DataType = "text", Required = true, Description = "转换后的数据" },
        },
    };

    public static readonly CapsuleTypeMeta DataAggregator = new()
    {
        TypeKey = CapsuleTypes.DataAggregator,
        Name = "数据统计",
        Description = "对 JSON 数组数据进行分组统计（计数、分布、占比），输出结构化摘要供 LLM 分析趋势",
        Icon = "bar-chart",
        Category = CapsuleCategory.Processor,
        AccentHue = 120,
        ConfigSchema = new()
        {
            new() { Key = "aggregationType", Label = "统计模式", FieldType = "select", Required = false, DefaultValue = "generic", HelpTip = "选择专用统计模式可获得精确的领域指标计算", Options = new() {
                new() { Value = "generic", Label = "通用分组统计" },
                new() { Value = "tapd-bug-28d", Label = "TAPD 缺陷 28 维度" },
            }},
            new() { Key = "groupByFields", Label = "分组统计字段", FieldType = "text", Required = false, DefaultValue = "status,severity,priority,reporter", HelpTip = "通用模式下使用。逗号分隔的字段名，将按每个字段进行分组计数。支持嵌套路径如 Bug.status" },
            new() { Key = "dateField", Label = "日期字段", FieldType = "text", Required = false, DefaultValue = "created", HelpTip = "通用模式下使用。用于时间趋势统计的日期字段名" },
            new() { Key = "dateGroupBy", Label = "时间粒度", FieldType = "select", Required = false, DefaultValue = "week", Options = new() {
                new() { Value = "day", Label = "按天" },
                new() { Value = "week", Label = "按周" },
                new() { Value = "month", Label = "按月" },
            }},
            new() { Key = "topN", Label = "Top N", FieldType = "number", Required = false, DefaultValue = "10", HelpTip = "通用模式下使用。每个维度保留前 N 个分组（其余归入「其他」）" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "agg-in", Name = "data", DataType = "json", Required = true, Description = "待统计的 JSON 数组数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "agg-out", Name = "statistics", DataType = "json", Required = true, Description = "统计摘要（分组计数、分布、趋势）" },
        },
    };

    // ──────────── 流程控制类 ────────────

    public static readonly CapsuleTypeMeta Delay = new()
    {
        TypeKey = CapsuleTypes.Delay,
        Name = "延时",
        Description = "等待指定秒数后继续，用于控制节奏或等待外部系统就绪",
        Icon = "clock",
        Category = CapsuleCategory.Control,
        AccentHue = 200,
        ConfigSchema = new()
        {
            new() { Key = "seconds", Label = "等待秒数", FieldType = "number", Required = true, DefaultValue = "3", Placeholder = "3", HelpTip = "流水线将暂停执行指定的秒数（1~300）" },
            new() { Key = "message", Label = "等待消息", FieldType = "text", Required = false, Placeholder = "等待数据同步完成…", HelpTip = "等待时显示的提示信息" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "delay-in", Name = "input", DataType = "json", Required = false, Description = "透传数据（不做修改）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "delay-out", Name = "output", DataType = "json", Required = true, Description = "透传上游数据 + 等待信息" },
        },
    };

    public static readonly CapsuleTypeMeta Condition = new()
    {
        TypeKey = CapsuleTypes.Condition,
        Name = "条件判断",
        Description = "根据条件表达式选择执行分支（if / else）",
        Icon = "git-branch",
        Category = CapsuleCategory.Control,
        AccentHue = 45,
        ConfigSchema = new()
        {
            new() { Key = "field", Label = "判断字段", FieldType = "text", Required = true, Placeholder = "status", HelpTip = "从输入数据中提取的字段名。支持嵌套路径如 data.count" },
            new() { Key = "operator", Label = "运算符", FieldType = "select", Required = true, DefaultValue = "==", Options = new() {
                new() { Value = "==", Label = "等于 (==)" },
                new() { Value = "!=", Label = "不等于 (!=)" },
                new() { Value = ">", Label = "大于 (>)" },
                new() { Value = ">=", Label = "大于等于 (>=)" },
                new() { Value = "<", Label = "小于 (<)" },
                new() { Value = "<=", Label = "小于等于 (<=)" },
                new() { Value = "contains", Label = "包含 (contains)" },
                new() { Value = "not-empty", Label = "非空 (not-empty)" },
                new() { Value = "empty", Label = "为空 (empty)" },
            }},
            new() { Key = "value", Label = "比较值", FieldType = "text", Required = false, Placeholder = "success", HelpTip = "与字段值比较的目标值。运算符为 empty / not-empty 时可留空" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "cond-in", Name = "input", DataType = "json", Required = true, Description = "待判断的数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "cond-true", Name = "true", DataType = "json", Required = true, Description = "条件成立时输出" },
            new() { SlotId = "cond-false", Name = "false", DataType = "json", Required = true, Description = "条件不成立时输出" },
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

    public static readonly CapsuleTypeMeta WebpageGenerator = new()
    {
        TypeKey = CapsuleTypes.WebpageGenerator,
        Name = "网页报告",
        Description = "使用 LLM 将数据渲染为精美可下载的单页 HTML 网页（含内嵌样式与图表）",
        Icon = "globe",
        Category = CapsuleCategory.Output,
        AccentHue = 220,
        ConfigSchema = new()
        {
            new() { Key = "reportTemplate", Label = "报告模板/指令", FieldType = "textarea", Required = true,
                Placeholder = "请将以下数据生成为一份精美的单页 HTML 网页报告，使用现代化的 UI 设计...",
                HelpTip = "LLM 会基于此指令将输入数据渲染为完整的 HTML 网页。建议描述期望的视觉风格、配色方案、图表类型等" },
            new() { Key = "style", Label = "视觉风格", FieldType = "select", Required = false, DefaultValue = "modern-dark",
                Options = new()
                {
                    new() { Value = "modern-dark", Label = "现代深色 (Dark Glassmorphism)" },
                    new() { Value = "modern-light", Label = "现代浅色 (Clean Light)" },
                    new() { Value = "dashboard", Label = "数据看板 (Dashboard)" },
                    new() { Value = "report", Label = "正式报告 (Professional)" },
                    new() { Value = "custom", Label = "自定义 (仅使用模板指令)" },
                }},
            new() { Key = "title", Label = "网页标题", FieldType = "text", Required = false, Placeholder = "月度质量分析报告",
                HelpTip = "HTML <title> 标题，留空则由 LLM 自动生成" },
            new() { Key = "includeCharts", Label = "内嵌图表", FieldType = "select", Required = false, DefaultValue = "true",
                Options = new()
                {
                    new() { Value = "true", Label = "是 (使用 Chart.js CDN)" },
                    new() { Value = "false", Label = "否 (纯文本 + 表格)" },
                },
                HelpTip = "启用后 LLM 会在网页中内嵌 Chart.js 图表可视化数据" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "webpage-in", Name = "data", DataType = "json", Required = true, Description = "待渲染的结构化数据" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "webpage-out", Name = "webpage", DataType = "text", Required = true, Description = "生成的完整 HTML 网页" },
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
            new() { Key = "attachFromInput", Label = "附件来源", FieldType = "select", Required = false, DefaultValue = "none", HelpTip = "从上游产物中提取附件链接", Options = new() {
                new() { Value = "none", Label = "无附件" },
                new() { Value = "cos", Label = "上游产物 COS 链接" },
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
        TapdCollector, HttpRequest, SmartHttp, LlmAnalyzer, ScriptExecutor, DataExtractor, DataMerger, FormatConverter, DataAggregator,
        // 流程控制类
        Delay, Condition,
        // 输出类
        ReportGenerator, WebpageGenerator, FileExporter, WebhookSender, NotificationSender,
    };

    /// <summary>按 TypeKey 查找</summary>
    public static CapsuleTypeMeta? Get(string typeKey) => All.FirstOrDefault(t => t.TypeKey == typeKey);
}
