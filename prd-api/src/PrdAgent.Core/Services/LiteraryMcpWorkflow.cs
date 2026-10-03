using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>开放接口与网页共用配图标记格式；规划不调用模型，生成仍交给 ImageGenRunWorker。</summary>
public static class LiteraryMcpWorkflow
{
    /// <summary>单篇配图标记上限。原来是 4：长文配不全，智能体只能把一篇拆成几个工作区，列表因此变乱。</summary>
    public const int MaxMarkers = 20;

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
        if (markers.Any(m => m.Text.Trim().Length > 4000)) return "每张配图的画面描述不能超过 4000 字。";
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
    /// 未盖版本号的存量图（改造前的历史数据，只在还没有任何版本化资产时才认）。
    /// </summary>
    public static Dictionary<int, ImageAsset> SelectCurrent(ImageMasterWorkspace workspace, IEnumerable<ImageAsset> assets)
    {
        var workflow = workspace.ArticleWorkflow;
        var list = assets.Where(a => a.WorkspaceId == workspace.Id && a.ArticleInsertionIndex.HasValue).ToList();
        var result = new Dictionary<int, ImageAsset>();
        var markerIndexes = workflow?.Markers?.Select(m => m.Index).ToHashSet();
        bool InScope(int index) => markerIndexes == null || markerIndexes.Count == 0 || markerIndexes.Contains(index);

        foreach (var (key, id) in workflow?.AssetIdByMarkerIndex ?? new Dictionary<string, string>())
        {
            if (!int.TryParse(key, out var index) || !InScope(index)) continue;
            var asset = list.FirstOrDefault(a => a.Id == id);
            if (asset != null) result[index] = asset;
        }

        var version = workflow?.Version;
        foreach (var group in list.Where(a => a.ArticleWorkflowVersion.HasValue && a.ArticleWorkflowVersion == version)
                     .GroupBy(a => a.ArticleInsertionIndex!.Value))
        {
            if (!result.ContainsKey(group.Key) && InScope(group.Key))
                result[group.Key] = group.OrderByDescending(a => a.CreatedAt).First();
        }

        if (!list.Any(a => a.ArticleWorkflowVersion.HasValue))
        {
            foreach (var group in list.GroupBy(a => a.ArticleInsertionIndex!.Value))
            {
                if (!result.ContainsKey(group.Key) && InScope(group.Key))
                    result[group.Key] = group.OrderByDescending(a => a.CreatedAt).First();
            }
        }
        return result;
    }

    /// <summary>
    /// 改稿时把「画面描述没变」的标记原样接上它现在那张图，只让新增 / 改过描述的标记等待生成。
    ///
    /// 以前改一节正文，整篇配图方案作废、6 张图全部要重画：用户满意的图、刚修好的那张一起被换掉，
    /// 既费钱又出乎意料。判据只认描述文本（去首尾空白、压缩连续空白后逐字相等），旧标记一侧取
    /// <see cref="EffectivePrompt"/>——网页改过的描述才是那张图对应的描述，原始描述不再算数；
    /// 同一段描述出现多次时按出现顺序一一对应，一张旧图只接一次。
    /// 返回接上的标记序号；<paramref name="next"/> 被就地改写。
    /// </summary>
    public static List<int> CarryOverUnchanged(ArticleIllustrationWorkflow next, ImageMasterWorkspace previous,
        IEnumerable<ImageAsset> assets, DateTime now)
    {
        var carried = new List<int>();
        var oldMarkers = previous.ArticleWorkflow?.Markers;
        if (oldMarkers == null || oldMarkers.Count == 0) return carried;
        var current = SelectCurrent(previous, assets);
        var pool = oldMarkers
            .Where(m => current.ContainsKey(m.Index))
            .Select(m => (key: Normalize(EffectivePrompt(m)), asset: current[m.Index]))
            .Where(p => p.key.Length > 0)
            .ToList();
        next.AssetIdByMarkerIndex ??= new Dictionary<string, string>();
        next.AssetRunAtByMarkerIndex ??= new Dictionary<string, DateTime>();
        foreach (var marker in next.Markers.OrderBy(m => m.Index))
        {
            var key = Normalize(marker.Text);
            var hit = pool.FindIndex(p => p.key == key);
            if (hit < 0) continue;
            var asset = pool[hit].asset;
            pool.RemoveAt(hit);
            var k = marker.Index.ToString();
            next.AssetIdByMarkerIndex[k] = asset.Id;
            next.AssetRunAtByMarkerIndex[k] = now;
            marker.AssetId = asset.Id;
            marker.Url = asset.Url;
            marker.Status = "done";
            marker.ErrorMessage = null;
            carried.Add(marker.Index);
        }
        next.DoneImageCount = next.AssetIdByMarkerIndex.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count();
        return carried;
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
