using System.Collections.Concurrent;
using System.Reflection;
using PrdAgent.Api.Controllers.Stub;
using Xunit;

public sealed class DevelopmentStubBudgetTests
{
    [Fact]
    public void CacheNeverExceedsCountOrByteBudget()
    {
        var type = typeof(StubOpenAIController);
        var store = (ConcurrentDictionary<string, (byte[] bytes, DateTimeOffset expireAt)>)type
            .GetField("_imgStore", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
        var put = type.GetMethod("PutImage", BindingFlags.NonPublic | BindingFlags.Static)!;
        store.Clear();
        try
        {
            for (var i = 0; i < 70; i++)
            {
                put.Invoke(null, new object[] { new byte[1024 * 1024] });
                Assert.InRange(store.Count, 1, 64);
                Assert.True(store.Values.Sum(v => (long)v.bytes.Length) <= 32 * 1024 * 1024);
            }
            store.Clear();
            for (var i = 0; i < 70; i++) put.Invoke(null, new object[] { new byte[1] });
            Assert.Equal(64, store.Count);
        }
        finally { store.Clear(); }
    }

    [Theory]
    [InlineData("4096x4096", 1024, 1024)]
    [InlineData("16x16", 64, 64)]
    [InlineData("1x1", 1024, 1024)]
    public void OutputDimensionsHaveHardPixelCeiling(string size, int width, int height)
    {
        var parse = typeof(StubOpenAIController).GetMethod("ParseSizeOrDefault", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Equal((width, height), ((int, int))parse.Invoke(null, new object[] { size, 1024, 1024 })!);
    }
}
