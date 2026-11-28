using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal static class QuickCreationBrowserPlayback
{
    internal static readonly JsonSerializerOptions CompactJsonOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static byte[] Validate(DesignWorkspaceFile file, QuickCreationMedia metadata)
    {
        var bytes = Convert.FromBase64String(file.ContentBase64);
        if (bytes.Length != file.Size || !string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), file.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("影片播放包校验失败");
        try
        {
            using var document = JsonDocument.Parse(bytes);
            var root = document.RootElement;
            var duration = root.GetProperty("durationSec").GetDouble();
            if (root.GetProperty("version").GetInt32() != 1 || root.GetProperty("width").GetInt32() != 1920
                || root.GetProperty("height").GetInt32() != 1080 || root.GetProperty("fps").GetInt32() != 24
                || !double.IsFinite(duration) || duration <= 0 || Math.Abs(duration - metadata.DurationSec) > 0.05
                || metadata.HasSubtitleFreePreview || metadata.CaptionsBurnedIn || metadata.Captions.Count == 0)
                throw new InvalidOperationException("影片播放包时间轴与音轨摘要不一致");
            var aac = root.GetProperty("aac").GetBytesFromBase64();
            var opus = root.GetProperty("opus").GetBytesFromBase64();
            if (aac.Length < 32 || !aac.AsSpan(4, 4).SequenceEqual("ftyp"u8)
                || opus.Length < 32 || !opus.AsSpan(0, 4).SequenceEqual(new byte[] { 0x1a, 0x45, 0xdf, 0xa3 }))
                throw new InvalidOperationException("影片播放包缺少 AAC 或 Opus 音轨");
            var scenes = root.GetProperty("scenes");
            if (scenes.GetArrayLength() is < 2 or > 40) throw new InvalidOperationException("影片播放包缺少画面");
            var timeline = 0.0;
            foreach (var scene in scenes.EnumerateArray())
            {
                var seconds = scene.GetProperty("durationSec").GetDouble();
                if (!double.IsFinite(seconds) || seconds <= 0 || scene.GetProperty("code").GetBytesFromBase64().Length == 0)
                    throw new InvalidOperationException("影片的分幕时间轴不正确");
                timeline += seconds;
            }
            if (Math.Abs(timeline - duration) > 0.1)
                throw new InvalidOperationException("分幕总时长与音轨不匹配");
            return bytes;
        }
        catch (Exception error) when (error is JsonException or FormatException or KeyNotFoundException)
        {
            throw new InvalidOperationException("影片播放包格式不正确", error);
        }
    }

    internal static string RenderSandbox(byte[] bundle)
    {
        using var document = JsonDocument.Parse(bundle);
        // JSON is inert inside the HTML script element. Escape each less-than sign to
        // prevent supplied captions from ending the element or inserting markup.
        var data = JsonSerializer.Serialize(document.RootElement, CompactJsonOptions)
            .Replace("<", "\\u003c", StringComparison.Ordinal);
        return Sandbox.Replace("__MAP_FILM_DATA__", data, StringComparison.Ordinal);
    }

    internal static byte[] BuildPublishedZip(string title, byte[] bundle)
    {
        var shell = RenderSandbox(bundle);
        // 发布包只有沙箱外壳入口，避免同源直接访问画面模块入口。
        var index = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + $"<title>{HtmlEncoder.Default.Encode(title)}</title><style>html,body,iframe{{margin:0;width:100%;height:100%;border:0;background:#131416}}</style></head>"
            + $"<body><iframe title=\"影片\" sandbox=\"allow-scripts\" srcdoc=\"{HtmlEncoder.Default.Encode(shell)}\" allowfullscreen></iframe></body></html>";
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteEntry(zip, "index.html", index);

        }
        return stream.ToArray();
    }

    private static void WriteEntry(ZipArchive archive, string name, string content)
    {
        using var entry = archive.CreateEntry(name, CompressionLevel.Fastest).Open();
        entry.Write(Encoding.UTF8.GetBytes(content));
    }

    private const string Sandbox = """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">
        <meta name="viewport" content="width=device-width, initial-scale=1"><title>影片播放器</title>
        <style>
          html,body{height:100%;margin:0;color-scheme:dark;background:#131416;color:#fff}
          body{font:14px system-ui}
          main{box-sizing:border-box;height:100%;display:flex;flex-direction:column;padding:.4rem}
          figure{flex:1;min-height:0;margin:0;position:relative}
          canvas{display:block;width:100%;height:100%;object-fit:contain}
          figcaption{position:absolute;bottom:5%;left:8%;right:8%;text-align:center;white-space:pre-line}
          figcaption span{background:#171819e6;padding:.3em .65em;border-radius:.4em}
          .controls{flex:none;display:flex;align-items:center;gap:.5rem;padding:.35rem}
          audio{flex:1;min-width:0;width:100%}
          button{padding:.35rem .55rem;white-space:nowrap}
          #start{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:.55rem 1rem;cursor:pointer}
          #status{margin:0;padding:0 .35rem}
        </style></head>
        <body><main><figure><canvas aria-label="影片画面"></canvas><figcaption><span hidden></span></figcaption>
        <button type="button" id="start">播放视频</button></figure>
        <div class="controls"><audio controls preload="metadata" aria-label="影片播放"></audio><button type="button" id="captions" aria-pressed="true">字幕</button></div>
        <p id="status" role="status"></p></main><script type="application/json" id="film">__MAP_FILM_DATA__</script>
        <script type="module">
        const film=JSON.parse(document.querySelector('#film').textContent);
        const canvas=document.querySelector('canvas'); canvas.width=film.width; canvas.height=film.height;
        const audio=document.querySelector('audio');
        const status=document.querySelector('#status');
        const caption=document.querySelector('figcaption span');
        const start=document.querySelector('#start');
        const toggle=document.querySelector('#captions');
        const aac=audio.canPlayType('audio/mp4; codecs="mp4a.40.2"');
        audio.src=aac?'data:audio/mp4;base64,'+film.aac:'data:audio/webm;base64,'+film.opus;
        let showCaptions=true, raf=0, rendering=false, asked=false, activeScene=-1, duration=film.durationSec;
        const modules=new Map();
        const end=film.scenes.map((s,i)=>i===0?s.durationSec:0);
        for(let i=1;i<end.length;i++)end[i]=end[i-1]+film.scenes[i].durationSec;
        async function getScene(i){
          if(!modules.has(i)){
            const code=Uint8Array.from(atob(film.scenes[i].code),v=>v.charCodeAt(0));
            const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
            try{const module=await import(url);if(typeof module.prepare!=='function'||typeof module.renderFrame!=='function')throw Error('缺少画面模块接口');modules.set(i,module);}finally{URL.revokeObjectURL(url);}
          }
          return modules.get(i);
        }
        async function draw(time,subtitles){
          const t=Math.max(0,Math.min(time,duration));let i=end.findIndex(value=>t<value);if(i<0)i=end.length-1;
          const module=await getScene(i);
          if(activeScene!==i){await module.prepare(canvas);activeScene=i;}
          await module.renderFrame(canvas, t-(i?end[i-1]:0));
          const cue=subtitles?film.captions.find(item=>item.fromSec<=t&&t<item.toSec):null;
          caption.hidden=!cue;caption.textContent=cue?.text??'';
        }
        async function paint(){
          if(rendering||asked)return;
          rendering=true;
          try{await draw(audio.currentTime,showCaptions);}catch{status.textContent='这一幕暂时无法显示';audio.pause();}
          finally{rendering=false;if(!audio.paused&&!asked)raf=requestAnimationFrame(paint);}
        }
        start.onclick=()=>{audio.play().catch(()=>{status.textContent='配音暂时无法播放';});};
        audio.addEventListener('play',()=>{start.hidden=true;cancelAnimationFrame(raf);paint();});
        audio.addEventListener('pause',()=>cancelAnimationFrame(raf));
        audio.addEventListener('ended',()=>{start.hidden=false;});
        audio.addEventListener('seeked',paint);
        audio.addEventListener('error',()=>{status.textContent='配音暂时无法播放';});
        toggle.onclick=()=>{showCaptions=!showCaptions;toggle.setAttribute('aria-pressed',String(showCaptions));paint();};
        let frames=Promise.resolve();
        window.addEventListener('message',event=>{
          const req=event.data;
          if(event.source!==parent||!req||req.type!=='map-film-frame'||typeof req.id!=='string'||!Number.isFinite(req.time))return;
          const reply=(msg,transfer=[])=>parent.postMessage({id:req.id,...msg},'*',transfer);
          asked=true;audio.pause();cancelAnimationFrame(raf);
          frames=frames.then(async()=>{
            try{await draw(req.time,false);const bitmap=await createImageBitmap(canvas);const caption=film.captions.find(item=>item.fromSec<=req.time&&req.time<item.toSec)?.text??'';reply({type:'map-film-bitmap',bitmap,caption},[bitmap]);}
            catch{reply({type:'map-film-frame-error'});}
          });
        });
        window.parent.postMessage({type:'map-film-ready'},'*');
        paint();
        </script></body></html>
        """;
}
