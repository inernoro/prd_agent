using System.Net;
using System.Text;

namespace PrdAgent.Core.Models;

/// <summary>只读发布快照导出，不执行文档中的HTML、脚本或远程资源。</summary>
public static class WritingHtmlExport
{
    public static string Render(WritingPublication document)
    {
        static string E(string? text) => WebUtility.HtmlEncode(text ?? "");
        static string Anchor(string prefix, string id) => prefix + Convert.ToHexString(Encoding.UTF8.GetBytes(id)).ToLowerInvariant();
        var html = new StringBuilder("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>");
        html.Append(E(document.Title)).Append("</title><style>html{color-scheme:light dark}body{font:17px/1.85 system-ui,sans-serif;max-width:850px;margin:auto;padding:32px 22px}h1,h2{line-height:1.4}h1{font-size:2em}h2{margin-top:2em}p,.prose{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit;text-underline-offset:4px}.meta{opacity:.7;font-size:14px}blockquote{border-inline-start:3px solid #718096;margin-inline:0;padding-inline:16px}table{border-collapse:collapse;width:100%;overflow-wrap:anywhere}td{border:1px solid #8b919e;padding:8px}details{margin:12px 0}section:target,p:target{outline:2px solid #727dc7;outline-offset:6px}</style></head><body>");
        html.Append("<header><div class=\"meta\">作者确认的发布版 v").Append(document.Version).Append(" · ").Append(E(document.AuthorName)).Append(" · 审核：").Append(E(document.ReviewerName)).Append("</div><h1>").Append(E(document.Title)).Append("</h1><p>").Append(E(document.Summary)).Append("</p></header>");
        if (document.IntentPoints.Count > 0) {
            html.Append("<h2>作者要点</h2><ol>");
            for (var i = 0; i < document.IntentPoints.Count; i++) {
                html.Append("<li>").Append(E(document.IntentPoints[i]));
                var coverage = document.IntentCoverage.FirstOrDefault(c => c.IntentIndex == i);
                if (coverage != null) foreach (var id in coverage.ParagraphIds) html.Append(" <a href=\"#").Append(Anchor("p", id)).Append("\">查看正文</a>");
                html.Append("</li>");
            }
            html.Append("</ol>");
        }
        if (document.Conclusions.Count > 0) {
            html.Append(document.IntentPoints.Count > 0 ? "<details><summary>完整结论</summary><ol>" : "<h2>结论</h2><ol>")
                .AppendJoin("", document.Conclusions.Select(c => "<li>" + E(c) + "</li>")).Append(document.IntentPoints.Count > 0 ? "</ol></details>" : "</ol>");
        }
        html.Append("<h2>适用边界</h2><p>适用：").Append(E(document.ScopeIn)).Append("\n不适用：").Append(E(document.ScopeOut)).Append("</p>");
        if (document.Roles.Count > 0) {
            html.Append("<h2>按角色行动</h2>");
            foreach (var r in document.Roles) html.Append("<h3>").Append(E(r.Label)).Append("</h3><p>").Append(E(r.Action)).Append("\n条件：").Append(E(r.Condition)).Append("</p><a href=\"#").Append(Anchor("s", r.SectionId)).Append("\">定位章节</a>");
        }
        html.Append("<nav aria-label=\"目录\"><h2>目录</h2><ol>");
        foreach (var section in document.Sections) html.Append("<li><a href=\"#").Append(Anchor("s", section.Id)).Append("\">").Append(E(section.Title)).Append("</a></li>");
        html.Append("</ol></nav><main>");
        foreach (var section in document.Sections) {
            html.Append("<section id=\"").Append(Anchor("s", section.Id)).Append("\"><h2>").Append(E(section.Title)).Append("</h2>");
            if (!string.IsNullOrWhiteSpace(section.Condition)) html.Append("<blockquote>适用条件：").Append(E(section.Condition)).Append("</blockquote>");
            foreach (var p in section.Paragraphs) {
                if (p.Status == "auth") html.Append("<div class=\"meta\">作者补充</div>");
                html.Append("<p id=\"").Append(Anchor("p", p.Id)).Append("\">").Append(E(p.Text)).Append("</p>");
                foreach (var sourceId in p.Citations) {
                    html.Append("<details><summary><a href=\"#").Append(Anchor("source", sourceId)).Append("\">").Append(E(sourceId)).Append("</a> · 引用原文</summary><blockquote>");
                    if (p.Quotes.TryGetValue(sourceId, out var quote)) html.Append(E(quote));
                    else html.Append("该版本未保存引用片段");
                    html.Append("</blockquote></details>");
                }
            }
            if (section.Detail is { Rows.Count: > 0 } detail) {
                html.Append("<h3>").Append(E(detail.Label)).Append("</h3><table>");
                foreach (var row in detail.Rows) html.Append("<tr>").AppendJoin("", row.Select(cell => "<td>" + E(cell) + "</td>")).Append("</tr>");
                html.Append("</table>");
            }
            html.Append("</section>");
        }
        html.Append("</main>");
        if (document.OpenQuestions.Count > 0) html.Append("<h2>待确认事项</h2><ul>").AppendJoin("", document.OpenQuestions.Select(q => "<li>" + E(q.Title) + "：" + E(q.Answer) + "</li>")).Append("</ul>");
        html.Append("<h2>来源与发布时快照</h2>");
        foreach (var source in document.Sources) {
            html.Append("<details id=\"").Append(Anchor("source", source.Id)).Append("\"><summary>").Append(E(source.Id + " · " + source.Title)).Append("</summary>");
            if (source.Status == "skipped") html.Append("<p>已跳过，未参与本次生成。</p>");
            else html.Append("<div class=\"prose\">").Append(E(string.IsNullOrEmpty(source.Content) ? "该版本未保存来源正文" : source.Content)).Append("</div>");
            html.Append("</details>");
        }
        return html.Append("<footer class=\"meta\">此文件包含发布时的文档与来源快照；转发前请确认接收者有权查看这些资料。</footer></body></html>").ToString();
    }
}
