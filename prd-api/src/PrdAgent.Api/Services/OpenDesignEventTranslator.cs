using System.Text.Json;

namespace PrdAgent.Api.Services;

/// <summary>
/// OpenDesign 事件（status / text_delta / thinking / done / error）→ MAP 执行器分片的唯一翻译处。
///
/// 经 CDS 会话与直连设计执行服务两条传输面收到的是同一种事件形状（map-design-executor-v1 第五节
/// 特意沿用了 CDS 会话事件），所以翻译只能有一份：抄两份的话，某天给一边加了阶段、另一边照旧，
/// 用户会在两条路径上看到两种说法（判据与接线纪律 形状 3；design.platform.design-runtime.md 第八节）。
/// 传输面各自保留的只有「怎么拿到事件」与「done 之后怎么收尾」。
/// </summary>
internal sealed class OpenDesignEventTranslator
{
    internal const string Status = "status";
    internal const string TextDelta = "text_delta";
    internal const string Thinking = "thinking";
    internal const string Done = "done";
    internal const string Error = "error";

    private readonly OpenDesignStageProgress _stageProgress;

    internal OpenDesignEventTranslator(bool editing, int startProgress)
    {
        _stageProgress = new OpenDesignStageProgress(editing, startProgress);
    }

    /// <summary>当前已写出的进度（只增不减），排队提示等非阶段事件沿用它。</summary>
    internal int Progress => _stageProgress.Progress;

    /// <summary>
    /// 把一条进度类事件翻成分片；done / error / 认不出的类型返回 null，由调用方按传输面收尾。
    /// </summary>
    internal DesignArtifactExecutorChunk? ToChunk(string type, string payloadJson)
    {
        switch (type)
        {
            case Status:
                var update = _stageProgress.Observe(
                    ReadPayloadString(payloadJson, "reason"),
                    ReadPayloadInt(payloadJson, "elapsedSeconds"),
                    ReadPayloadInt(payloadJson, "attempt"));
                return update == null
                    ? null
                    : new DesignArtifactExecutorChunk("phase", update.Phase, Progress: update.Progress);
            case TextDelta:
            case Thinking:
                // 阶段的人话摘要与推理流都进「思考」栏：它们是过程说明，不是页面正文。
                var text = ReadPayloadString(payloadJson, "text");
                return string.IsNullOrEmpty(text) ? null : new DesignArtifactExecutorChunk("thinking", text);
            default:
                return null;
        }
    }

    /// <summary>远端 error 事件 → 交给用户的那条异常（文案由 <see cref="OpenDesignFailureMessage"/> 唯一渲染）。</summary>
    internal static InvalidOperationException RemoteFailure(string payloadJson) =>
        OpenDesignFailureMessage.Failure(
            OpenDesignFailureStage.RemoteRun,
            ReadPayloadString(payloadJson, "message"),
            ReadPayloadString(payloadJson, "code"));

    internal static int? ReadPayloadInt(string payloadJson, string field)
    {
        try
        {
            using var doc = JsonDocument.Parse(payloadJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty(field, out var value)
                   && value.ValueKind == JsonValueKind.Number
                   && value.TryGetInt32(out var number)
                ? number
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static string? ReadPayloadString(string payloadJson, string field)
    {
        try
        {
            using var doc = JsonDocument.Parse(payloadJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty(field, out var value)
                   && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
