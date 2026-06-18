using System.Text;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 知识库版本控制核心决策（<see cref="DocumentVersionLogic.Decide"/>）单元测试。
///
/// 这一层是版本快照的「算」（不碰 Mongo）：
///   - 与最新版本同 hash → 去重，不产生噪音版本（github 无变化同步 / 重复保存）
///   - 内容变化 → 版本号 +1
///   - 首个版本号从 1 起
///   - 字节数按 UTF-8 计（中文/emoji 多字节）
///   - 图片 markdown 外链原样进正文，版本只存文本 —— 从机制上杜绝「恢复版本删图片」。
/// </summary>
public class DocumentVersionLogicTests
{
    [Fact]
    public void FirstVersion_StartsAtOne_AndShouldCreate()
    {
        var d = DocumentVersionLogic.Decide(latestHash: null, latestNumber: 0, content: "hello");
        Assert.True(d.ShouldCreate);
        Assert.Equal(1, d.VersionNumber);
        Assert.Equal(5, d.CharCount);
        Assert.Equal(5, d.SizeBytes);
        Assert.False(string.IsNullOrEmpty(d.Hash));
    }

    [Fact]
    public void SameContentAsLatest_IsDeduped_NoNewVersion()
    {
        var first = DocumentVersionLogic.Decide(null, 0, "same content");
        // 用第一版的 hash/号模拟「再保存一次完全相同的内容」
        var second = DocumentVersionLogic.Decide(first.Hash, first.VersionNumber, "same content");
        Assert.False(second.ShouldCreate);
        Assert.Equal(first.VersionNumber, second.VersionNumber); // 版本号不前进
    }

    [Fact]
    public void ChangedContent_IncrementsVersionNumber()
    {
        var v1 = DocumentVersionLogic.Decide(null, 0, "v1");
        var v2 = DocumentVersionLogic.Decide(v1.Hash, v1.VersionNumber, "v2 changed");
        Assert.True(v2.ShouldCreate);
        Assert.Equal(2, v2.VersionNumber);
        Assert.NotEqual(v1.Hash, v2.Hash);
    }

    [Fact]
    public void SizeBytes_CountsUtf8_NotCharLength()
    {
        // 5 个中文字符：UTF-8 各占 3 字节 = 15 字节，但 CharCount = 5
        const string zh = "知识库版本";
        var d = DocumentVersionLogic.Decide(null, 0, zh);
        Assert.Equal(5, d.CharCount);
        Assert.Equal(Encoding.UTF8.GetByteCount(zh), d.SizeBytes);
        Assert.Equal(15, d.SizeBytes);
    }

    [Fact]
    public void NullContent_TreatedAsEmpty()
    {
        var d = DocumentVersionLogic.Decide(null, 0, null);
        Assert.True(d.ShouldCreate);
        Assert.Equal(0, d.CharCount);
        Assert.Equal(0, d.SizeBytes);
    }

    [Fact]
    public void ImageMarkdown_PreservedInSnapshot_TextOnly_NoAssetTouched()
    {
        // 插入图片 = 正文里多一行 ![](url) 外链；版本快照只是文本，恢复时原样写回，
        // 不涉及任何 image_asset 删除（区别于「文学创作版本删图片」的历史坑）。
        const string before = "段落一\n\n段落二";
        const string after = "段落一\n\n![配图](https://cos.example.com/a.png)\n\n段落二";
        var v1 = DocumentVersionLogic.Decide(null, 0, before);
        var v2 = DocumentVersionLogic.Decide(v1.Hash, v1.VersionNumber, after);
        Assert.True(v2.ShouldCreate);
        Assert.Equal(2, v2.VersionNumber);
        // 恢复 v1 = 把 before 文本写回，图片 URL 仍是有效外链，不被删除（纯文本恢复）
        var restore = DocumentVersionLogic.Decide(v2.Hash, v2.VersionNumber, before);
        Assert.True(restore.ShouldCreate);            // 恢复产生一条新版本（source=restore）
        Assert.Equal(v1.Hash, restore.Hash);          // 内容与 v1 等价
    }
}
