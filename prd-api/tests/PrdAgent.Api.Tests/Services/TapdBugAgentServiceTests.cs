using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class TapdBugAgentServiceTests
{
    [Fact]
    public void NormalizeDraft_ShouldMapChineseEnumsAndDefaultFields()
    {
        var draft = TapdBugAgentService.NormalizeDraft(new TapdBugDraft
        {
            Title = "产品库实物附近门店H5，地区筛选选择后无过滤效果",
            Severity = "主要",
            Priority = "高",
            Preconditions = new List<string> { "品牌已开通防窜物流" },
            Steps = new List<string> { "1. 进入附近门店页面" },
            ActualResult = new List<string> { "仍展示全国门店" },
            ExpectedResult = new List<string> { "仅展示所选地区门店" },
        }, null);

        Assert.Equal("serious", draft.Severity);
        Assert.Equal("high", draft.Priority);
        Assert.Equal("附近门店组件精准筛选", draft.Module);
        Assert.Equal("黄卫杰;", draft.CurrentOwner);
        Assert.Empty(draft.MissingFields);
        Assert.Equal("进入附近门店页面", draft.Steps[0]);
    }

    [Fact]
    public void NormalizeDraft_ShouldReportMissingRequiredFields()
    {
        var draft = TapdBugAgentService.NormalizeDraft(new TapdBugDraft
        {
            ActualResult = new List<string> { "列表无变化" },
        }, null);

        Assert.Contains("标题", draft.MissingFields);
        Assert.Contains("前置条件", draft.MissingFields);
        Assert.Contains("复现步骤", draft.MissingFields);
        Assert.Contains("预期结果", draft.MissingFields);
        Assert.DoesNotContain("实际结果", draft.MissingFields);
    }

    [Fact]
    public void NormalizeDraft_ShouldLeaveUnstatedExpectedResultMissing()
    {
        var draft = TapdBugAgentService.NormalizeDraft(new TapdBugDraft(), "不能输汉字，提示502");

        Assert.Equal(new[] { "预期结果" }, draft.MissingFields);
        Assert.Equal("不能输汉字，提示502", draft.Title);
        Assert.Contains("已登录系统并进入出现该问题的功能页面", draft.Preconditions);
        Assert.Contains("在相关输入框中输入汉字内容并提交或保存", draft.Steps);
        Assert.Contains("不能输汉字，提示502", draft.ActualResult);
        Assert.Empty(draft.ExpectedResult);
    }

    [Theory]
    [InlineData("列表返回后为空。", null)]
    [InlineData("列表返回后为空。预期结果：", null)]
    [InlineData("列表返回后为空。预期结果：待确认。", null)]
    [InlineData("列表返回后为空。\n预期结果：\n显示该记录。\n实际结果：列表为空", "显示该记录。")]
    [InlineData("列表返回后为空。\r\n预期结果:\r\n显示该记录", "显示该记录")]
    [InlineData("列表返回后为空。\n预期结果：\n实际结果：列表为空", null)]
    [InlineData("列表返回后为空。\n预期结果：\n待确认。", null)]
    [InlineData("预期结果：\n显示该记录。\n保留原筛选。\n复现步骤：返回列表", "显示该记录。\n保留原筛选。")]
    [InlineData("选东区后仍显示西区。预期只显示东区门店。", "只显示东区门店")]
    [InlineData("列表为空，正确应该显示该记录。", "显示该记录")]
    public async Task StreamPreview_ExpectedResultComesFromUserInsteadOfModel(string naturalText, string? expected)
    {
        var identity = new TaskExecutionIdentity("tapd-test-permit");
        var streamed = 0;
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.StreamAsync(It.Is<GatewayRequest>(r => (int?)r.RequestBody!["max_tokens"] == 4096
            && TaskExecutionContext.Current == identity), It.IsAny<CancellationToken>()))
            .Callback(() => streamed++).Returns(ModelDraft());
        var service = new TapdBugAgentService(gateway.Object, Mock.Of<IHttpClientFactory>(),
            NullLogger<TapdBugAgentService>.Instance, new ConfigurationBuilder().Build());
        var admitted = 0;

        var result = await service.StreamPreviewAsync(new TapdBugPreviewRequest { NaturalText = naturalText },
            (_, _) => Task.CompletedTask, default, _ =>
            {
                admitted++;
                return Task.FromResult(identity);
            });

        Assert.Equal(1, admitted);
        Assert.Equal(1, streamed);
        Assert.Null(TaskExecutionContext.Current);
        if (expected is null)
        {
            Assert.Empty(result.ExpectedResult);
            Assert.Contains("预期结果", result.MissingFields);
        }
        else
        {
            Assert.Equal(expected.Split('\n'), result.ExpectedResult);
            Assert.DoesNotContain("预期结果", result.MissingFields);
        }

        static async IAsyncEnumerable<GatewayStreamChunk> ModelDraft()
        {
            await Task.CompletedTask;
            yield return new GatewayStreamChunk
            {
                Type = GatewayChunkType.Text,
                Content = """{"title":"列表显示异常","expectedResult":["模型猜测的结果"]}"""
            };
        }
    }

    [Fact]
    public async Task StreamPreview_CompleteFormDoesNotRequireModelPermission()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var service = new TapdBugAgentService(gateway.Object, Mock.Of<IHttpClientFactory>(),
            NullLogger<TapdBugAgentService>.Instance, new ConfigurationBuilder().Build());
        var request = new TapdBugPreviewRequest
        {
            Overrides = new TapdBugDraft
            {
                Title = "地区筛选无效",
                Preconditions = ["两个地区都有门店"],
                Steps = ["选择东区"],
                ActualResult = ["仍显示西区门店"],
                ExpectedResult = ["只显示东区门店"],
            },
        };

        var result = await service.StreamPreviewAsync(request, (_, _) => Task.CompletedTask, default,
            _ => throw new InvalidOperationException("完整表单不应尝试获得模型许可"));

        Assert.Equal(request.Overrides.ExpectedResult, result.ExpectedResult);
        Assert.Empty(result.MissingFields);
    }

    [Fact]
    public void NormalizeDraft_ShouldUseUpdatedTapdBugTypeValues()
    {
        var valid = TapdBugAgentService.NormalizeDraft(new TapdBugDraft
        {
            BugType = "功能遗漏",
        }, "页面缺少搜索按钮");
        var oldValue = TapdBugAgentService.NormalizeDraft(new TapdBugDraft
        {
            BugType = "界面展示",
        }, "页面缺少搜索按钮");

        Assert.Equal("功能遗漏", valid.BugType);
        Assert.Equal("逻辑错误", oldValue.BugType);
    }

    [Fact]
    public void BuildDescriptionHtml_ShouldEscapeUserInput()
    {
        var html = TapdBugAgentService.BuildDescriptionHtml(
            new List<string> { "<script>alert(1)</script>" },
            new List<string> { "点击筛选" },
            new List<string> { "列表无变化" },
            new List<string> { "只展示所选地区" });

        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;", html);
        Assert.DoesNotContain("<script>alert(1)</script>", html);
        Assert.Contains("<h3>复现步骤</h3>", html);
    }

    [Fact]
    public void ParseDraftFromLlm_ShouldReadStrictJson()
    {
        var draft = TapdBugAgentService.ParseDraftFromLlm("""
        ```json
        {
          "title": "地区筛选无效",
          "severity": "normal",
          "priority": "medium",
          "bugType": "逻辑错误",
          "preconditions": ["已登录"],
          "steps": ["进入页面"],
          "actualResult": ["无过滤"],
          "expectedResult": ["按地区过滤"]
        }
        ```
        """);

        Assert.Equal("地区筛选无效", draft.Title);
        Assert.Equal("normal", draft.Severity);
        Assert.Equal("medium", draft.Priority);
        Assert.Single(draft.Steps);
    }
}
