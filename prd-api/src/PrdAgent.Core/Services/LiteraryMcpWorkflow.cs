using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>开放接口与网页共用配图标记格式；规划不调用模型，生成仍交给 ImageGenRunWorker。</summary>
public static class LiteraryMcpWorkflow
{
    /// <summary>单篇配图标记上限。原来是 4：长文配不全，智能体只能把一篇拆成几个工作区，列表因此变乱。</summary>
    public const int MaxMarkers = 20;
    /// <summary>单个配图标记的画面描述上限。标记校验、改单张描述、生图、以及图上记下的原始描述都按它，不另设更短的截断。</summary>
    public const int MaxPromptChars = 4000;

    /// <summary>
    /// 图上记下的原始描述。放回旧图时会原样写回标记，所以上限必须与标记一致：
    /// 以前截到 200 字，放回一张长描述的图，标记描述就被悄悄改短，之后重画与改稿沿用都按短的那段走。
    /// </summary>
    public static string? ClampOriginalMarkerText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.Trim();
        return t.Length > MaxPromptChars ? t[..MaxPromptChars].Trim() : t;
    }

    /// <summary>
    /// 行首的标记变体：`[插图]:` 之外，智能体写中文时常写成全角冒号 `[插图]：`、全角括号 `【插图】：`。
    /// 标记提取器（前后端各一份、必须逐字一致）只认 `[插图]:`，所以变体在**入口**统一改写成标准形，
    /// 不去动提取器本身——那会让网页那份提取器的索引与后端错开。
    /// </summary>
    private static readonly Regex LineMarkerVariant = new(
        // 只许吃行内空白（[ \t]），不许 \s：\s 会跨过换行，把「[插图]：」下一行的正文并成画面描述。
        @"^(?<indent>[ \t]*)[\[【][ \t]*插图[ \t]*[\]】][ \t]*[:：][ \t]*(?<desc>[^\n]*)$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    /// <summary>把换行统一成 \n、把行首标记变体改写成标准的 `[插图]: 描述`。</summary>
    public static string NormalizeMarkedContent(string markedContent)
    {
        var text = markedContent.Replace("\r\n", "\n").Replace('\r', '\n');
        return LineMarkerVariant.Replace(text, m => $"{m.Groups["indent"].Value}[插图]: {m.Groups["desc"].Value.Trim()}");
    }

    /// <summary>正文里是否带着（任一变体的）配图标记。用来拦下「把标记当正文写进去」这种静默错误。</summary>
    public static bool ContainsMarkers(string? content)
        => !string.IsNullOrEmpty(content)
           && (LineMarkerVariant.IsMatch(content) || ArticleMarkerExtractor.Extract(content).Count > 0);

    /// <summary>
    /// 校验带标记正文。调用方必须先 <see cref="NormalizeMarkedContent"/>。
    /// </summary>
    public static string? Validate(string? content, string? markedContent, string? folderName)
    {
        if (folderName?.Trim().Length > 80) return "文件夹名称不能超过 80 字。";
        if (markedContent == null)
        {
            if (ContainsMarkers(content))
                return "正文里带有 [插图]: 标记。需要配图请把整篇放进 markedContent（与 content 互斥）；只写正文请去掉这些标记。";
            return null;
        }
        if (!string.IsNullOrEmpty(content)) return "content 与 markedContent 只能传一个，避免正文与配图位置不一致。";
        if (markedContent.Length > 200_000) return "带标记正文不能超过 200000 字。";

        // 空描述必须在提取前拦住：提取正则的 \s* 会跨过换行，把下一段正文当成画面描述，
        // 而去标记时那一段正文也会被一起删掉——静默丢稿。
        var lines = markedContent.Split('\n');
        var seen = 0;
        for (var i = 0; i < lines.Length; i++)
        {
            var trimmed = lines[i].TrimStart();
            if (!trimmed.StartsWith("[插图]:", StringComparison.Ordinal)) continue;
            seen++;
            if (trimmed["[插图]:".Length..].Trim().Length == 0)
                return $"第 {seen} 个配图标记（第 {i + 1} 行）没有画面描述。格式是独立一行：[插图]: 画面描述。";
        }

        var markers = ArticleMarkerExtractor.Extract(markedContent);
        if (markers.Count < 1 || markers.Count > MaxMarkers)
            return $"请在正文独立行使用 [插图]: 画面描述，单篇支持 1-{MaxMarkers} 个配图标记（当前 {markers.Count} 个）。";
        if (markers.Any(m => m.Text.Trim().Length > MaxPromptChars)) return $"每张配图的画面描述不能超过 {MaxPromptChars} 字。";
        if (string.IsNullOrWhiteSpace(PlainContent(markedContent))) return "请同时提供文章正文，不能只有配图标记。";
        return null;
    }

    public static string PlainContent(string markedContent)
    {
        var result = markedContent;
        foreach (var marker in ArticleMarkerExtractor.Extract(markedContent).AsEnumerable().Reverse())
            result = result.Remove(marker.StartPos, marker.EndPos - marker.StartPos);
        return result;
    }

    public static ArticleIllustrationWorkflow Prepare(string markedContent, int version = 1) => new()
    {
        Version = version,
        Phase = 2,
        ExpectedImageCount = ArticleMarkerExtractor.Extract(markedContent).Count,
        Markers = ArticleMarkerExtractor.Extract(markedContent).Select(m => new ArticleIllustrationMarker
        {
            Index = m.Index, Text = m.Text.Trim(), Status = "idle",
            PlanItem = new ArticleIllustrationPlanItem { Prompt = m.Text.Trim(), Count = 1, Size = "1024x1024" },
        }).ToList(),
    };

    /// <summary>仅按同工作区、当前版本及明确索引补缺口；不覆盖权威指针、不结束仍在运行的新任务。</summary>
    public static bool RecoverVersionedAssets(ImageMasterWorkspace workspace, IEnumerable<ImageAsset> assets)
    {
        var workflow = workspace.ArticleWorkflow;
        if (workspace.ScenarioType != "article-illustration" || workflow?.Markers == null) return false;
        workflow.AssetIdByMarkerIndex ??= new Dictionary<string, string>();
        var changed = false;
        foreach (var asset in assets.Where(a => a.WorkspaceId == workspace.Id
                     && a.ArticleWorkflowVersion == workflow.Version && a.ArticleInsertionIndex.HasValue
                     && !string.IsNullOrWhiteSpace(a.Url)).OrderByDescending(a => a.CreatedAt))
        {
            var index = asset.ArticleInsertionIndex!.Value;
            var marker = workflow.Markers.FirstOrDefault(m => m.Index == index);
            var key = index.ToString();
            if (marker == null || (workflow.AssetIdByMarkerIndex.TryGetValue(key, out var existing)
                                  && !string.IsNullOrWhiteSpace(existing))) continue;
            workflow.AssetIdByMarkerIndex[key] = asset.Id;
            marker.AssetId = asset.Id;
            marker.Url = asset.Url;
            if (marker.Status != "running")
            {
                marker.Status = "done";
                marker.ErrorMessage = null;
            }
            changed = true;
        }
        if (changed)
            workflow.DoneImageCount = workflow.AssetIdByMarkerIndex.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count();
        return changed;
    }

    /// <summary>
    /// 「这篇文章当前每个标记挂的是哪张图」的唯一判定源。
    ///
    /// 网页不再在改稿 / 重新规划时硬删旧配图（用户要看历史），于是同一个工作区里会同时躺着
    /// 当前版本与历史版本的图。投稿、导出、详情此前各自「按 index 取最新一张」，
    /// 旧版本的图会顶掉当前版本——判据必须收敛到这里，按版本认。
    ///
    /// 顺序：权威指针（AssetIdByMarkerIndex）→ 同版本且带 index 的最新一张 →
    /// 未盖版本号的存量图（改造前的历史数据），按位置逐个兜底。
    /// 换稿时会先给未盖版本的图盖上旧版本号，所以还没盖的只可能属于当前这一版；
    /// 以前是「工作区里出现任何一张带版本的图就整体不再兜底」，改造后重画一张，其余旧图就从正文、导出、投稿里一起消失。
    /// </summary>
    public static Dictionary<int, ImageAsset> SelectCurrent(ImageMasterWorkspace workspace, IEnumerable<ImageAsset> assets)
    {
        var workflow = workspace.ArticleWorkflow;
        // 指针是权威记录：按 id 在工作区全部图里找，不要求图自己记着插入位置——
        // 没记位置的早期图被放回某个标记后，指针指着它，先按插入位置筛掉就会让它从详情、导出、投稿里消失。
        var all = assets.Where(a => a.WorkspaceId == workspace.Id).ToList();
        var list = all.Where(a => a.ArticleInsertionIndex.HasValue).ToList();
        var result = new Dictionary<int, ImageAsset>();
        var markerIndexes = workflow?.Markers?.Select(m => m.Index).ToHashSet();
        bool InScope(int index) => markerIndexes == null || markerIndexes.Count == 0 || markerIndexes.Contains(index);

        foreach (var (key, id) in workflow?.AssetIdByMarkerIndex ?? new Dictionary<string, string>())
        {
            if (!int.TryParse(key, out var index) || !InScope(index)) continue;
            var asset = all.FirstOrDefault(a => a.Id == id);
            if (asset != null) result[index] = asset;
        }

        var version = workflow?.Version;
        foreach (var group in list.Where(a => a.ArticleWorkflowVersion.HasValue && a.ArticleWorkflowVersion == version)
                     .GroupBy(a => a.ArticleInsertionIndex!.Value))
        {
            if (!result.ContainsKey(group.Key) && InScope(group.Key))
                result[group.Key] = group.OrderByDescending(a => a.CreatedAt).First();
        }

        foreach (var group in list.Where(a => !a.ArticleWorkflowVersion.HasValue).GroupBy(a => a.ArticleInsertionIndex!.Value))
        {
            if (!result.ContainsKey(group.Key) && InScope(group.Key))
                result[group.Key] = group.OrderByDescending(a => a.CreatedAt).First();
        }
        return result;
    }

    /// <summary>
    /// 改稿时把「画面描述没变」的标记原样接上它现在那张图，只让新增 / 改过描述的标记等待生成。
    ///
    /// 以前改一节正文，整篇配图方案作废、6 张图全部要重画：用户满意的图、刚修好的那张一起被换掉，
    /// 既费钱又出乎意料。判据只认描述文本（去首尾空白、压缩连续空白后逐字相等），旧图一侧取
    /// <see cref="MountedImagePrompt"/>——网页改过并重画的以改后描述为准，只改了描述、还没重画的图不算「描述没变」；
    /// 同一段描述出现多次时按出现顺序一一对应，一张旧图只接一次。
    /// 返回接上的标记序号；<paramref name="next"/> 被就地改写。
    /// </summary>
    public static List<int> CarryOverUnchanged(ArticleIllustrationWorkflow next, ImageMasterWorkspace previous,
        IEnumerable<ImageAsset> assets, DateTime now)
    {
        var carried = new List<int>();
        var assetList = assets as IReadOnlyCollection<ImageAsset> ?? assets.ToList();
        var current = SelectCurrent(previous, assetList);
        var pool = (previous.ArticleWorkflow?.Markers ?? new List<ArticleIllustrationMarker>())
            .Where(m => current.ContainsKey(m.Index))
            .Select(m => (key: Normalize(MountedImagePrompt(current[m.Index], m)), asset: current[m.Index], runId: m.RunId))
            .Where(p => p.key.Length > 0)
            .ToList();
        if (pool.Count == 0)
        {
            // 当前一张都没挂（典型：网页刚换过正文，标记全作废）——拿最近一次存档里「换稿前在用的那组」来接。
            // 以前这时带标记写回一张都接不上，智能体只能逐张去历史里放回。
            // 连着两次换纯正文时，最近那份存档本身就是空的（那一版没有标记），要往前找最近一份真能接上的。
            var byId = assetList.Where(a => a.WorkspaceId == previous.Id).ToDictionary(a => a.Id);
            foreach (var archived in (previous.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>()).Where(w => w.ArchivedAt != null))
            {
                pool = archived.Markers
                    .Select(m => (m, id: archived.AssetIdByMarkerIndex.TryGetValue(m.Index.ToString(), out var v) ? v : null))
                    .Where(x => x.id != null && byId.ContainsKey(x.id))
                    .Select(x => (key: Normalize(MountedImagePrompt(byId[x.id!], x.m)), asset: byId[x.id!], runId: x.m.RunId))
                    .Where(p => p.key.Length > 0)
                    .ToList();
                if (pool.Count > 0) break;
            }
        }
        if (pool.Count == 0) return carried;
        next.AssetIdByMarkerIndex ??= new Dictionary<string, string>();
        next.AssetRunAtByMarkerIndex ??= new Dictionary<string, DateTime>();
        foreach (var marker in next.Markers.OrderBy(m => m.Index))
        {
            var key = Normalize(marker.Text);
            var hit = pool.FindIndex(p => p.key == key);
            if (hit < 0) continue;
            var (_, asset, runId) = pool[hit];
            pool.RemoveAt(hit);
            var k = marker.Index.ToString();
            next.AssetIdByMarkerIndex[k] = asset.Id;
            next.AssetRunAtByMarkerIndex[k] = now;
            marker.AssetId = asset.Id;
            marker.Url = asset.Url;
            marker.RunId = runId; // 沿用的图保留它当初那次生成的记录，否则读稿看不出这张图从哪来
            if (!next.AdoptedAssetIds.Contains(asset.Id)) next.AdoptedAssetIds.Add(asset.Id);
            marker.Status = "done";
            marker.ErrorMessage = null;
            carried.Add(marker.Index);
        }
        next.DoneImageCount = next.AssetIdByMarkerIndex.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count();
        return carried;
    }

    /// <summary>
    /// 沿用时一张挂着的图按哪段描述算：默认是标记当前生效的描述（历史接口给出的上一组描述也是它，
    /// 照着写回一定接得上）。只有标记描述被改过、而图上记着的生成时描述与改后的对不上——即改了描述还没重画——
    /// 才按图上记的算，这张旧图不能冒充新描述的图。早期图上记的描述可能带风格前缀，判错时只会多重画一张，不会错配。
    /// </summary>
    public static string MountedImagePrompt(ImageAsset asset, ArticleIllustrationMarker marker)
    {
        var effective = EffectivePrompt(marker);
        if (string.IsNullOrWhiteSpace(marker.DraftText) || string.IsNullOrWhiteSpace(asset.OriginalMarkerText)) return effective;
        return Normalize(asset.OriginalMarkerText) == Normalize(effective) ? effective : asset.OriginalMarkerText;
    }

    /// <summary>
    /// 标记「当前生效的画面描述」：网页上改过（DraftText）就以改后的为准，否则是原始描述。
    ///
    /// 网页改描述只写 DraftText，原始 Text 不动。以前 MCP 读稿与回执只给 Text，智能体拿到过期描述，
    /// 整篇重写时把网页的修改冲掉，又凭旧描述把按新描述画的图接了回去——图和描述对不上。
    /// 凡是对外说「这个标记的描述是什么」、以及「描述变没变」的判断，一律走这里。
    /// </summary>
    public static string EffectivePrompt(ArticleIllustrationMarker marker)
        => string.IsNullOrWhiteSpace(marker.DraftText) ? marker.Text : marker.DraftText.Trim();

    private static string Normalize(string? text)
        => string.Join(' ', (text ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>
    /// 带标记的整篇正文，每个标记行写的是它<b>当前生效</b>的描述（网页改过的以改后为准）。
    ///
    /// 智能体改稿要整篇带标记写回；以前读稿只给去掉标记的正文，它得靠空行猜每个标记原来在哪，
    /// 而标记里存的又是最初的描述——照着写回就把网页上的修改冲掉了。拿这份原样改、原样写回即可。
    /// </summary>
    public static string RenderMarked(string markedContent, IReadOnlyDictionary<int, string> prompts)
    {
        var result = markedContent;
        foreach (var marker in ArticleMarkerExtractor.Extract(markedContent).AsEnumerable().Reverse())
        {
            if (!prompts.TryGetValue(marker.Index, out var prompt) || string.IsNullOrWhiteSpace(prompt)) continue;
            // 描述要占一整行：网页编辑框里敲的换行压成空格，否则下一行会被当成正文
            var oneLine = string.Join(' ', prompt.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            result = result.Remove(marker.StartPos, marker.EndPos - marker.StartPos)
                .Insert(marker.StartPos, $"[插图]: {oneLine}");
        }
        return result;
    }

    /// <summary>按标记索引替换而非按成功张数顺移：第二张先完成也不能占第一张的位置。</summary>
    public static string Render(string markedContent, IReadOnlyDictionary<int, string> urls, bool allowRelative = false)
    {
        var result = markedContent;
        foreach (var marker in ArticleMarkerExtractor.Extract(markedContent).AsEnumerable().Reverse())
        {
            if (!urls.TryGetValue(marker.Index, out var url) || string.IsNullOrWhiteSpace(url)) continue;
            string target;
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == "https" || uri.Scheme == "http"))
                target = uri.AbsoluteUri;
            else if (allowRelative && url.StartsWith('/'))
                target = url;
            else continue;
            result = result.Remove(marker.StartPos, marker.EndPos - marker.StartPos)
                .Insert(marker.StartPos, $"![配图 {marker.Index + 1}](<{target}>)");
        }
        return result;
    }
}
