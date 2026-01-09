using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class GroupContextCompressionPlannerTests
{
    [Fact]
    public void CreatePlan_WhenBelowThreshold_ShouldNotCompress()
    {
        var msgs = new List<Message>
        {
            new() { Id = "1", Content = "a", GroupSeq = 1 },
            new() { Id = "2", Content = "bb", GroupSeq = 2 },
        };

        var plan = GroupContextCompressionPlanner.CreatePlan(
            msgs,
            thresholdChars: 10,
            targetKeepMaxChars: 5,
            minKeepCount: 1);

        Assert.False(plan.ShouldCompress);
        Assert.Empty(plan.ToCompress);
        Assert.Equal(2, plan.KeepRaw.Count);
        Assert.Equal(3, plan.TotalCharsBefore);
    }

    [Fact]
    public void CreatePlan_WhenAboveThreshold_ShouldPlanCompressionAndKeepAtLeastMinCount()
    {
        static Message M(string id, int len, long seq)
            => new() { Id = id, Content = new string('x', len), GroupSeq = seq };

        var msgs = new List<Message>
        {
            M("1", 20, 1),
            M("2", 20, 2),
            M("3", 20, 3),
            M("4", 20, 4),
            M("5", 20, 5),
        };

        var plan = GroupContextCompressionPlanner.CreatePlan(
            msgs,
            thresholdChars: 50,
            targetKeepMaxChars: 30,
            minKeepCount: 2);

        Assert.True(plan.ShouldCompress);
        Assert.True(plan.KeepRaw.Count >= 2);
        Assert.True(plan.ToCompress.Count >= 1);
        Assert.Equal(100, plan.TotalCharsBefore);
    }

    [Fact]
    public void CreatePlan_ShouldRespectExcludePredicate()
    {
        var msgs = new List<Message>
        {
            new() { Id = "1", Content = "aaa", GroupSeq = 1 },
            new() { Id = "2", Content = "[[SYS:CONTEXT_COMPRESSED]] notice", GroupSeq = 2 },
            new() { Id = "3", Content = "bbb", GroupSeq = 3 },
        };

        var plan = GroupContextCompressionPlanner.CreatePlan(
            msgs,
            thresholdChars: 4,
            targetKeepMaxChars: 2,
            minKeepCount: 1,
            exclude: m => (m.Content ?? "").Contains("[[SYS:CONTEXT_COMPRESSED]]"));

        Assert.True(plan.ShouldCompress);
        Assert.DoesNotContain(plan.ToCompress, m => (m.Content ?? "").Contains("[[SYS:CONTEXT_COMPRESSED]]"));
        Assert.DoesNotContain(plan.KeepRaw, m => (m.Content ?? "").Contains("[[SYS:CONTEXT_COMPRESSED]]"));
        Assert.Equal(6, plan.TotalCharsBefore); // only aaa + bbb
    }
}

