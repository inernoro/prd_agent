using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class DoubaoAsrTransformerTests
{
    [Fact]
    public void TransformResponse_ShouldReadCurrentResultObjectWithUtterances()
    {
        var raw = (JsonObject)JsonNode.Parse("""
        {
          "audio_info": { "duration": 2499 },
          "result": {
            "additions": { "duration": "2499" },
            "text": "关闭透传。",
            "utterances": [
              {
                "start_time": 450,
                "end_time": 1530,
                "text": "关闭透传。"
              }
            ]
          }
        }
        """)!;

        var transformed = new DoubaoAsrTransformer().TransformResponse(raw, null);

        transformed["text"]!.GetValue<string>().ShouldBe("关闭透传。");
        var segments = transformed["segments"]!.AsArray();
        segments.Count.ShouldBe(1);
        segments[0]!["start"]!.GetValue<double>().ShouldBe(0.45);
        segments[0]!["end"]!.GetValue<double>().ShouldBe(1.53);
        segments[0]!["text"]!.GetValue<string>().ShouldBe("关闭透传。");
    }

    [Fact]
    public void TransformResponse_ShouldKeepLegacyResultArraySupport()
    {
        var raw = (JsonObject)JsonNode.Parse("""
        {
          "result": [
            {
              "additions": { "duration": "1200" },
              "text": "第一段。"
            },
            {
              "additions": { "duration": "800" },
              "text": "第二段。"
            }
          ]
        }
        """)!;

        var transformed = new DoubaoAsrTransformer().TransformResponse(raw, null);

        transformed["text"]!.GetValue<string>().ShouldBe("第一段。第二段。");
        var segments = transformed["segments"]!.AsArray();
        segments.Count.ShouldBe(2);
        segments[0]!["start"]!.GetValue<double>().ShouldBe(0);
        segments[0]!["end"]!.GetValue<double>().ShouldBe(1.2);
        segments[1]!["start"]!.GetValue<double>().ShouldBe(1.2);
        segments[1]!["end"]!.GetValue<double>().ShouldBe(2);
    }
}
