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

    public static readonly CapsuleTypeMeta EventTrigger = new()
    {
        TypeKey = CapsuleTypes.EventTrigger,
        Name = "事件触发",
        Description = "监听系统事件（如生图完成、缺陷创建等），事件发生时自动触发流水线",
        Icon = "zap",
        Category = CapsuleCategory.Trigger,
        AccentHue = 45,
        Testable = true,
        ConfigSchema = new()
        {
            new() { Key = "eventType", Label = "事件类型", FieldType = "select", Required = true, HelpTip = "选择要监听的系统事件，支持通配符（如 visual-agent.*）", Options = new()
            {
                new() { Value = "open-platform.quota.warning", Label = "开放平台 - 额度预警" },
                new() { Value = "visual-agent.image-gen.completed", Label = "视觉创作 - 生图完成" },
                new() { Value = "visual-agent.image-gen.failed", Label = "视觉创作 - 生图失败" },
                new() { Value = "visual-agent.image-gen.*", Label = "视觉创作 - 所有生图事件" },
                new() { Value = "defect-agent.report.created", Label = "缺陷管理 - 缺陷报告创建" },
                new() { Value = "literary-agent.illustration.completed", Label = "文学创作 - 配图生成完成" },
            }},
            new() { Key = "customEventType", Label = "自定义事件类型", FieldType = "text", Required = false, Placeholder = "my-app.custom-event", HelpTip = "如果下拉列表中没有需要的事件，可以在此输入自定义事件类型" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "event-out", Name = "eventPayload", DataType = "json", Required = true, Description = "事件载荷（包含 eventType、title、content、variables 等）" },
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
            new() { Key = "trendMode", Label = "趋势模式", FieldType = "select", Required = false, DefaultValue = "false", Options = new() {
                new() { Value = "false", Label = "否（单月采集）" },
                new() { Value = "true", Label = "是（多月趋势，仅采集每月总数）" },
            }, HelpTip = "开启后按月循环采集 total_count，输出趋势数组，适合画折线图" },
            new() { Key = "trendMonths", Label = "趋势月数", FieldType = "number", Required = false, DefaultValue = "6", HelpTip = "从当前月往回追溯几个月（含当前月），默认 6" },
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
            new() { Key = "dataPath", Label = "数据路径", FieldType = "text", Required = false, Placeholder = "result.list", HelpTip = "响应 JSON 中数据数组的路径（点号分隔），如 result.list、data.records。留空则自动检测 data/items/results" },
            new() { Key = "cursorField", Label = "游标字段", FieldType = "text", Required = false, Placeholder = "next_cursor", HelpTip = "cursor 分页时，从响应 JSON 中提取下一页游标的字段路径，如 paging.next_cursor" },
            new() { Key = "cursorParam", Label = "游标参数名", FieldType = "text", Required = false, DefaultValue = "cursor", HelpTip = "cursor 分页时，将游标值放入 URL 的哪个 query 参数中（默认 cursor）" },
            new() { Key = "requestDelayMs", Label = "请求间隔 (ms)", FieldType = "number", Required = false, DefaultValue = "0", HelpTip = "每次翻页请求之间的延迟毫秒数，防止触发外部 API 限流（0 表示不延迟）" },
            new() { Key = "retryCount", Label = "失败重试次数", FieldType = "number", Required = false, DefaultValue = "0", HelpTip = "单次请求失败后的重试次数（0 表示不重试，最大 3）" },
            new() { Key = "bodyPageField", Label = "Body 分页字段", FieldType = "text", Required = false, Placeholder = "pageIndex", HelpTip = "POST 分页时，请求体 JSON 中的页码字段路径。留空则仅在 URL query 中翻页" },
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

    public static readonly CapsuleTypeMeta VideoGeneration = new()
    {
        TypeKey = CapsuleTypes.VideoGeneration,
        Name = "视频生成",
        Description = "将文章/Markdown 内容转化为教程视频，自动生成分镜脚本并渲染为 MP4 或 HTML",
        Icon = "video",
        Category = CapsuleCategory.Output,
        AccentHue = 270,
        ConfigSchema = new()
        {
            new() { Key = "articleMarkdown", Label = "文章内容", FieldType = "textarea", Required = true, Placeholder = "输入 Markdown 格式的文章内容…", HelpTip = "支持标准 Markdown，将自动拆分为分镜脚本" },
            new() { Key = "articleTitle", Label = "文章标题", FieldType = "text", Required = false, Placeholder = "视频标题（可选）" },
            new() { Key = "systemPrompt", Label = "系统提示词", FieldType = "textarea", Required = false, Placeholder = "自定义分镜生成的系统提示词（可选）" },
            new() { Key = "styleDescription", Label = "风格描述", FieldType = "textarea", Required = false, Placeholder = "视频视觉风格描述（可选）" },
            new() { Key = "outputFormat", Label = "输出格式", FieldType = "select", Required = false, DefaultValue = "mp4", HelpTip = "mp4: Remotion 渲染视频；html: 自包含 HTML 交互页面", Placeholder = "mp4|html" },
            new() { Key = "timeoutMinutes", Label = "超时时间（分钟）", FieldType = "number", Required = false, DefaultValue = "30", HelpTip = "等待视频渲染完成的最大时间，默认 30 分钟" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "vg-in", Name = "article", DataType = "text", Required = false, Description = "上游文章内容（可覆盖配置中的 articleMarkdown）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "vg-out", Name = "result", DataType = "json", Required = true, Description = "视频生成结果（含 videoUrl、srtContent、状态等）" },
        },
    };

    public static readonly CapsuleTypeMeta SitePublisher = new()
    {
        TypeKey = CapsuleTypes.SitePublisher,
        Name = "站点发布",
        Description = "将上游 HTML 内容发布到网页托管，生成可公开访问的网页链接",
        Icon = "globe-lock",
        Category = CapsuleCategory.Output,
        AccentHue = 160,
        ConfigSchema = new()
        {
            new() { Key = "title", Label = "站点标题", FieldType = "text", Required = false, Placeholder = "月度质量报告", HelpTip = "留空则从上游产物名称自动生成。支持 {{变量}} 替换" },
            new() { Key = "description", Label = "站点描述", FieldType = "textarea", Required = false, Placeholder = "自动生成的报告网页", HelpTip = "留空则自动填充。支持 {{变量}} 替换" },
            new() { Key = "folder", Label = "存储文件夹", FieldType = "text", Required = false, Placeholder = "reports", HelpTip = "可选。将站点归类到指定文件夹，便于管理" },
            new() { Key = "tags", Label = "标签", FieldType = "text", Required = false, Placeholder = "report,auto-gen,2026", HelpTip = "逗号分隔的标签列表，便于搜索和过滤" },
            new() { Key = "autoShare", Label = "自动创建分享链接", FieldType = "select", Required = false, DefaultValue = "false", Options = new()
            {
                new() { Value = "false", Label = "不创建" },
                new() { Value = "public", Label = "公开链接（无需密码）" },
                new() { Value = "password", Label = "加密链接（自动生成密码）" },
            }, HelpTip = "发布后自动创建分享链接，适合自动化通知场景" },
            new() { Key = "shareExpiryDays", Label = "分享链接有效天数", FieldType = "number", Required = false, DefaultValue = "30", HelpTip = "自动创建分享链接时的有效期（天），默认 30 天" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "site-in", Name = "html", DataType = "text", Required = true, Description = "待发布的 HTML 内容（来自网页报告或其他生成器）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "site-out", Name = "result", DataType = "json", Required = true, Description = "发布结果（含 siteUrl、siteId、shareUrl 等）" },
        },
    };

    public static readonly CapsuleTypeMeta EmailSender = new()
    {
        TypeKey = CapsuleTypes.EmailSender,
        Name = "邮件发送",
        Description = "使用系统 SMTP 配置发送邮件，无需手动配置邮箱参数",
        Icon = "mail",
        Category = CapsuleCategory.Output,
        AccentHue = 210,
        ConfigSchema = new()
        {
            new() { Key = "toEmail", Label = "收件人邮箱", FieldType = "text", Required = true, Placeholder = "user@example.com", HelpTip = "收件人邮箱地址，支持 {{变量}} 替换" },
            new() { Key = "toName", Label = "收件人姓名", FieldType = "text", Required = false, Placeholder = "张三", HelpTip = "可选，留空则使用邮箱地址。支持 {{变量}} 替换" },
            new() { Key = "subject", Label = "邮件主题", FieldType = "text", Required = true, Placeholder = "月度质量报告", HelpTip = "邮件标题，支持 {{变量}} 替换" },
            new() { Key = "bodyTemplate", Label = "邮件正文", FieldType = "textarea", Required = false, Placeholder = "请查看附件中的报告内容…", HelpTip = "留空则自动使用上游产物内容作为邮件正文。支持 HTML 和 {{变量}} 替换" },
            new() { Key = "useHtml", Label = "HTML 格式", FieldType = "select", Required = false, DefaultValue = "true", Options = new()
            {
                new() { Value = "true", Label = "是（支持富文本格式）" },
                new() { Value = "false", Label = "否（纯文本）" },
            }, HelpTip = "是否以 HTML 格式发送邮件正文" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "email-in", Name = "content", DataType = "text", Required = false, Description = "上游内容（作为邮件正文或附加内容）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "email-out", Name = "result", DataType = "json", Required = true, Description = "发送结果（含 success、toEmail 等）" },
        },
    };

    // ──────────── 短视频工作流类 ────────────

    public static readonly CapsuleTypeMeta TiktokCreatorFetch = new()
    {
        TypeKey = CapsuleTypes.TiktokCreatorFetch,
        Name = "博主作品订阅 (TikHub)",
        Description = "通过 TikHub 一站式拉取多平台博主最新作品：TikTok / 抖音 / B 站 / 小红书 / YouTube。输出标准化条目数组（awemeId / title / videoUrl / coverUrl / author / shareUrl），可作为海报订阅工作流的源头。注：B 站和 YouTube 不给 mp4 直链，海报会展示封面 + 跳转链接",
        Icon = "video",
        Category = CapsuleCategory.Processor,
        AccentHue = 340,
        ConfigSchema = new()
        {
            new() { Key = "platform", Label = "平台", FieldType = "select", Required = true, DefaultValue = "tiktok", Options = new()
            {
                new() { Value = "tiktok", Label = "TikTok（海外短视频，secUid）" },
                new() { Value = "douyin", Label = "抖音（国内短视频，sec_user_id）" },
                new() { Value = "bilibili", Label = "B 站（UP 主投稿，mid 数字）" },
                new() { Value = "xiaohongshu", Label = "小红书（图文/视频笔记，user_id）" },
                new() { Value = "youtube", Label = "YouTube（频道视频，channelId）" },
            }, HelpTip = "选择目标平台，下方「博主 ID」字段会按所选平台读取对应 ID 类型" },
            new() { Key = "apiBaseUrl", Label = "TikHub API 地址", FieldType = "text", Required = false, DefaultValue = "https://api.tikhub.io", HelpTip = "TikHub API 基础地址，留空走默认 https://api.tikhub.io" },
            new() { Key = "apiKey", Label = "API 密钥", FieldType = "password", Required = true, Placeholder = "Bearer xxx", HelpTip = "TikHub API 认证密钥，可使用 {{secrets.TIKHUB_API_KEY}} 引用工作流密钥" },
            new() { Key = "secUid", Label = "博主 ID", FieldType = "text", Required = true, Placeholder = "按平台填写：TikTok=secUid / 抖音=sec_user_id / B站=mid / 小红书=user_id / YouTube=channelId", HelpTip = "TikTok / 抖音填 secUid 或 sec_user_id（MS4wLjAB... 格式）；B 站填 UP 主 mid（数字，如 12345678）；小红书填 user_id（从博主主页 URL 末段取）；YouTube 填 channelId（UCxxxxx...）" },
            new() { Key = "count", Label = "拉取数量", FieldType = "number", Required = false, DefaultValue = "10", HelpTip = "本次最多拉取多少条作品，建议 1-30。首次测试可设为 1" },
            new() { Key = "cursor", Label = "起始游标", FieldType = "text", Required = false, DefaultValue = "0", HelpTip = "翻页游标（仅对支持游标的平台生效：TikTok / 抖音 / 小红书）。B 站和 YouTube 走页码不用此字段" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "tcf-in", Name = "trigger", DataType = "json", Required = false, Description = "上游触发上下文（可选，可覆盖 secUid）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "tcf-out", Name = "videos", DataType = "json", Required = true, Description = "标准化视频列表（items 数组 + firstItem 快捷字段，每项含 videoUrl / coverUrl / title / awemeId）" },
        },
    };

    public static readonly CapsuleTypeMeta WeeklyPosterPublisher = new()
    {
        TypeKey = CapsuleTypes.WeeklyPosterPublisher,
        Name = "发布到首页弹窗海报",
        Description = "把上游内容（含图片/视频 URL + 文案）作为「周报小报」发布——登录后首页的轮播弹窗会立刻显示。每条上游 item 对应海报的一页（title/body/imageUrl），imageUrl 前端自动识别视频还是图片",
        Icon = "image",
        Category = CapsuleCategory.Output,
        AccentHue = 320,
        ConfigSchema = new()
        {
            new() { Key = "weekKey", Label = "周标识", FieldType = "text", Required = false, Placeholder = "2026-W18", HelpTip = "ISO 周标识，留空自动取当前周。同一 weekKey 多次发布旧版本自动归档" },
            new() { Key = "title", Label = "海报主标题", FieldType = "text", Required = false, Placeholder = "TikTok @author 最新作品", HelpTip = "海报顶部主标题。留空时自动用「TikTok @{firstItem.author} 最新作品」" },
            new() { Key = "subtitle", Label = "副标题", FieldType = "text", Required = false, Placeholder = "本周精选" },
            new() { Key = "templateKey", Label = "模板", FieldType = "select", Required = false, DefaultValue = "promo", Options = new()
            {
                new() { Value = "release", Label = "release（更新公告）" },
                new() { Value = "hotfix", Label = "hotfix（紧急修复）" },
                new() { Value = "promo", Label = "promo（推广，TikTok 推荐用）" },
                new() { Value = "sale", Label = "sale（活动）" },
            } },
            new() { Key = "presentationMode", Label = "展示样式", FieldType = "select", Required = false, DefaultValue = "ad-4-3", Options = new()
            {
                new() { Value = "ad-4-3", Label = "ad-4-3（4:3 视频广告样式，中央 Play 按钮，推荐）" },
                new() { Value = "ad-rich-text", Label = "ad-rich-text（图文混排：左动图 + 右 hook & bullets，需 video-to-text 提供 body）" },
                new() { Value = "static", Label = "static（1200×628 横幅样式，自动播放）" },
            }, HelpTip = "ad-4-3：全 bleed 封面 + 中央 Play 按钮（Apple 产品视频弹窗风格）。ad-rich-text：左侧 9:16 动态封面 + 右侧 hook 大字 + bullets（Instagram Story Ad / 小红书笔记风格），需上游 body 已结构化。static：传统 48% 上图 52% 下文横幅" },
            new() { Key = "accentColor", Label = "强调色", FieldType = "text", Required = false, DefaultValue = "#ff0050", HelpTip = "页面主色调（hex），TikTok 粉默认 #ff0050" },
            new() { Key = "ctaText", Label = "末页按钮文案", FieldType = "text", Required = false, DefaultValue = "去看完整视频" },
            new() { Key = "ctaUrlField", Label = "CTA 链接字段", FieldType = "text", Required = false, DefaultValue = "firstItem.shareUrl", HelpTip = "从上游 JSON 取哪个字段做 CTA 链接（点号路径），留空时退回到 #" },
            new() { Key = "ctaUrl", Label = "CTA 链接（直填）", FieldType = "text", Required = false, Placeholder = "https://www.tiktok.com/@author/video/xxx", HelpTip = "直接填一个完整 URL，优先级高于 ctaUrlField" },
            new() { Key = "itemsField", Label = "上游条目字段", FieldType = "text", Required = false, DefaultValue = "items", HelpTip = "从上游 JSON 取哪个字段作为海报页数组（默认 items）" },
            new() { Key = "publish", Label = "立即发布", FieldType = "select", Required = false, DefaultValue = "true", Options = new()
            {
                new() { Value = "true", Label = "立即发布（用户登录可见）" },
                new() { Value = "false", Label = "保存为草稿" },
            } },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "wp-in", Name = "items", DataType = "json", Required = true, Description = "上游条目数组（如 tiktok-creator-fetch 的 items 字段）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "wp-out", Name = "result", DataType = "json", Required = true, Description = "发布结果（含 posterId / weekKey / status / pageCount）" },
        },
    };

    public static readonly CapsuleTypeMeta MediaRehost = new()
    {
        TypeKey = CapsuleTypes.MediaRehost,
        Name = "媒体迁移到 COS",
        Description = "把上游 items 数组里每条记录的视频 / 封面 URL 下载到本平台 COS，输出形态保持一致但 URL 替换成稳定 COS 地址。解决 TikTok / B 站 / 小红书 CDN 防盗链导致前端 403 播放失败的问题。失败的字段保留原 URL 不阻塞流水线",
        Icon = "cloud-upload",
        Category = CapsuleCategory.Processor,
        AccentHue = 220,
        ConfigSchema = new()
        {
            new() { Key = "itemsField", Label = "上游条目字段", FieldType = "text", Required = false, DefaultValue = "items", HelpTip = "上游 JSON 哪个字段是数组（默认 items）。若上游本身是数组或单条目对象，会自动兜底" },
            new() { Key = "rehostFields", Label = "需要迁移的 URL 字段", FieldType = "text", Required = false, DefaultValue = "videoUrl,coverUrl", HelpTip = "每条 item 的哪些字段是 URL 需要下载迁移（逗号分隔），默认 videoUrl,coverUrl。下游 weekly-poster-publisher 读取的就是这两个字段" },
            new() { Key = "maxConcurrency", Label = "最大并发数", FieldType = "number", Required = false, DefaultValue = "4", HelpTip = "同时并行下载几个 item，建议 1-8。视频文件较大时降低以避免内存压力" },
            new() { Key = "maxBytesMb", Label = "单文件上限（MB）", FieldType = "number", Required = false, DefaultValue = "50", HelpTip = "单个媒体文件大于此值视为下载失败，跳过该字段保留原 URL" },
            new() { Key = "timeoutSeconds", Label = "下载超时（秒）", FieldType = "number", Required = false, DefaultValue = "120", HelpTip = "每个 URL 下载的超时时间。视频文件大时建议 180-300" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "mr-in", Name = "items", DataType = "json", Required = true, Description = "上游条目数组（含 videoUrl / coverUrl 等字段）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "mr-out", Name = "rehosted", DataType = "json", Required = true, Description = "结构同上游，但指定字段的 URL 已替换为 COS 直链。附带 rehosted / failed 计数" },
        },
    };

    public static readonly CapsuleTypeMeta HomepagePublisher = new()
    {
        TypeKey = CapsuleTypes.HomepagePublisher,
        Name = "发布到首页海报",
        Description = "把上游的图片或视频 URL 下载并写入「首页资源」槽位（slot），登录后首页快捷卡 / Agent 封面即时更新。slot 命名遵循 card.* / agent.{key}.image / agent.{key}.video / hero.* 约定",
        Icon = "image",
        Category = CapsuleCategory.Output,
        AccentHue = 200,
        ConfigSchema = new()
        {
            new() { Key = "slot", Label = "首页槽位 (slot)", FieldType = "text", Required = true, Placeholder = "agent.video-agent.video", HelpTip = "首页资源 slot：card.{id}（卡片背景）/ agent.{key}.image（Agent 封面图）/ agent.{key}.video（Agent 封面视频）/ hero.{id}（顶部 banner）" },
            new() { Key = "mediaType", Label = "媒体类型", FieldType = "select", Required = true, DefaultValue = "video", Options = new()
            {
                new() { Value = "video", Label = "视频（mp4/webm/mov）" },
                new() { Value = "image", Label = "图片（png/jpg/webp/gif）" },
            }, HelpTip = "决定 slot 写入的扩展名与 MIME 类型；与 slot 后缀（.image / .video）必须匹配" },
            new() { Key = "sourceField", Label = "上游字段名", FieldType = "text", Required = false, DefaultValue = "videoUrl", HelpTip = "从上游 JSON 中取哪个字段作为下载 URL。常用：videoUrl / coverUrl / cosUrl / url。也支持 firstItem.videoUrl 这样的点号路径" },
            new() { Key = "sourceUrl", Label = "直接源 URL（可选）", FieldType = "text", Required = false, Placeholder = "https://...", HelpTip = "如果不从上游取，直接填一个完整 URL；填了优先于 sourceField" },
            new() { Key = "timeoutSeconds", Label = "下载超时（秒）", FieldType = "number", Required = false, DefaultValue = "120" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "hp-in", Name = "media", DataType = "json", Required = false, Description = "上游媒体信息（含 videoUrl / coverUrl / cosUrl 等字段）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "hp-out", Name = "result", DataType = "json", Required = true, Description = "发布结果（含 slot / url / mime / sizeBytes）" },
        },
    };

    public static readonly CapsuleTypeMeta DouyinParser = new()
    {
        TypeKey = CapsuleTypes.DouyinParser,
        Name = "短视频解析",
        Description = "解析抖音/TikTok 短视频分享链接，提取视频无水印地址、标题、封面、作者等元数据。支持自动识别各平台链接特征",
        Icon = "video",
        Category = CapsuleCategory.Processor,
        AccentHue = 350,
        ConfigSchema = new()
        {
            new() { Key = "apiBaseUrl", Label = "TikHub API 地址", FieldType = "text", Required = false, DefaultValue = "https://tikhub.io/api/douyin", HelpTip = "TikHub API 基础地址，默认 https://tikhub.io/api/douyin" },
            new() { Key = "apiKey", Label = "API 密钥", FieldType = "password", Required = true, Placeholder = "Bearer xxx", HelpTip = "TikHub API 认证密钥，可使用 {{secrets.TIKHUB_API_KEY}} 引用工作流密钥" },
            new() { Key = "videoUrl", Label = "视频链接", FieldType = "text", Required = false, Placeholder = "https://v.douyin.com/xxxxxx/", HelpTip = "抖音分享链接（如留空则从上游输入获取）。支持 v.douyin.com / douyin.com / vm.tiktok.com 等格式" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "dp-in", Name = "input", DataType = "json", Required = false, Description = "上游数据（可包含 videoUrl 字段）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "dp-out", Name = "videoInfo", DataType = "json", Required = true, Description = "视频元数据（含无水印视频地址、标题、封面、作者等）" },
        },
    };

    public static readonly CapsuleTypeMeta VideoDownloader = new()
    {
        TypeKey = CapsuleTypes.VideoDownloader,
        Name = "视频下载到 COS",
        Description = "将视频 URL 下载并上传到 COS 对象存储，返回稳定可访问的 COS 地址",
        Icon = "download",
        Category = CapsuleCategory.Processor,
        AccentHue = 190,
        ConfigSchema = new()
        {
            new() { Key = "videoUrl", Label = "视频 URL", FieldType = "text", Required = false, Placeholder = "https://...", HelpTip = "直接视频文件地址（如留空则从上游 videoInfo.videoUrl 自动提取）" },
            new() { Key = "timeoutSeconds", Label = "下载超时（秒）", FieldType = "number", Required = false, DefaultValue = "120", HelpTip = "大文件建议设长一些，默认 120 秒" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "vd-in", Name = "videoInfo", DataType = "json", Required = false, Description = "上游视频信息（含 videoUrl 字段）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "vd-out", Name = "result", DataType = "json", Required = true, Description = "下载结果（含 cosUrl、fileSize、mimeType）" },
        },
    };

    public static readonly CapsuleTypeMeta VideoToText = new()
    {
        TypeKey = CapsuleTypes.VideoToText,
        Name = "视频内容转文本",
        Description = "三种模式把视频转文本：metadata 直接读元数据 / llm 多模态深读 / asr 真实下载视频 + ffmpeg 抽音轨 + 流式 ASR 转写。asr 模式默认再走一次 LLM 提炼出 hook 大字 + bullets，可直接喂给 ad-rich-text 海报",
        Icon = "file-text",
        Category = CapsuleCategory.Processor,
        AccentHue = 260,
        ConfigSchema = new()
        {
            new() { Key = "extractMode", Label = "提取模式", FieldType = "select", Required = false, DefaultValue = "metadata", Options = new()
            {
                new() { Value = "metadata", Label = "metadata（直接读上游字段，免费秒级）" },
                new() { Value = "llm", Label = "llm（封面 + 描述多模态分析）" },
                new() { Value = "asr", Label = "asr（下载视频 + ffmpeg + 流式 ASR + 可选 hook 提炼，慢但有真实转写）" },
            }, HelpTip = "metadata：直接拼上游已有 title/desc/subtitle 字段。llm：调多模态模型基于封面 + 描述推断旁白。asr：下载视频→ffmpeg 抽音→ASR 流式转写，每条耗时 10-60s，可用 maxItems 限制" },
            new() { Key = "systemPrompt", Label = "LLM 系统提示词", FieldType = "textarea", Required = false, Placeholder = "你是一个短视频内容分析专家…", HelpTip = "仅 llm 模式生效。自定义 LLM 的分析角色和输出要求" },
            new() { Key = "videoUrlField", Label = "视频 URL 字段", FieldType = "text", Required = false, DefaultValue = "videoUrl", HelpTip = "仅 asr 模式生效。从上游每个 item 取哪个字段作为视频 URL（点号路径，常见：videoUrl / video_url / playUrl / cosUrl）" },
            new() { Key = "itemsField", Label = "上游条目字段", FieldType = "text", Required = false, DefaultValue = "items", HelpTip = "仅 asr 模式生效。上游 JSON 哪个字段是数组（默认 items）。若上游本身是数组或单条目对象，会自动兜底" },
            new() { Key = "maxItems", Label = "最多处理条目数", FieldType = "number", Required = false, DefaultValue = "", HelpTip = "仅 asr 模式生效。空值 = 处理上游全部条目（推荐，自动跟随 count）；填正整数则按数量截断。每条 ASR 约 10-60s" },
            new() { Key = "enableHookExtraction", Label = "AI 二次提炼 hook + bullets", FieldType = "select", Required = false, DefaultValue = "true", Options = new()
            {
                new() { Value = "true", Label = "开启（转写后再走 LLM 出一句话 hook + 三条要点）" },
                new() { Value = "false", Label = "关闭（仅输出原始转写文字）" },
            }, HelpTip = "仅 asr 模式生效。开启后输出 item.hook（一句话钩子）+ item.bullets（要点数组）+ item.body（拼好的 markdown），可直接灌到 ad-rich-text 海报的 body 字段" },
            new() { Key = "hookSystemPrompt", Label = "hook 提炼系统提示词", FieldType = "textarea", Required = false, Placeholder = "你是短视频文案专家…", HelpTip = "仅 asr 模式且开启 hook 提炼时生效。留空走默认提示词，输出 JSON：{\"hook\":\"\",\"bullets\":[\"\"]}" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "vt-in", Name = "videoInfo", DataType = "json", Required = true, Description = "视频信息或 items 数组（asr 模式下会自动检测：单对象按一条处理，{items:[...]} 或裸数组按多条处理）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "vt-out", Name = "textContent", DataType = "json", Required = true, Description = "原结构 + 新增字段：transcript / hook / bullets / body（markdown bullets）。数组输入时返回 {items:[...], firstItem:{...}} 包装" },
        },
    };

    public static readonly CapsuleTypeMeta TextToCopywriting = new()
    {
        TypeKey = CapsuleTypes.TextToCopywriting,
        Name = "文本转文案",
        Description = "使用 LLM 将视频文本内容改写为指定风格的营销/分享文案",
        Icon = "pen-tool",
        Category = CapsuleCategory.Processor,
        AccentHue = 320,
        ConfigSchema = new()
        {
            new() { Key = "style", Label = "文案风格", FieldType = "select", Required = false, DefaultValue = "share", Options = new()
            {
                new() { Value = "share", Label = "分享推荐（轻松口语）" },
                new() { Value = "marketing", Label = "营销推广（吸引点击）" },
                new() { Value = "summary", Label = "内容摘要（简洁客观）" },
                new() { Value = "xiaohongshu", Label = "小红书风格（emoji+种草）" },
                new() { Value = "professional", Label = "专业分析（正式报告）" },
                new() { Value = "custom", Label = "自定义（使用下方提示词）" },
            }},
            new() { Key = "customPrompt", Label = "自定义提示词", FieldType = "textarea", Required = false, Placeholder = "请将以下视频内容改写为…", HelpTip = "风格选择「自定义」时生效，支持 {{input}} 引用上游内容" },
            new() { Key = "maxLength", Label = "文案最大字数", FieldType = "number", Required = false, DefaultValue = "500", HelpTip = "生成文案的最大字数限制" },
            new() { Key = "includeHashtags", Label = "包含话题标签", FieldType = "select", Required = false, DefaultValue = "true", Options = new()
            {
                new() { Value = "true", Label = "是（自动生成相关话题标签）" },
                new() { Value = "false", Label = "否" },
            }},
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "tc-in", Name = "textContent", DataType = "json", Required = true, Description = "上游文本内容" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "tc-out", Name = "copywriting", DataType = "json", Required = true, Description = "生成的文案（含 title、body、hashtags）" },
        },
    };

    // ──────────── CLI Agent 执行器 ────────────

    public static readonly CapsuleTypeMeta CliAgentExecutor = new()
    {
        TypeKey = CapsuleTypes.CliAgentExecutor,
        Name = "CLI Agent 执行器",
        Description = "可扩展的代码生成执行器，支持多种执行模式（内置脚本/Docker/API）和多轮迭代修改",
        Icon = "terminal",
        Category = CapsuleCategory.Processor,
        AccentHue = 280,
        ConfigSchema = new()
        {
            // ── 执行器类型（核心扩展点） ──
            new() { Key = "executorType", Label = "执行器类型", FieldType = "select", Required = true, DefaultValue = "builtin-llm", Options = new()
            {
                new() { Value = "builtin-llm", Label = "内置 LLM 生成（无需 Docker）" },
                new() { Value = "docker", Label = "Docker 容器" },
                new() { Value = "api", Label = "外部 API（OpenHands/Bolt 等）" },
                new() { Value = "script", Label = "本地脚本（Jint 沙箱）" },
                new() { Value = "lobster", Label = "龙虾（两阶段 LLM：先规划结构再生成）" },
            }, HelpTip = "选择执行方式：内置 LLM 直接生成页面，Docker 运行容器化 CLI 工具，API 调用外部服务，脚本在 Jint 沙箱中执行" },

            // ── 通用配置 ──
            new() { Key = "spec", Label = "规范类型", FieldType = "select", Required = false, DefaultValue = "none", Options = new()
            {
                new() { Value = "none", Label = "无（自由生成）" },
                new() { Value = "spec", Label = "产品规格 (Spec)" },
                new() { Value = "dri", Label = "DRI 方案" },
                new() { Value = "dev", Label = "开发设计 (Dev)" },
                new() { Value = "sdd", Label = "软件设计文档 (SDD)" },
            }},
            new() { Key = "framework", Label = "框架", FieldType = "select", Required = false, DefaultValue = "html", Options = new()
            {
                new() { Value = "html", Label = "纯 HTML（自包含）" },
                new() { Value = "react", Label = "React + Vite" },
                new() { Value = "vue", Label = "Vue + Vite" },
                new() { Value = "nextjs", Label = "Next.js" },
                new() { Value = "svelte", Label = "Svelte" },
                new() { Value = "custom", Label = "自定义（由执行器决定）" },
            }},
            new() { Key = "style", Label = "风格技能", FieldType = "select", Required = false, DefaultValue = "ui-ux-pro-max", Options = new()
            {
                new() { Value = "ui-ux-pro-max", Label = "UI/UX Pro Max（默认高端）" },
                new() { Value = "minimal", Label = "极简风格" },
                new() { Value = "dashboard", Label = "数据看板" },
                new() { Value = "landing", Label = "着陆页" },
                new() { Value = "doc", Label = "文档站" },
                new() { Value = "custom", Label = "自定义（在提示词中描述）" },
            }},
            new() { Key = "prompt", Label = "生成提示词", FieldType = "textarea", Required = false, Placeholder = "请生成一个产品展示页面，包含 Hero 区域、功能介绍、价格表…", HelpTip = "描述你想要生成的页面内容，支持 {{variable}} 变量替换" },

            // ── Docker 执行器配置（executorType=docker 时生效） ──
            new() { Key = "image", Label = "Docker 镜像", FieldType = "text", Required = false, Placeholder = "node:20-slim", HelpTip = "Docker 执行器专用：容器镜像地址" },
            new() { Key = "setupCommand", Label = "初始化命令", FieldType = "textarea", Required = false, Placeholder = "npm install", HelpTip = "Docker 执行器专用：容器首轮初始化命令" },
            new() { Key = "generateCommand", Label = "生成命令", FieldType = "textarea", Required = false, Placeholder = "node generate.js", HelpTip = "Docker 执行器专用：每轮执行的生成命令" },

            // ── API 执行器配置（executorType=api 时生效） ──
            new() { Key = "apiEndpoint", Label = "API 地址", FieldType = "text", Required = false, Placeholder = "https://api.example.com/generate", HelpTip = "API 执行器专用：外部服务的生成接口地址" },
            new() { Key = "apiKey", Label = "API 密钥", FieldType = "password", Required = false, HelpTip = "API 执行器专用：认证密钥" },

            // ── 脚本执行器配置（executorType=script 时生效） ──
            new() { Key = "scriptCode", Label = "生成脚本", FieldType = "code", Required = false, Placeholder = "// context 对象包含 spec/framework/style/prompt\n// previousOutput/userFeedback 用于多轮迭代\nresult = generatePage(context);", HelpTip = "脚本执行器专用：Jint 沙箱中执行的 JavaScript" },

            // ── Lobster 执行器配置 ──
            new() { Key = "lobsterStyle", Label = "龙虾风格", FieldType = "select", Required = false, DefaultValue = "professional", Options = new()
            {
                new() { Value = "professional", Label = "专业商务" },
                new() { Value = "playful", Label = "活泼趣味" },
                new() { Value = "tech", Label = "科技极客" },
            }, HelpTip = "Lobster 执行器专用：着陆页视觉风格" },

            // ── 资源限制 ──
            new() { Key = "timeoutSeconds", Label = "超时时间（秒）", FieldType = "number", Required = false, DefaultValue = "300" },
            new() { Key = "envVars", Label = "环境变量", FieldType = "json", Required = false, Placeholder = "{\"API_KEY\": \"xxx\"}", HelpTip = "传递给执行器的环境变量（JSON 对象）" },
        },
        DefaultInputSlots = new()
        {
            new() { SlotId = "cli-spec-in", Name = "specification", DataType = "text", Required = false, Description = "产品规格/需求文档（首轮输入）" },
            new() { SlotId = "cli-prev-in", Name = "previousOutput", DataType = "text", Required = false, Description = "上一轮生成的产物（多轮迭代时传入）" },
            new() { SlotId = "cli-feedback-in", Name = "userFeedback", DataType = "text", Required = false, Description = "用户修改意见（多轮迭代时传入）" },
        },
        DefaultOutputSlots = new()
        {
            new() { SlotId = "cli-html-out", Name = "htmlOutput", DataType = "text", Required = true, Description = "生成的 HTML/页面产物" },
            new() { SlotId = "cli-files-out", Name = "fileManifest", DataType = "json", Required = false, Description = "生成的文件清单（多文件项目时）" },
            new() { SlotId = "cli-log-out", Name = "executionLog", DataType = "text", Required = false, Description = "容器执行日志（调试用）" },
        },
    };

    /// <summary>
    /// 按分类排序的全部舱类型
    /// </summary>
    public static readonly IReadOnlyList<CapsuleTypeMeta> All = new List<CapsuleTypeMeta>
    {
        // 触发类
        Timer, WebhookReceiver, ManualTrigger, FileUpload, EventTrigger,
        // 处理类
        TapdCollector, HttpRequest, SmartHttp, LlmAnalyzer, ScriptExecutor, DataExtractor, DataMerger, FormatConverter, DataAggregator,
        // 流程控制类
        Delay, Condition,
        // 输出类
        ReportGenerator, WebpageGenerator, FileExporter, WebhookSender, NotificationSender, VideoGeneration, SitePublisher, EmailSender,
        // CLI Agent 执行器
        CliAgentExecutor,
        // 短视频工作流类
        DouyinParser, VideoDownloader, VideoToText, TextToCopywriting, TiktokCreatorFetch, MediaRehost, HomepagePublisher, WeeklyPosterPublisher,
    };

    /// <summary>按 TypeKey 查找</summary>
    public static CapsuleTypeMeta? Get(string typeKey) => All.FirstOrDefault(t => t.TypeKey == typeKey);
}
