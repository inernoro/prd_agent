using System.Text;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class QuickCreationBrowserPlaybackTests
{
    [Fact]
    public void RenderSandbox_PreservesCompactAssetsAndPreventsClosingTheDataScript()
    {
        var bundle = Encoding.UTF8.GetBytes("""{"aac":"++++","captions":[{"text":"</script><img src=x>"}]}""");

        var html = QuickCreationBrowserPlayback.RenderSandbox(bundle);

        Assert.Contains("""{"aac":"++++","captions":""", html);
        Assert.Contains("""\u003c/script>\u003cimg src=x>""", html);
        Assert.DoesNotContain("</script><img", html);
        Assert.Contains("""id="start">播放视频</button>""", html);
        Assert.Contains("object-fit:contain", html);
        Assert.Contains(".controls{flex:none", html);
    }
}
