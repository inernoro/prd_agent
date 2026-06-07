using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.SpeechAgent;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;

namespace PrdAgent.Api.Services;

/// <summary>
/// 演讲智能体 — 把长文本/文档转成思维导图风格的演讲。
/// 首期模式：mindmap（思维导图）。后续可扩 outline/story/data 模式，复用同一棵 SpeechDeck/SpeechNode 结构。
/// </summary>
public class SpeechAgentService
{
    private readonly ILlmGateway _gateway;
    private readonly IImageGenGateway _imageGateway;
    private readonly MongoDbContext _db;
    private readonly ILogger<SpeechAgentService> _logger;

    // 公开常量供 Controller 在落库前截断,避免 DB 存了 1MB 但 LLM 只看了 16K,
    // 让用户误以为全文都参与了大纲 (Bugbot Medium "Source text not truncated")
    public const int SourceTextMaxChars = 16000;

    public SpeechAgentService(
        ILlmGateway gateway,
        IImageGenGateway imageGateway,
        MongoDbContext db,
        ILogger<SpeechAgentService> logger)
    {
        _gateway = gateway;
        _imageGateway = imageGateway;
        _db = db;
        _logger = logger;
    }

    // ── E3 演讲备注 ────────────────────────────────

    /// <summary>给单节点生成口播稿（60 秒可读完的演讲腔调），结果写回 SpeechNode.SpeakerNotes。</summary>
    public async Task<string?> GenerateSpeakerNotesAsync(SpeechNode node, string deckTitle, CancellationToken ct = default)
    {
        var prompt = $"""
你是资深演讲教练。请把下面这一个演讲节点扩写成 60 秒能讲完的口播稿（约 180-220 字），口语化、有节奏、有金句感。直接输出口播稿，不要任何前缀、Markdown、引号或说明。

演讲主题：{deckTitle}
节点标题：{node.Title}
节点要点：
{string.Join("\n", node.BulletPoints.Select((b, i) => $"{i + 1}. {b}"))}
""";

        var req = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.SpeechAgent.Mindmap.SpeakerNotes,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray { new JsonObject { ["role"] = "user", ["content"] = prompt } },
                ["temperature"] = 0.7,
            },
            TimeoutSeconds = 60,
            Context = new GatewayRequestContext { UserId = null },
        };

        var sb = new StringBuilder();
        try
        {
            await foreach (var c in _gateway.StreamAsync(req, CancellationToken.None))
            {
                if (c.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(c.Content)) sb.Append(c.Content);
                else if (c.Type == GatewayChunkType.Error) return null;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[speech] notes gen failed node={NodeId}", node.Id);
            return null;
        }

        var text = sb.ToString().Trim();
        if (string.IsNullOrEmpty(text)) return null;

        await _db.SpeechNodes.UpdateOneAsync(
            n => n.Id == node.Id,
            Builders<SpeechNode>.Update.Set(n => n.SpeakerNotes, text).Set(n => n.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        return text;
    }

    // ── E11 节点 AI 重写 ─────────────────────────────

    /// <summary>按指定风格重写节点的标题+要点。返回新 title + bullets，调用方自行决定是否保存。</summary>
    public async Task<(string title, List<string> bullets)?> RewriteNodeAsync(SpeechNode node, string style, string deckTitle, CancellationToken ct = default)
    {
        var styleHint = style switch
        {
            "concise" => "更精简，每条要点不超过 12 字",
            "story" => "故事化，开场用一个具体场景或问句",
            "data" => "数据化，每条要点尽量带数字或具体度量",
            "question" => "反问开场，让听众思考",
            "leijun" => "雷军风：克制、坦诚、用产品参数说话",
            "ted" => "TED 风：开场金句 + 一个反直觉观点",
            _ => "更清晰生动",
        };
        var prompt = $$"""
你是资深演讲教练。请重写下面这个节点，风格要求：{{styleHint}}。

演讲主题：{{deckTitle}}
原节点标题：{{node.Title}}
原要点：
{{string.Join("\n", node.BulletPoints.Select((b, i) => $"{i + 1}. {b}"))}}

严格只输出 JSON（开头第一个字符是左花括号）：
{
  "title": "<重写后标题，≤24 字>",
  "bulletPoints": ["<要点1>", "<要点2>", "<要点3>"]
}
""";

        var req = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.SpeechAgent.Mindmap.NodeRewrite,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray { new JsonObject { ["role"] = "user", ["content"] = prompt } },
                ["temperature"] = 0.7,
            },
            TimeoutSeconds = 60,
            Context = new GatewayRequestContext { UserId = null },
        };

        var sb = new StringBuilder();
        try
        {
            await foreach (var c in _gateway.StreamAsync(req, CancellationToken.None))
            {
                if (c.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(c.Content)) sb.Append(c.Content);
                else if (c.Type == GatewayChunkType.Error) return null;
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "[speech] rewrite failed node={NodeId}", node.Id); return null; }

        var raw = sb.ToString();
        var json = ExtractJsonObject(raw);
        if (json == null) return null;
        var newTitle = json["title"]?.GetValue<string>() ?? node.Title;
        var newBullets = (json["bulletPoints"] as JsonArray)?
            .OfType<JsonValue>()
            .Select(v => v.TryGetValue<string>(out var s) ? s : null)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s!.Trim())
            .ToList() ?? node.BulletPoints;
        return (newTitle.Trim(), newBullets);
    }

    // ── E1 / E4 节点配图 ─────────────────────────────

    /// <summary>给节点生成 AI 配图。整 deck 共用一个 IllustrationStyle，确保风格统一。</summary>
    public async Task<string?> GenerateNodeImageAsync(SpeechDeck deck, SpeechNode node, CancellationToken ct = default)
    {
        var stylePrefix = deck.IllustrationStyle switch
        {
            "watercolor" => "watercolor illustration, soft strokes, paper texture, pastel palette, ",
            "3d" => "3D isometric illustration, clean shading, modern startup style, ",
            "pixel" => "pixel art, 8-bit, retro game aesthetics, ",
            "sketch" => "hand-drawn sketch, marker on white paper, minimal lines, ",
            "tech" => "futuristic tech illustration, neon accents, dark navy background, ",
            _ => "flat vector illustration, minimal lines, off-white background, warm orange + teal palette, ",
        };

        var bulletsHint = string.Join("; ", node.BulletPoints.Take(3));
        var prompt = $"{stylePrefix}concept of: {node.Title}. {bulletsHint}. No text, no captions, no watermarks. Square composition.";

        var payload = new ImageGenPayload
        {
            Prompt = prompt,
            N = 1,
            Size = "1024x1024",
            ResponseFormat = "url",
        };

        ImageGenGatewayResult result;
        try
        {
            result = await _imageGateway.GenerateImageAsync(
                AppCallerRegistry.SpeechAgent.Mindmap.NodeImage,
                expectedModel: null,
                payload,
                CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "[speech] image gen failed node={NodeId}", node.Id); return null; }

        if (!result.Success || result.Images.Count == 0) return null;

        var img = result.Images[0];
        var url = img.Url;
        if (string.IsNullOrWhiteSpace(url)) return null;

        var asset = new ImageAsset
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = deck.OwnerUserId,
            Sha256 = ComputeUrlSha256(url),
            Mime = "image/png",
            Width = 1024,
            Height = 1024,
            Url = url,
            OriginalUrl = url,
            Prompt = prompt.Length > 300 ? prompt[..300] : prompt,
            CreatedAt = DateTime.UtcNow,
        };
        await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: CancellationToken.None);

        await _db.SpeechNodes.UpdateOneAsync(
            n => n.Id == node.Id,
            Builders<SpeechNode>.Update.Set(n => n.ImageAssetId, asset.Id).Set(n => n.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        return asset.Id;
    }

    private static string ComputeUrlSha256(string url)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();
    }

    // ── E2 一键发布 HTML 演讲站 ──────────────────────

    /// <summary>把 deck 树渲染成独立 HTML 字符串（含 mindmap-ppt 范式逐个生长 + 镜头跟随 + 背景视差）。</summary>
    public string RenderDeckHtml(SpeechDeck deck, List<SpeechNode> nodes, Dictionary<string, string?> imageUrls)
    {
        var nodesPayload = new JsonArray();
        foreach (var n in nodes.OrderBy(n => n.Depth).ThenBy(n => n.Order))
        {
            nodesPayload.Add(new JsonObject
            {
                ["id"] = n.Id,
                ["parentId"] = n.ParentId,
                ["title"] = n.Title,
                ["bullets"] = new JsonArray(n.BulletPoints.Select(b => JsonValue.Create(b)!).ToArray<JsonNode>()),
                ["notes"] = n.SpeakerNotes,
                ["order"] = n.Order,
                ["depth"] = n.Depth,
                ["image"] = imageUrls.TryGetValue(n.Id, out var u) ? u : null,
            });
        }
        // 防 <script> 上下文逃逸：节点标题/要点里如果含 "</script>" 或 "<!--" 会破坏 inline <script>。
        // 标准做法把序列化后的 / 与 < 转义成 \/ 和 < —— JSON 仍合法,JS 解析后等价,但不会再"看到"
        // 闭合标签 (Bugbot Medium "Published HTML script breakout")。
        var nodesJson = nodesPayload.ToJsonString()
            .Replace("</", "<\\/")
            .Replace("<!--", "<\\u0021--")
            .Replace("<script", "<\\u0073cript");
        var titleSafe = System.Web.HttpUtility.HtmlEncode(deck.Title);

        return $$$"""
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{{titleSafe}}} · MINDMAP PPT</title>
  <style>
    :root { color: #172033; background: #fcfcf8; font-family: Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow: hidden; background: linear-gradient(180deg, #fff, #fbfbf7); }
    .stage { position: fixed; inset: 0; overflow: hidden; }
    .bg::before, .bg::after { content:""; position:absolute; border-radius:999px; filter:blur(26px); opacity:0.9; will-change:transform; pointer-events:none; }
    .bg::before { top:-12vh; left:-8vw; width:min(48vw,760px); height:min(48vw,760px); background:radial-gradient(circle, rgba(219,233,241,0.6) 0%, rgba(219,233,241,0.12) 40%, transparent 64%); animation: orbA 18s linear infinite; }
    .bg::after { top:-12vh; right:-8vw; width:min(44vw,700px); height:min(44vw,700px); background:radial-gradient(circle, rgba(247,228,206,0.58) 0%, rgba(247,228,206,0.12) 40%, transparent 64%); animation: orbB 21s linear infinite; }
    @keyframes orbA { 25%{transform:translate3d(28vw,-4vh,0) scale(1.08);} 50%{transform:translate3d(42vw,20vh,0) scale(0.96);} 75%{transform:translate3d(10vw,42vh,0) scale(1.04);} }
    @keyframes orbB { 25%{transform:translate3d(-28vw,-4vh,0) scale(1.06);} 50%{transform:translate3d(-42vw,19vh,0) scale(0.93);} 75%{transform:translate3d(-10vw,41vh,0) scale(1.02);} }
    .map { position:absolute; top:0; left:0; transform-origin:0 0; transition: transform 640ms cubic-bezier(0.22,1,0.36,1); }
    .node { position:absolute; background:#fff; border:2px solid rgba(26,42,49,0.18); border-radius:8px; padding:12px 24px 16px; min-width:240px; max-width:280px; text-align:center; transition: transform 920ms cubic-bezier(0.18,1.08,0.32,1), background 620ms ease, border-color 620ms ease, color 620ms ease, box-shadow 620ms ease; }
    .node.path { background:#fffdf8; border-color: rgba(38,77,92,0.34); }
    .node.complete { background:#eef7f3; border-color: rgba(37,126,103,0.35); }
    .node.active { background:#183a4a; border-color:#d8894f; border-width:3px; color:#fff; box-shadow: 0 0 14px rgba(216,137,79,0.42); transform: scale(1.5); }
    .node .sub { font-size:13px; font-weight:850; color:#6b745d; margin-bottom:3px; line-height:1.1; }
    .node.active .sub { color:rgba(255,255,255,0.72); }
    .node .ttl { font-size:19px; font-weight:800; line-height:1.25; margin-bottom:6px; }
    .node .img { width:145px; height:76px; margin:4px auto 0; background:rgba(255,255,255,0.7); border:1px solid rgba(31,52,56,0.12); border-radius:7px; overflow:hidden; }
    .node .img img { width:100%; height:100%; object-fit:cover; }
    svg.links { position:absolute; top:0; left:0; width:2400px; height:1600px; overflow:visible; pointer-events:none; }
    svg.links path { fill:none; stroke:rgba(42,55,68,0.3); stroke-width:3; stroke-linecap:round; transition:stroke 240ms ease, stroke-width 240ms ease; }
    svg.links path.p { stroke:rgba(24,58,74,0.74); stroke-width:4; }
    header { position:absolute; top:28px; left:32px; z-index:30; max-width:440px; }
    header .eb { font-size:11px; font-weight:850; letter-spacing:0.25em; color:#6b745d; text-transform:uppercase; margin-bottom:4px; }
    header h1 { margin:0; font-size:28px; font-weight:800; color:#172033; line-height:1.1; }
    footer { position:fixed; bottom:0; left:0; right:0; padding:16px 28px; background:rgba(255,255,255,0.72); backdrop-filter: blur(16px); border-top:1px solid rgba(26,42,49,0.12); display:flex; align-items:center; gap:16px; z-index:30; }
    footer .lbl { font-size:10px; font-weight:800; color:#6b745d; text-transform:uppercase; letter-spacing:0.1em; }
    footer button { width:36px; height:36px; border-radius:50%; border:1px solid rgba(26,42,49,0.18); background:#fff; color:#183a4a; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:16px; }
    footer button.primary { background:#183a4a; color:#fff; border:none; box-shadow:0 2px 8px rgba(24,58,74,0.3); }
    footer button:disabled { opacity:0.3; cursor:default; }
    footer .ct { font-family:ui-monospace, monospace; font-size:12px; font-weight:700; color:#172033; min-width:60px; text-align:right; }
    footer input[type=range] { flex:1; appearance:none; height:4px; border-radius:2px; outline:none; background: linear-gradient(to right, #d8894f var(--p, 0%), rgba(26,42,49,0.12) var(--p, 0%)); }
    footer input[type=range]::-webkit-slider-thumb { appearance:none; width:14px; height:14px; border-radius:50%; background:#183a4a; cursor:pointer; box-shadow:0 2px 6px rgba(24,58,74,0.4); }
    aside.notes { position:fixed; right:16px; bottom:80px; max-width:320px; background:rgba(255,255,253,0.95); border:1px solid rgba(26,42,49,0.12); border-radius:8px; padding:12px 16px; font-size:13px; color:#172033; line-height:1.6; box-shadow:0 8px 24px rgba(0,0,0,0.08); z-index:25; }
    aside.notes .lbl { font-size:10px; font-weight:800; color:#6b745d; text-transform:uppercase; margin-bottom:6px; letter-spacing:0.1em; }
    aside.notes.hidden { display:none; }
  </style>
</head>
<body>
  <div class="stage bg">
    <div class="map" id="map">
      <svg class="links" id="links"></svg>
      <div id="nodes"></div>
    </div>
    <header>
      <div class="eb">MINDMAP PPT</div>
      <h1>{{{titleSafe}}}</h1>
    </header>
    <aside class="notes hidden" id="notes">
      <div class="lbl">口播稿</div>
      <div id="notesText"></div>
    </aside>
    <footer>
      <button id="prev" title="上一个 (←)">←</button>
      <span class="lbl">顺序</span>
      <input type="range" id="slider" min="0" max="0" value="0" />
      <span class="ct" id="counter">1 / 1</span>
      <button id="next" class="primary" title="下一个 (→/空格)">→</button>
    </footer>
  </div>
  <script>
    const DATA = {{{nodesJson}}};
    const LAYOUT = { minW: 240, minH: 100, pathGap: 99, rowGap: 75, padX: 114, baseY: 520 };
    const byId = new Map(DATA.map(n => [n.id, n]));
    const childrenOf = new Map();
    let root = null;
    for (const n of DATA) {
      if (n.parentId) {
        const arr = childrenOf.get(n.parentId) || [];
        arr.push(n); childrenOf.set(n.parentId, arr);
      } else if (n.depth === 0) root = n;
    }
    for (const arr of childrenOf.values()) arr.sort((a,b)=>a.order-b.order);
    const preorder = [];
    // 无根兜底:数据异常时不直接 throw 把页面整屏白屏 (Bugbot Low "Published player crashes without root")
    if (!root) {
      document.getElementById('map').innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#172033;font-size:14px;">演讲数据缺少根节点,无法播放。</div>';
    } else {
      (function walk(n,d){ n._d=d; n._idx=preorder.length; preorder.push(n); (childrenOf.get(n.id)||[]).forEach(c=>walk(c,d+1)); })(root, 0);
    }
    const total = preorder.length;
    let activeIndex = 0;
    function pathToRoot(n){ const p=[]; let c=n; while(c){ p.unshift(c); c=byId.get(c.parentId); } return p; }
    function measureSubtree(n, vis){
      const ks = (childrenOf.get(n.id)||[]).filter(c=>vis.has(c.id));
      if (ks.length === 0) return LAYOUT.minH;
      const hs = ks.map(c=>measureSubtree(c, vis));
      return Math.max(LAYOUT.minH, hs.reduce((a,b)=>a+b,0) + (hs.length-1)*LAYOUT.rowGap);
    }
    function placeSubtree(n, vis, pos, ax, ay){
      pos.set(n.id, {x:ax, y:ay});
      const ks = (childrenOf.get(n.id)||[]).filter(c=>vis.has(c.id));
      if (!ks.length) return;
      const hs = ks.map(c=>({c, h:measureSubtree(c,vis)}));
      const tot = hs.reduce((a,b)=>a+b.h,0) + (hs.length-1)*LAYOUT.rowGap;
      let cy = ay - tot/2;
      for (const {c,h} of hs){
        placeSubtree(c, vis, pos, ax + LAYOUT.minW + LAYOUT.pathGap, cy + h/2);
        cy += h + LAYOUT.rowGap;
      }
    }
    function build(idx){
      const isEnd = idx >= total;
      const active = isEnd ? null : preorder[idx];
      const path = active ? pathToRoot(active) : [];
      const pathSet = new Set(path.map(p=>p.id));
      const vis = isEnd ? new Set(preorder.map(n=>n.id)) : new Set(preorder.slice(0, idx+1).map(n=>n.id));
      const pos = new Map();
      if (isEnd) {
        placeSubtree(root, vis, pos, LAYOUT.padX + LAYOUT.minW/2, LAYOUT.baseY);
      } else {
        let cx = LAYOUT.padX;
        for (const n of path){ pos.set(n.id, {x: cx + LAYOUT.minW/2, y: LAYOUT.baseY}); cx += LAYOUT.minW + LAYOUT.pathGap; }
        const completed = [];
        path.forEach((n, di) => {
          (childrenOf.get(n.id)||[]).forEach(c => {
            if (vis.has(c.id) && !pathSet.has(c.id)) completed.push({c, di, h: measureSubtree(c, vis)});
          });
        });
        const ch = completed.reduce((a,b)=>a+b.h,0) + Math.max(0,completed.length-1)*LAYOUT.rowGap;
        let cy = LAYOUT.baseY - LAYOUT.rowGap - ch;
        for (const st of completed){
          const pp = pos.get(path[st.di].id);
          placeSubtree(st.c, vis, pos, pp.x + LAYOUT.minW + LAYOUT.pathGap, cy + st.h/2);
          cy += st.h + LAYOUT.rowGap;
        }
      }
      // render
      const nodesEl = document.getElementById('nodes');
      const linksEl = document.getElementById('links');
      const nodesHtml = []; const linksHtml = [];
      vis.forEach(id => {
        const n = byId.get(id); const p = pos.get(id);
        if (!p) return;
        const cls = id === active?.id ? 'active' : (pathSet.has(id) ? 'path' : 'complete');
        const subtitle = n.depth === 0 ? '主题' : (n.depth === 1 ? '第 ' + (n.order+1) + ' 章' : '要点 ' + (n.order+1));
        const img = n.image ? '<div class="img"><img src="' + escapeHtml(n.image) + '" alt=""/></div>' : '';
        nodesHtml.push('<div class="node ' + cls + '" style="left:' + (p.x - LAYOUT.minW/2) + 'px; top:' + (p.y - LAYOUT.minH/2) + 'px;"><div class="sub">' + subtitle + '</div><div class="ttl">' + escapeHtml(n.title) + '</div>' + img + '</div>');
        if (n.parentId && pos.has(n.parentId)){
          const pp = pos.get(n.parentId);
          const sx = pp.x + LAYOUT.minW/2, sy = pp.y, ex = p.x - LAYOUT.minW/2, ey = p.y;
          const mx = sx + Math.max(36, (ex-sx)*0.5);
          const isPath = pathSet.has(n.parentId) && pathSet.has(id);
          linksHtml.push('<path class="' + (isPath ? 'p':'') + '" d="M ' + sx + ' ' + sy + ' C ' + mx + ' ' + sy + ', ' + mx + ' ' + ey + ', ' + ex + ' ' + ey + '"/>');
        }
      });
      nodesEl.innerHTML = nodesHtml.join('');
      linksEl.innerHTML = linksHtml.join('');
      // camera
      const target = active || (isEnd ? boundsCenter([...pos.values()]) : {x: LAYOUT.padX, y: LAYOUT.baseY});
      const tx = (active ? pos.get(active.id).x : target.x);
      const ty = (active ? pos.get(active.id).y : target.y);
      const zoom = 0.85;
      const vw = window.innerWidth / zoom, vh = window.innerHeight / zoom;
      const vx = tx - vw/2, vy = ty - vh/2;
      document.getElementById('map').style.transform = 'scale(' + zoom + ') translate(' + (-vx) + 'px, ' + (-vy) + 'px)';
      // controls
      document.getElementById('counter').textContent = Math.min(idx+1, total+1) + ' / ' + (total+1);
      const s = document.getElementById('slider'); s.max = total; s.value = idx;
      const p = total === 0 ? 0 : (idx / total) * 100;
      s.style.setProperty('--p', p + '%');
      document.getElementById('prev').disabled = idx === 0;
      document.getElementById('next').disabled = isEnd;
      // notes drawer
      const notesAside = document.getElementById('notes');
      if (active && active.notes) {
        document.getElementById('notesText').textContent = active.notes;
        notesAside.classList.remove('hidden');
      } else { notesAside.classList.add('hidden'); }
    }
    function boundsCenter(pts){
      let xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
      return {x:(Math.min(...xs)+Math.max(...xs))/2, y:(Math.min(...ys)+Math.max(...ys))/2};
    }
    function escapeHtml(s){ return String(s).replace(/[<>&"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
    function go(d){ activeIndex = Math.max(0, Math.min(total, activeIndex + d)); build(activeIndex); }
    function jump(n){ activeIndex = Math.max(0, Math.min(total, n)); build(activeIndex); }
    window.addEventListener('keydown', e => {
      if (['ArrowRight','ArrowDown',' ','PageDown'].includes(e.key)){ e.preventDefault(); go(1); }
      else if (['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){ e.preventDefault(); go(-1); }
    });
    document.getElementById('next').onclick = () => go(1);
    document.getElementById('prev').onclick = () => go(-1);
    document.getElementById('slider').oninput = e => jump(Number(e.target.value));
    let wb = 0, wt = null;
    window.addEventListener('wheel', e => {
      e.preventDefault();
      wb += e.deltaY;
      if (wt) clearTimeout(wt);
      wt = setTimeout(()=>{wb=0;}, 200);
      while (wb >= 72) { wb -= 72; go(1); }
      while (wb <= -72) { wb += 72; go(-1); }
    }, { passive: false });
    window.addEventListener('resize', () => build(activeIndex));
    // 仅在有根节点时启动渲染,无根时上方已挂错误提示 (Bugbot Low "Published player crashes without root")
    if (root) build(0);
  </script>
</body>
</html>
""";
    }

    /// <summary>
    /// 流式生成思维导图：拆 root → 章节 → 要点。流式返回 typing 文本 + 解析完成后的节点列表。
    /// </summary>
    public async IAsyncEnumerable<SpeechGenerateEvent> GenerateMindmapAsync(
        SpeechDeck deck,
        Func<string, Task>? onTyping = null,
        Func<string, Task>? onThinking = null,
        Func<string, string, Task>? onModel = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var systemPrompt = BuildMindmapSystemPrompt(deck);
        var userMessage = BuildMindmapUserMessage(deck);

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.SpeechAgent.Mindmap.Outline,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage },
                },
                ["temperature"] = 0.5,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = deck.OwnerUserId },
        };

        var buffer = new StringBuilder();
        string? error = null;

        await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
            {
                if (onModel != null)
                {
                    // 必须 await,不能 fire-and-forget,否则 model 事件与紧随其后的 thinking/text 写入会
                    // 在同一 Response.Body 上交错,产生损坏的 SSE 帧 (Codex P2 "Await model SSE writes")
                    try { await onModel(chunk.Resolution.ActualModel ?? "", chunk.Resolution.ActualPlatformName ?? ""); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[speech] onModel ignored"); }
                }
            }
            else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
            {
                if (onThinking != null)
                {
                    try { await onThinking(chunk.Content); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[speech] onThinking ignored"); }
                }
            }
            else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                buffer.Append(chunk.Content);
                if (onTyping != null)
                {
                    try { await onTyping(chunk.Content); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[speech] onTyping ignored"); }
                }
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                error = chunk.Error ?? "网关返回未知错误";
                break;
            }
        }

        if (error != null)
        {
            yield return SpeechGenerateEvent.Error(error);
            yield break;
        }

        var raw = buffer.ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            yield return SpeechGenerateEvent.Error("LLM 返回为空");
            yield break;
        }

        var parsed = TryParseMindmapJson(raw);
        if (parsed == null)
        {
            _logger.LogWarning("[speech] 解析 JSON 失败，raw={Raw}", raw[..Math.Min(500, raw.Length)]);
            yield return SpeechGenerateEvent.Error("解析大纲失败：模型输出不符合 JSON 结构");
            yield break;
        }

        var nodes = FlattenMindmap(parsed, deck.Id);
        foreach (var n in nodes)
        {
            await _db.SpeechNodes.InsertOneAsync(n, cancellationToken: CancellationToken.None);
            yield return SpeechGenerateEvent.NodeUpserted(n);
        }

        await _db.SpeechDecks.UpdateOneAsync(
            d => d.Id == deck.Id,
            Builders<SpeechDeck>.Update
                .Set(d => d.Status, SpeechDeckStatus.Ready)
                .Set(d => d.NodeCount, nodes.Count)
                .Set(d => d.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        yield return SpeechGenerateEvent.Done(nodes.Count);
    }

    private static string BuildMindmapSystemPrompt(SpeechDeck deck)
    {
        return $$"""
你是一位资深演讲教练。任务：把一段原始文本拆成一棵"演讲用"思维导图。

输出严格遵循以下 JSON 结构（不要加 markdown fence，不要加任何额外说明文字，只输出 JSON）：

{
  "root": { "title": "<演讲主题，不超过 24 字>", "bulletPoints": ["<开场金句 1>", "<开场金句 2>"] },
  "children": [
    {
      "title": "<一级章节标题，不超过 18 字>",
      "bulletPoints": ["<要点 1>", "<要点 2>", "<要点 3>"],
      "children": [
        { "title": "<二级要点标题>", "bulletPoints": ["<细分要点>"] }
      ]
    }
  ]
}

规则：
- 演讲风格：{{deck.Style}}；目标受众：{{deck.Audience}}；目标层级深度：{{deck.Depth}}（不要超）
- 一级章节 4-7 个；每节点 bulletPoints 2-5 条，每条不超过 30 字
- 节点之间逻辑递进，标题简短可上屏
- 不要照抄原文，要提炼+口语化改写
- 严格只输出 JSON，开头第一个字符必须是左花括号
""";
    }

    private static string BuildMindmapUserMessage(SpeechDeck deck)
    {
        var src = deck.SourceText;
        if (src.Length > SourceTextMaxChars) src = src[..SourceTextMaxChars] + "\n...（已截断）";
        return $"原始材料如下，请生成演讲思维导图：\n\n{src}";
    }

    private static MindmapJson? TryParseMindmapJson(string raw)
    {
        var json = ExtractJsonObject(raw);
        if (json == null) return null;
        try
        {
            var root = json["root"]?.AsObject();
            if (root == null) return null;
            // children 可在顶层(json.children)或嵌套在 root 内(json.root.children),按 LLM 输出兜底
            // (Bugbot Medium "Mindmap parser drops root children")
            var childrenNode = json["children"] ?? root["children"];
            return new MindmapJson
            {
                Root = new MindmapNode
                {
                    Title = root["title"]?.GetValue<string>() ?? "未命名",
                    BulletPoints = GetStringArray(root, "bulletPoints"),
                    Children = ParseChildren(childrenNode),
                },
            };
        }
        catch
        {
            return null;
        }
    }

    private static List<MindmapNode> ParseChildren(JsonNode? arrNode)
    {
        var result = new List<MindmapNode>();
        if (arrNode is not JsonArray arr) return result;
        foreach (var item in arr)
        {
            if (item is not JsonObject obj) continue;
            result.Add(new MindmapNode
            {
                Title = obj["title"]?.GetValue<string>() ?? "未命名",
                BulletPoints = GetStringArray(obj, "bulletPoints"),
                Children = ParseChildren(obj["children"]),
            });
        }
        return result;
    }

    private static List<string> GetStringArray(JsonObject obj, string key)
    {
        var arr = obj[key] as JsonArray;
        if (arr == null) return new();
        var list = new List<string>();
        foreach (var item in arr)
        {
            if (item is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                list.Add(s.Trim());
        }
        return list;
    }

    private static JsonObject? ExtractJsonObject(string content)
    {
        var trimmed = content.Trim();
        var fenceMatch = System.Text.RegularExpressions.Regex.Match(
            trimmed, @"```(?:json)?\s*([\s\S]*?)\s*```",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        var src = fenceMatch.Success ? fenceMatch.Groups[1].Value : trimmed;
        var start = src.IndexOf('{');
        var end = src.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            var node = JsonNode.Parse(src.Substring(start, end - start + 1));
            return node as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private static List<SpeechNode> FlattenMindmap(MindmapJson mindmap, string deckId)
    {
        var list = new List<SpeechNode>();
        var rootId = Guid.NewGuid().ToString("N");
        list.Add(new SpeechNode
        {
            Id = rootId,
            DeckId = deckId,
            ParentId = null,
            Order = 0,
            Depth = 0,
            Title = mindmap.Root.Title,
            BulletPoints = mindmap.Root.BulletPoints,
            Status = SpeechNodeStatus.Ready,
        });
        Walk(mindmap.Root.Children, rootId, 1, deckId, list);
        return list;
    }

    private static void Walk(List<MindmapNode> children, string parentId, int depth, string deckId, List<SpeechNode> sink)
    {
        for (int i = 0; i < children.Count; i++)
        {
            var child = children[i];
            var id = Guid.NewGuid().ToString("N");
            sink.Add(new SpeechNode
            {
                Id = id,
                DeckId = deckId,
                ParentId = parentId,
                Order = i,
                Depth = depth,
                Title = child.Title,
                BulletPoints = child.BulletPoints,
                Status = SpeechNodeStatus.Ready,
            });
            Walk(child.Children, id, depth + 1, deckId, sink);
        }
    }

    private class MindmapJson
    {
        public MindmapNode Root { get; set; } = new();
    }

    private class MindmapNode
    {
        public string Title { get; set; } = "";
        public List<string> BulletPoints { get; set; } = new();
        public List<MindmapNode> Children { get; set; } = new();
    }
}

public class SpeechGenerateEvent
{
    public string Kind { get; set; } = "";
    public SpeechNode? Node { get; set; }
    public string? Message { get; set; }
    public int? Count { get; set; }

    public static SpeechGenerateEvent NodeUpserted(SpeechNode n) => new() { Kind = "node", Node = n };
    public static SpeechGenerateEvent Done(int count) => new() { Kind = "done", Count = count };
    public static SpeechGenerateEvent Error(string msg) => new() { Kind = "error", Message = msg };
}
