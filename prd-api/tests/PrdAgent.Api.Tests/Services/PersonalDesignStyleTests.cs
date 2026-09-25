using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 「我的风格」（2026-09-25）。守四件事：
/// 1. 归属隔离——别人的编号读不到、改不了、删不掉、也不能拿去生成（与不存在一样对待）；
/// 2. 每人上限 20 套，第 21 套被拒而不是悄悄写进去；
/// 3. 生成请求的风格三选一判据只在 FreezeForRun 一处：预设照旧、目录照旧、personal:&lt;id&gt; 走归属核对，
///    风格说明进了直连执行器读的 StyleDescription，也进了 OpenDesign 读的创作提示词；
/// 4. 提取是确定性的：读到什么写什么，读不到的维度整行不出现，页面没样式又没描述就明说。
/// </summary>
public sealed class PersonalDesignStyleTests
{
    private static readonly IDesignSystemCatalog Catalog = DesignSystemCatalog.LoadEmbedded();
    private const string Alice = "user-alice";
    private const string Bob = "user-bob";

    private static PersonalDesignStyleInput ValidInput(string name = "我的蓝调") => new()
    {
        Name = name,
        Instruction = "配色：底色 #f7f5f0，正文 #1f2328，强调色 #2f6feb。",
        Swatches = new List<string> { "#1f2328", "#f7f5f0", "#2f6feb" },
        Fonts = new List<string> { "Inter" },
        BaseDesignSystemId = "editorial",
        SystemFilledFields = new List<string> { "instruction", "swatches", "not-a-field" },
    };

    // ───────────────────────── 归属隔离 ─────────────────────────

    [Fact]
    public async Task 别人的风格编号读不到_改不了_删不掉_列表里也没有()
    {
        var store = new InMemoryStore();
        var service = new PersonalDesignStyleService(store, Catalog);
        var mine = await service.CreateAsync(Alice, ValidInput(), CancellationToken.None);

        Assert.NotNull(await service.GetOwnedAsync(Alice, mine.Id, CancellationToken.None));
        Assert.NotNull(await service.GetOwnedAsync(Alice, PersonalDesignStyle.StyleIdPrefix + mine.Id, CancellationToken.None));
        Assert.Null(await service.GetOwnedAsync(Bob, mine.Id, CancellationToken.None));
        Assert.Empty(await service.ListAsync(Bob, CancellationToken.None));

        var update = await Assert.ThrowsAsync<PersonalDesignStyleException>(() =>
            service.UpdateAsync(Bob, mine.Id, new PersonalDesignStyleInput { Name = "偷改" }, CancellationToken.None));
        Assert.Equal(ErrorCodes.NOT_FOUND, update.Code);
        var delete = await Assert.ThrowsAsync<PersonalDesignStyleException>(() =>
            service.DeleteAsync(Bob, mine.Id, CancellationToken.None));
        Assert.Equal(ErrorCodes.NOT_FOUND, delete.Code);

        var stored = await store.FindAsync(mine.Id, CancellationToken.None);
        Assert.Equal("我的蓝调", stored!.Name);
    }

    [Fact]
    public async Task 别人不能拿我的风格编号去生成_与不存在一样被拒()
    {
        var service = new PersonalDesignStyleService(new InMemoryStore(), Catalog);
        var mine = await service.CreateAsync(Alice, ValidInput(), CancellationToken.None);
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);

        var ex = await Assert.ThrowsAsync<DesignGenerationSettingsException>(() =>
            DesignGenerationSettingsService.FreezeForRun(
                settings, Catalog, service, Bob, PersonalDesignStyle.StyleIdPrefix + mine.Id, null, CancellationToken.None));
        Assert.Contains("不存在或已被删除", ex.Message);

        var missing = await Assert.ThrowsAsync<DesignGenerationSettingsException>(() =>
            DesignGenerationSettingsService.FreezeForRun(
                settings, Catalog, service, Alice, PersonalDesignStyle.StyleIdPrefix + new string('0', 32), null, CancellationToken.None));
        Assert.Equal(ex.Message, missing.Message);
    }

    [Fact]
    public async Task 修改只动提交的字段_被改过的字段不再标为系统填写()
    {
        var service = new PersonalDesignStyleService(new InMemoryStore(), Catalog);
        var mine = await service.CreateAsync(Alice, ValidInput(), CancellationToken.None);
        Assert.Equal(new[] { "instruction", "swatches" }, mine.SystemFilledFields);

        var renamed = await service.UpdateAsync(Alice, mine.Id, new PersonalDesignStyleInput { Instruction = "只用黑白两色" }, CancellationToken.None);

        Assert.Equal("我的蓝调", renamed.Name);
        Assert.Equal("只用黑白两色", renamed.Instruction);
        Assert.Equal(new[] { "swatches" }, renamed.SystemFilledFields);
    }

    // ───────────────────────── 上限与校验 ─────────────────────────

    [Fact]
    public async Task 每人最多二十套_第二十一套被拒_别人不受影响()
    {
        var store = new InMemoryStore();
        var service = new PersonalDesignStyleService(store, Catalog);
        for (var i = 0; i < PersonalDesignStyle.MaxPerUser; i++)
            await service.CreateAsync(Alice, ValidInput($"风格{i}"), CancellationToken.None);

        var ex = await Assert.ThrowsAsync<PersonalDesignStyleException>(() =>
            service.CreateAsync(Alice, ValidInput("第二十一套"), CancellationToken.None));
        Assert.Equal(ErrorCodes.QUOTA_EXCEEDED, ex.Code);
        Assert.Equal(PersonalDesignStyle.MaxPerUser, await store.CountByOwnerAsync(Alice, CancellationToken.None));

        await service.CreateAsync(Bob, ValidInput("第二十一套"), CancellationToken.None);
    }

    [Fact]
    public async Task 写坏的输入被拒而不是落默认值()
    {
        var service = new PersonalDesignStyleService(new InMemoryStore(), Catalog);

        async Task<string> CodeOf(PersonalDesignStyleInput input)
            => (await Assert.ThrowsAsync<PersonalDesignStyleException>(() => service.CreateAsync(Alice, input, CancellationToken.None))).Code;

        var noName = ValidInput(); noName.Name = " ";
        var badSwatch = ValidInput(); badSwatch.Swatches = new List<string> { "#fff", "#000" };
        var unknownBase = ValidInput(); unknownBase.BaseDesignSystemId = "no-such-system";
        var emptyInstruction = ValidInput(); emptyInstruction.Instruction = "";
        var quote = ValidInput(); quote.Name = "a\"b";

        Assert.Equal(ErrorCodes.INVALID_FORMAT, await CodeOf(noName));
        Assert.Equal(ErrorCodes.INVALID_FORMAT, await CodeOf(badSwatch));
        Assert.Equal(ErrorCodes.INVALID_FORMAT, await CodeOf(unknownBase));
        Assert.Equal(ErrorCodes.INVALID_FORMAT, await CodeOf(emptyInstruction));
        Assert.Equal(ErrorCodes.INVALID_FORMAT, await CodeOf(quote));

        await service.CreateAsync(Alice, ValidInput("同名"), CancellationToken.None);
        Assert.Equal(ErrorCodes.DUPLICATE, await CodeOf(ValidInput("同名")));
    }

    // ───────────────────────── 生成请求的风格解析 ─────────────────────────

    [Fact]
    public async Task 预设与目录风格的解析不受影响_同时提交两种被拒()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);
        var service = new PersonalDesignStyleService(new InMemoryStore(), Catalog);

        var byDefault = await DesignGenerationSettingsService.FreezeForRun(settings, Catalog, service, Alice, null, null, CancellationToken.None);
        Assert.Equal(DesignGenerationSettingsService.Freeze(settings, null).PromptFingerprint, byDefault.PromptFingerprint);
        Assert.Equal("editorial", byDefault.StyleId);

        var preset = await DesignGenerationSettingsService.FreezeForRun(settings, Catalog, service, Alice, "minimal", null, CancellationToken.None);
        Assert.Equal("minimal", preset.StyleId);
        Assert.Equal(DesignGenerationDefaults.GeneratePrompt, preset.GeneratePrompt);

        var catalogStyle = await DesignGenerationSettingsService.FreezeForRun(settings, Catalog, service, Alice, null, "bento", CancellationToken.None);
        Assert.Equal(DesignGenerationSettingsService.CatalogStylePrefix + "bento", catalogStyle.StyleId);

        await Assert.ThrowsAsync<DesignGenerationSettingsException>(() =>
            DesignGenerationSettingsService.FreezeForRun(settings, Catalog, service, Alice, "minimal", "bento", CancellationToken.None));
    }

    [Fact]
    public async Task 我的风格冻结进运行_名称可追溯_说明同时进入两个执行器会读的位置()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);
        var service = new PersonalDesignStyleService(new InMemoryStore(), Catalog);
        var mine = await service.CreateAsync(Alice, ValidInput(), CancellationToken.None);

        var direction = await DesignGenerationSettingsService.FreezeForRun(
            settings, Catalog, service, Alice, PersonalDesignStyle.StyleIdPrefix + mine.Id, null, CancellationToken.None);

        Assert.Equal(PersonalDesignStyle.StyleIdPrefix + mine.Id, direction.StyleId);
        Assert.Equal("我的蓝调", direction.StyleName);
        Assert.Equal("editorial", direction.DesignSystemId);
        Assert.StartsWith(mine.Instruction, direction.StyleDescription);
        Assert.StartsWith(DesignGenerationDefaults.GeneratePrompt.TrimEnd(), direction.GeneratePrompt);
        Assert.Contains(mine.Instruction, direction.GeneratePrompt);
        Assert.Contains("我的蓝调", direction.GeneratePrompt);
        Assert.Equal(DesignGenerationDefaults.EditPrompt, direction.EditPrompt);
        Assert.Equal(12, direction.PromptFingerprint.Length);
        // CDS 解析任务书时 styleId 上限 48、designSystemId 必须是快照里的编号：这两条不成立整次运行会被拒收。
        Assert.True(direction.StyleId.Length <= 48);
        Assert.Equal(direction.PromptFingerprint, DesignGenerationSettingsService.Fingerprint(direction));

        var otherPreset = DesignGenerationSettingsService.Freeze(settings, "editorial");
        Assert.NotEqual(otherPreset.PromptFingerprint, direction.PromptFingerprint);
    }

    [Fact]
    public async Task 改过的配色与字体进生成_两个执行器都拿到改后的值()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);
        var service = new PersonalDesignStyleService(new InMemoryStore(), Catalog);
        var mine = await service.CreateAsync(Alice, ValidInput(), CancellationToken.None);
        // 只改色块和字体，不动风格说明：生成必须用改后的值，而不是说明里原来那组颜色。
        await service.UpdateAsync(Alice, mine.Id, new PersonalDesignStyleInput
        {
            Swatches = new List<string> { "#111111", "#fafafa", "#d9480f" },
            Fonts = new List<string> { "Noto Serif SC", "Inter" },
        }, CancellationToken.None);

        var direction = await DesignGenerationSettingsService.FreezeForRun(
            settings, Catalog, service, Alice, PersonalDesignStyle.StyleIdPrefix + mine.Id, null, CancellationToken.None);

        foreach (var text in new[] { direction.StyleDescription, direction.GeneratePrompt })
        {
            Assert.Contains("#111111", text);
            Assert.Contains("#fafafa", text);
            Assert.Contains("#d9480f", text);
            Assert.Contains("标题 Noto Serif SC，正文 Inter", text);
        }
    }

    [Fact]
    public void 没有色块与字体的风格_说明原样交出_不编一组()
    {
        var style = new PersonalDesignStyle { Name = "只写描述", Instruction = "  克制、留白多  " };
        Assert.Equal("克制、留白多", DesignGenerationSettingsService.PersonalStyleSpec(style));
    }

    [Fact]
    public void 骨架下线了就明说_不悄悄换成默认骨架()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);
        var style = new PersonalDesignStyle
        {
            OwnerUserId = Alice,
            Name = "旧风格",
            Instruction = "只用黑白",
            BaseDesignSystemId = "retired-system",
        };

        var ex = Assert.Throws<DesignGenerationSettingsException>(() =>
            DesignGenerationSettingsService.FreezePersonalStyle(settings, Catalog, style));
        Assert.Contains("retired-system", ex.Message);
    }

    // ───────────────────────── 确定性提取 ─────────────────────────

    private const string SampleHtml = """
<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600&amp;family=Inter:wght@400">
<link rel="stylesheet" href="./css/site.css">
<link rel="stylesheet" href="https://cdn.example.com/x.css">
<style>
:root { --bg: #f7f5f0; --ink: #1f2328; --accent: #c2410c; }
body { background: var(--bg); color: var(--ink); font-family: "Inter", sans-serif; font-size: 16px; }
h1 { font-family: "Noto Serif SC", serif; font-size: clamp(32px, 5vw, 48px); }
h2 { font-size: 28px; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
.card { border-radius: 12px; padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,.08); border: 1px solid #e5e7eb; }
.card2 { border-radius: 12px; padding: 16px; box-shadow: 0 4px 8px rgba(0,0,0,.1); }
.card3 { border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
a { color: var(--accent); }
section { margin: 64px 0; }
section.b { margin: 64px 0; }
</style></head><body><div class="wrap" style="color: #1f2328">x</div></body></html>
""";

    [Fact]
    public void 从页内样式读出配色字体字号间距与版式_色块顺序是正文底色强调色()
    {
        var result = PersonalStyleDeriver.Derive(SampleHtml, null, null);

        Assert.True(result.FoundAnything);
        Assert.Equal(new[] { "#1f2328", "#f7f5f0", "#c2410c" }, result.Swatches);
        Assert.Contains("底色 #f7f5f0（浅色页面）", result.Instruction);
        Assert.Contains("强调色 #c2410c", result.Instruction);
        Assert.Contains("标题用「Noto Serif SC」，正文用「Inter」", result.Instruction);
        Assert.Contains("标题约 48px / 28px", result.Instruction);
        Assert.Contains("正文约 16px", result.Instruction);
        Assert.Contains("圆角约 12px", result.Instruction);
        Assert.Contains("卡片带投影", result.Instruction);
        Assert.Contains("内容区最大宽度约 1120px 居中", result.Instruction);
        Assert.Contains("常见 3 列", result.Instruction);
        Assert.Equal(new[] { "Noto Serif SC", "Inter" }, result.Fonts);
        Assert.Contains(result.Traits, trait => trait.Key == "palette");
        Assert.Contains("1 段页内样式", result.Evidence);

        // 同样的输入永远得到同样的输出。
        Assert.Equal(result.Instruction, PersonalStyleDeriver.Derive(SampleHtml, null, null).Instruction);
    }

    [Fact]
    public void 根上重复定义的变量按层叠取后写的那条_其它选择器不覆盖根上的值()
    {
        const string css = ":root{--bg:#ffffff;--accent:#111111}"
            + ":root{--bg:#f3ecdf;--accent:#b95337}"
            + "[data-theme=dark]{--bg:#000000}"
            + "body{background:var(--bg)} .btn{background:var(--accent)}";
        var result = PersonalStyleDeriver.Derive("<html><head></head><body>x</body></html>", new[] { css }, null);

        Assert.Contains("底色 #f3ecdf", result.Instruction);
        Assert.Contains("强调色 #b95337", result.Instruction);
    }

    [Fact]
    public void 站内样式文件与页内样式一起读_读不到的维度整行不出现()
    {
        const string html = "<html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body>纯文字</body></html>";
        var result = PersonalStyleDeriver.Derive(html, new[] { "body{background:#101418;color:#e6e6e6} .btn{background:#22c55e}" }, null);

        Assert.Contains("底色 #101418（深色页面）", result.Instruction);
        Assert.Contains("强调色 #22c55e", result.Instruction);
        Assert.DoesNotContain("字体", result.Instruction);
        Assert.DoesNotContain("版式", result.Instruction);
        Assert.Contains("1 个站内样式文件", result.Evidence);
    }

    [Fact]
    public void 页面没有样式又没有描述时明说读不到_只有描述时原样作为说明()
    {
        var empty = PersonalStyleDeriver.Derive("<html><body><img src=\"a.png\"></body></html>", null, null);
        Assert.False(empty.FoundAnything);
        Assert.Equal(string.Empty, empty.Instruction);

        var noteOnly = PersonalStyleDeriver.Derive(null, null, "  深色科技感，荧光绿点缀  ");
        Assert.True(noteOnly.FoundAnything);
        Assert.Equal("深色科技感，荧光绿点缀", noteOnly.Instruction);
        Assert.Empty(noteOnly.Swatches);

        var both = PersonalStyleDeriver.Derive(SampleHtml, null, "按钮更圆一点");
        Assert.EndsWith("另外：按钮更圆一点", both.Instruction);
    }

    [Fact]
    public void 站内样式表按入口文件目录解析_外链与数据地址不算()
    {
        var paths = PersonalStyleDeriver.LocalStylesheetPaths(SampleHtml, "pages/index.html");
        Assert.Equal(new[] { "pages/css/site.css" }, paths);

        var rooted = PersonalStyleDeriver.LocalStylesheetPaths("<link href='/a/b.css?v=1' rel='stylesheet'><link rel=stylesheet href=../x.css>", "index.html");
        Assert.Equal(new[] { "a/b.css" }, rooted);
    }

    [Fact]
    public void 骨架先按配色就近_再按描述匹配预设_都没有才用默认并说明依据()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);
        var reference = Catalog.All.First(entry =>
            PersonalStyleDeriver.TryParseColor(entry.Swatches.Bg, out _, out _)
            && PersonalStyleDeriver.TryParseColor(entry.Swatches.Fg, out _, out _)
            && PersonalStyleDeriver.TryParseColor(entry.Swatches.Accent, out _, out _));
        var swatches = new[] { reference.Swatches.Fg, reference.Swatches.Bg, reference.Swatches.Accent };

        var byPalette = PersonalStyleDeriver.ChooseBaseDesignSystem(Catalog, swatches, null, settings.Styles, "editorial");
        Assert.Equal(reference.Id, byPalette.DesignSystemId);
        Assert.Contains("按配色就近选", byPalette.Reason);

        var byNote = PersonalStyleDeriver.ChooseBaseDesignSystem(Catalog, Array.Empty<string>(), "想要极简一点，黑白灰", settings.Styles, "editorial");
        Assert.Equal("minimal", byNote.DesignSystemId);
        Assert.Contains("极简", byNote.Reason);

        var fallback = PersonalStyleDeriver.ChooseBaseDesignSystem(Catalog, Array.Empty<string>(), null, settings.Styles, "editorial");
        Assert.Equal("editorial", fallback.DesignSystemId);
        Assert.Contains("默认", fallback.Reason);
    }

    private sealed class InMemoryStore : IPersonalDesignStyleStore
    {
        private readonly List<PersonalDesignStyle> _items = new();

        public Task<List<PersonalDesignStyle>> ListByOwnerAsync(string ownerUserId, CancellationToken ct)
            => Task.FromResult(_items.Where(s => s.OwnerUserId == ownerUserId).OrderByDescending(s => s.UpdatedAt).ToList());

        public Task<long> CountByOwnerAsync(string ownerUserId, CancellationToken ct)
            => Task.FromResult((long)_items.Count(s => s.OwnerUserId == ownerUserId));

        public Task<PersonalDesignStyle?> FindAsync(string id, CancellationToken ct)
            => Task.FromResult(_items.FirstOrDefault(s => s.Id == id));

        public Task InsertAsync(PersonalDesignStyle style, CancellationToken ct)
        {
            _items.Add(style);
            return Task.CompletedTask;
        }

        public Task<bool> ReplaceAsync(PersonalDesignStyle style, CancellationToken ct)
        {
            var index = _items.FindIndex(s => s.Id == style.Id && s.OwnerUserId == style.OwnerUserId);
            if (index < 0) return Task.FromResult(false);
            _items[index] = style;
            return Task.FromResult(true);
        }

        public Task<bool> DeleteAsync(string id, string ownerUserId, CancellationToken ct)
            => Task.FromResult(_items.RemoveAll(s => s.Id == id && s.OwnerUserId == ownerUserId) > 0);
    }
}
