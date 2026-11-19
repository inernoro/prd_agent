using System.Text.Json;

namespace PrdAgent.Api.Services;

public sealed record InformationDeliveryTemplateSection(string Title, string Purpose, string Example);

public sealed record InformationDeliveryTemplate(
    string Id,
    string Version,
    string Title,
    string UseWhen,
    string ExampleTitle,
    IReadOnlyList<InformationDeliveryTemplateSection> Sections)
{
    public string BuildInstructions(string? authorFocus)
    {
        var outline = string.Join('\n', Sections.Select(section => $"- {section.Title}：{section.Purpose}"));
        const string courseShape = """{"chapters":[{"title":"","narration":"","steps":[""],"basis":[""],"practice":{"question":"","answer":""}}],"openQuestions":[""]}""";
        var instructions = $$"""
            按平台模板《{{Title}}》组织这次的资料。先给结论和下一步，再提供可定位的详情与原文依据。
            保留关键数字、适用范围、条件、例外、行动角色和作者确认的判断。引用必须指向实际使用的来源和位置。
            遇到会改变执行结果的缺口或冲突，指出双方依据并请求作者裁定，不猜测答案。
            平台模板规定结构，业务事实只能来自本次资料和作者裁定。
            尽早在工作区生成 index.html 和 assets/delivery.json。先写入课程初稿和待裁定问题，便于作者在运行中查看。
            收到作者裁定后更新这两个实际文件，并移除已解决的问题。保留未解决事项和其来源。
            assets/delivery.json 的格式为 {{courseShape}}。
            每章须讲清关键条件和具体动作。basis 写可定位的资料名与段落或作者裁定。至少一章有一题基于真实边界的练习及其参考答案。openQuestions 只有在关键问题均得到裁定时才为空数组。
            网页使用内联样式和原生 HTML 元素，不加载第三方资源，不把资料原文文件直接打入网页包。

            文章骨架
            {{outline}}
            """;
        return string.IsNullOrWhiteSpace(authorFocus)
            ? instructions
            : $"{instructions}\n\n作者希望突出的重点\n{authorFocus.Trim()}";
    }
}

public static class InformationDeliveryTemplates
{
    public const string CoursePath = "assets/delivery.json";

    public static bool IsDraftTextPath(string path) => path == CoursePath;

    public static void EnsureReadyCourse(ParsedDesignWorkspaceResult result)
        => _ = ReadReadyCourse(result);

    public static IReadOnlyList<InformationDeliveryChapter> ReadReadyCourse(ParsedDesignWorkspaceResult result)
    {
        using var json = ReadCourse(result);
        var course = json.RootElement;
        if (ReadQuestions(course).GetArrayLength() != 0)
            throw new InvalidOperationException("课程仍有待作者裁定的问题");
        return ReadChapters(course, requirePractice: true);
    }

    internal static bool ValidateSessionCourse(ParsedDesignWorkspaceResult result, IReadOnlyList<string> correctionIds)
    {
        using var json = ReadCourse(result);
        var course = json.RootElement;
        var pending = ReadQuestions(course).GetArrayLength() > 0;
        _ = ReadChapters(course, requirePractice: !pending);
        if (correctionIds.Count != 0
            && (!course.TryGetProperty("appliedCorrections", out var applied) || applied.ValueKind != JsonValueKind.Array
                || applied.GetArrayLength() != correctionIds.Count
                || !applied.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
                    .SequenceEqual(correctionIds, StringComparer.Ordinal)))
            throw new InvalidOperationException("课程文件缺少本轮作者裁定的完整回执");
        return pending;
    }

    private static JsonDocument ReadCourse(ParsedDesignWorkspaceResult result)
    {
        var file = result.Files.SingleOrDefault(item => item.Path == CoursePath);
        if (file == null || file.Size > 24_000)
            throw new InvalidOperationException("课程文件缺失或超出大小限制");
        return JsonDocument.Parse(Convert.FromBase64String(file.ContentBase64));
    }

    private static JsonElement ReadQuestions(JsonElement course)
    {
        if (course.ValueKind != JsonValueKind.Object
            || !course.TryGetProperty("openQuestions", out var questions)
            || questions.ValueKind != JsonValueKind.Array || questions.GetArrayLength() > 12
            || questions.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(item.GetString()) || item.GetString()!.Length > 800))
            throw new InvalidOperationException("课程文件的待裁定问题格式无效");
        return questions;
    }

    private static IReadOnlyList<InformationDeliveryChapter> ReadChapters(JsonElement course, bool requirePractice)
    {
        if (!course.TryGetProperty("chapters", out var chapters) || chapters.ValueKind != JsonValueKind.Array
            || chapters.GetArrayLength() is < 1 or > 12)
            throw new InvalidOperationException("课程需要 1 至 12 个有效章节");
        var ready = new List<InformationDeliveryChapter>();
        var hasPractice = false;
        foreach (var chapter in chapters.EnumerateArray())
        {
            if (chapter.ValueKind != JsonValueKind.Object
                || !IsText(chapter, "title", 100) || !IsText(chapter, "narration", 1600)
                || !IsTextList(chapter, "steps") || !IsTextList(chapter, "basis"))
                throw new InvalidOperationException("课程章节缺少标题、讲解、步骤或依据");
            if (chapter.TryGetProperty("practice", out var practice) && practice.ValueKind == JsonValueKind.Object
                && IsText(practice, "question", 300) && IsText(practice, "answer", 800))
                hasPractice = true;
            ready.Add(new InformationDeliveryChapter(
                chapter.GetProperty("title").GetString()!, chapter.GetProperty("narration").GetString()!,
                chapter.GetProperty("steps").EnumerateArray().Select(item => item.GetString()!).ToArray()));
        }
        if (requirePractice && !hasPractice)
            throw new InvalidOperationException("课程需要至少一道基于资料的练习");
        return ready;
    }

    private static bool IsText(JsonElement parent, string key, int maxLength) =>
        parent.TryGetProperty(key, out var text) && text.ValueKind == JsonValueKind.String
        && text.GetString() is { Length: > 0 } value && value.Length <= maxLength && !string.IsNullOrWhiteSpace(value);

    private static bool IsTextList(JsonElement parent, string key) =>
        parent.TryGetProperty(key, out var list) && list.ValueKind == JsonValueKind.Array
        && list.GetArrayLength() is >= 1 and <= 12
        && list.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String
            && item.GetString() is { Length: <= 800 } value && !string.IsNullOrWhiteSpace(value));

    public static IReadOnlyList<InformationDeliveryTemplate> All { get; } = Array.AsReadOnly(new[]
    {
        new InformationDeliveryTemplate(
            "team-tutorial", "1", "团队操作教程", "让同事第一次使用就能照着做、判断做得对不对。",
            "示例 · 会后录音归档",
            Array.AsReadOnly(new[]
            {
                new InformationDeliveryTemplateSection("先做什么", "一句话说明目标、适用对象和执行前提。",
                    "主持人在本部门会议结束后归档录音。开始前先向参会者确认录音可在本部门查阅。"),
                new InformationDeliveryTemplateSection("条件与例外", "列出会改变步骤的范围、分支和确认责任。",
                    "包含访客发言时，先请访客确认可见范围。若无法取得确认，暂缓归档该段并通知主持人。"),
                new InformationDeliveryTemplateSection("跟着做", "按顺序写明每一步由谁做、怎么做、怎样确认完成。",
                    "主持人上传允许归档的片段，填写会议日期。值班同事用接收者账号打开文件，核对音轨可播放。"),
                new InformationDeliveryTemplateSection("练习与原文", "用一个边界案例检验理解，并指向原文片段或作者裁定。",
                    "有访客发言但未获得确认，先暂停该段。示例依据为《会后归档约定》第 2 条「访客发言」。"),
            })),
        new InformationDeliveryTemplate(
            "decision-brief", "1", "决策与行动简报", "让同事快速知道已决事项、行动人和仍需核对的问题。",
            "示例 · 每周值班交接",
            Array.AsReadOnly(new[]
            {
                new InformationDeliveryTemplateSection("结论与范围", "先写已确认的决定和适用范围。",
                    "从下周开始，周一上午在部门知识库更新交接。该安排适用于工作日值班。"),
                new InformationDeliveryTemplateSection("谁做什么", "列出行动人、完成条件和时间。",
                    "当周值班人更新待处理事项，接班人在周一 10:00 前确认能打开清单。"),
                new InformationDeliveryTemplateSection("例外和待确认事项", "说明例外、替代动作和未决问题由谁裁定。",
                    "节假日顺延至首个工作日。临时跨组借调由当周负责人确认交接人。"),
                new InformationDeliveryTemplateSection("原文与版本", "列出决定出处和变更记录，可回到原文。",
                    "示例依据为《值班交接周会纪要》第 1、2 项。跨组借调由本次纪要补充。"),
            })),
    });

    public static InformationDeliveryTemplate? Find(string? id, string? version) =>
        All.SingleOrDefault(template => template.Id == id && template.Version == version);
}

public sealed record InformationDeliveryChapter(string Title, string Narration, IReadOnlyList<string> Steps);
