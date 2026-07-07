using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class VolcengineVideoTransformerTests
{
    [Fact]
    public void TransformRequest_ShouldConvertOpenRouterVideoBodyToVolcengineContentTask()
    {
        var transformer = new VolcengineVideoTransformer();
        var body = new JsonObject
        {
            ["model"] = "doubao-seedance-2-0-fast-260128",
            ["prompt"] = "生成一段产品演示视频",
            ["aspect_ratio"] = "16:9",
            ["resolution"] = "720p",
            ["duration"] = 5,
            ["generate_audio"] = true,
            ["seed"] = 42,
            ["frame_images"] = new JsonArray
            {
                new JsonObject
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JsonObject { ["url"] = "https://example.test/frame.png" },
                    ["frame_type"] = "first_frame"
                }
            }
        };

        var transformed = transformer.TransformRequest(body, null);

        transformed["model"]!.GetValue<string>().ShouldBe("doubao-seedance-2-0-fast-260128");
        transformed["ratio"]!.GetValue<string>().ShouldBe("16:9");
        transformed["resolution"]!.GetValue<string>().ShouldBe("720p");
        transformed["duration"]!.GetValue<int>().ShouldBe(5);
        transformed["generate_audio"]!.GetValue<bool>().ShouldBeTrue();
        var content = transformed["content"]!.AsArray();
        content.Count.ShouldBe(2);
        content[0]!["type"]!.GetValue<string>().ShouldBe("text");
        content[0]!["text"]!.GetValue<string>().ShouldBe("生成一段产品演示视频");
        content[1]!["type"]!.GetValue<string>().ShouldBe("image_url");
        content[1]!["role"]!.GetValue<string>().ShouldBe("first_frame");
        content[1]!["image_url"]!["url"]!.GetValue<string>().ShouldBe("https://example.test/frame.png");
    }

    [Fact]
    public void StatusRequest_ShouldAppendTaskIdToTargetUrlAndDropBody()
    {
        var transformer = new VolcengineVideoTransformer();
        var body = new JsonObject
        {
            ["_gateway_operation"] = "status",
            ["task_id"] = "cgt-123"
        };

        transformer.ResolveTargetUrl(
                "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
                body,
                null)
            .ShouldBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-123");

        transformer.TransformRequest(body, null).Count.ShouldBe(0);
    }

    [Fact]
    public void TransformResponse_ShouldMapSucceededTaskToOpenRouterVideoShape()
    {
        var transformer = new VolcengineVideoTransformer();
        var raw = new JsonObject
        {
            ["id"] = "cgt-123",
            ["status"] = "succeeded",
            ["content"] = new JsonObject
            {
                ["video_url"] = "https://tos.example.test/video.mp4"
            },
            ["usage"] = new JsonObject
            {
                ["cost"] = 0.56
            }
        };

        var transformed = transformer.TransformResponse(raw, null);

        transformed["id"]!.GetValue<string>().ShouldBe("cgt-123");
        transformed["status"]!.GetValue<string>().ShouldBe("completed");
        transformed["unsigned_urls"]!.AsArray()[0]!.GetValue<string>().ShouldBe("https://tos.example.test/video.mp4");
        transformed["usage"]!["cost"]!.GetValue<double>().ShouldBe(0.56);
    }
}
