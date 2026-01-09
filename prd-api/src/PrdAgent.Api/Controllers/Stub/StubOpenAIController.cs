using Microsoft.AspNetCore.Mvc;
using System.Collections.Concurrent;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace PrdAgent.Api.Controllers.Stub;

/// <summary>
/// 本机 Stub：OpenAI 兼容接口（用于开发期联调）
/// - baseUrl 推荐配置为：http://localhost:5000/api/v1/stub
///   OpenAICompatUrl 规则会拼到：/api/v1/stub/v1/{capabilityPath}
/// - 支持：
///   - POST /v1/chat/completions（stream=true -> SSE）
///   - POST /v1/images/generations（返回随机颜色图片 URL）
///   - POST /v1/images/edits（multipart：返回“参考图 + 水印” URL）
///   - GET  /assets/{id}.png（返回图片 bytes）
/// </summary>
[ApiController]
[Route("api/v1/stub")]
public class StubOpenAIController : ControllerBase
{
    // 简单内存仓库：开发期足够；避免落库/COS
    private static readonly ConcurrentDictionary<string, (byte[] bytes, DateTimeOffset expireAt)> _imgStore = new();
    private static readonly TimeSpan ImgTtl = TimeSpan.FromMinutes(30);
    private static readonly object _fontLock = new();
    private static FontFamily _bestFontFamily;
    private static bool _bestFontFamilySet;
    private static readonly string[] PreferredCjkFonts = new[]
    {
        // Windows
        "Microsoft YaHei",
        "SimHei",
        "SimSun",
        // macOS
        "PingFang SC",
        "Heiti SC",
        // Linux (常见)
        "Noto Sans CJK SC",
        "Noto Sans SC",
        "Source Han Sans SC"
    };

    [HttpGet("assets/{id}.png")]
    public IActionResult GetAsset(string id)
    {
        var key = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key)) return NotFound();
        if (!_imgStore.TryGetValue(key, out var v)) return NotFound();
        if (v.expireAt <= DateTimeOffset.UtcNow)
        {
            _imgStore.TryRemove(key, out _);
            return NotFound();
        }
        return File(v.bytes, "image/png");
    }

    /// <summary>
    /// OpenAI 兼容：模型列表
    /// 管理后台“平台 -> 可用模型”会调用该接口以拉取模型清单。
    /// </summary>
    [HttpGet("v1/models")]
    public IActionResult ListModels()
    {
        // 返回 OpenAI 常见结构：{ data: [{ id, name, status, domain, task_type, modalities, features }, ...] }
        // 字段尽量贴近 AdminPlatformsController.ModelsApiResponse 所需，便于自动打标签。
        var payload = new
        {
            data = new object[]
            {
                new
                {
                    id = "stub-chat",
                    name = "Stub Chat",
                    status = "Active",
                    domain = "chat",
                    task_type = new[] { "chat" },
                    modalities = new { input_modalities = new[] { "text" }, output_modalities = new[] { "text" } },
                    features = new { tools = new { function_calling = true } }
                },
                new
                {
                    id = "stub-intent",
                    name = "Stub Intent",
                    status = "Active",
                    domain = "chat",
                    task_type = new[] { "intent" },
                    modalities = new { input_modalities = new[] { "text" }, output_modalities = new[] { "text" } },
                    features = new { tools = new { function_calling = false } }
                },
                new
                {
                    id = "stub-vision",
                    name = "Stub Vision",
                    status = "Active",
                    domain = "vision",
                    task_type = new[] { "vision" },
                    modalities = new { input_modalities = new[] { "text", "image" }, output_modalities = new[] { "text" } },
                    features = new { tools = new { function_calling = false } }
                },
                new
                {
                    id = "stub-image",
                    name = "Stub Image",
                    status = "Active",
                    domain = "image",
                    task_type = new[] { "image_generation" },
                    modalities = new { input_modalities = new[] { "text", "image" }, output_modalities = new[] { "image" } },
                    features = new { tools = new { function_calling = false } }
                }
            }
        };
        return Ok(payload);
    }

    [HttpPost("v1/chat/completions")]
    public async Task ChatCompletions([FromBody] StubChatRequest request, CancellationToken ct)
    {
        var requestStartTime = DateTime.UtcNow;
        Console.WriteLine($"[Stub] 接收到请求: {requestStartTime:HH:mm:ss.fff}");
        
        var model = (request?.Model ?? "stub-chat").Trim();
        var stream = request?.Stream ?? false;
        var content = ExtractUserText(request);
        if (string.IsNullOrWhiteSpace(content)) content = "（empty）";

        var mode = InferMode(model, request);
        var reply = mode switch
        {
            "intent" => $"[stub-intent]\nintent=demo_intent\ntext={content}",
            "vision" => $"[stub-vision]\nvision_ok=true\ntext={content}",
            _ => $"# [stub-chat]\n{content}"
        };

        if (!stream)
        {
            var payload = new
            {
                id = "stubcmpl_" + Guid.NewGuid().ToString("N"),
                @object = "chat.completion",
                created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                model,
                choices = new[]
                {
                    new
                    {
                        index = 0,
                        message = new { role = "assistant", content = reply },
                        finish_reason = "stop"
                    }
                }
            };
            Response.ContentType = "application/json";
            await Response.WriteAsync(JsonSerializer.Serialize(payload), ct);
            return;
        }

        Response.StatusCode = 200;
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";
        Response.ContentType = "text/event-stream; charset=utf-8";

        var id = "stubcmpl_" + Guid.NewGuid().ToString("N");
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        Console.WriteLine($"[Stub] 准备发送 role chunk: {DateTime.UtcNow:HH:mm:ss.fff}");
        
        // 先发 role（不延迟）
        await WriteSseAsync(new
        {
            id,
            @object = "chat.completion.chunk",
            created,
            model,
            choices = new[] { new { index = 0, delta = new { role = "assistant" }, finish_reason = (string?)null } }
        }, ct, addDelay: false);
        
        var firstTokenTime = DateTime.UtcNow;
        var ttft = (firstTokenTime - requestStartTime).TotalMilliseconds;
        Console.WriteLine($"[Stub] role chunk 已发送并 flush: {firstTokenTime:HH:mm:ss.fff}");
        Console.WriteLine($"[Stub] 首字延迟 (TTFT): {ttft:F1}ms");

        // 分段输出内容（按逗号分隔，模拟大模型行为，每次延迟 10ms）
        var partsList = SplitByComma(reply).ToList();
        Console.WriteLine($"[Stub] 开始发送 {partsList.Count} 个 content chunks: {DateTime.UtcNow:HH:mm:ss.fff}");
        
        var chunkIndex = 0;
        foreach (var part in partsList)
        {
            await WriteSseAsync(new
            {
                id,
                @object = "chat.completion.chunk",
                created,
                model,
                choices = new[] { new { index = 0, delta = new { content = part }, finish_reason = (string?)null } }
            }, ct, addDelay: true);
            
            // 只打印前3个和最后1个chunk的时间
            if (chunkIndex < 3 || chunkIndex == partsList.Count - 1)
            {
                Console.WriteLine($"[Stub] chunk[{chunkIndex}] 已发送: {DateTime.UtcNow:HH:mm:ss.fff}");
        }
            chunkIndex++;
        }
        
        Console.WriteLine($"[Stub] 所有 content chunks 发送完毕: {DateTime.UtcNow:HH:mm:ss.fff}");

        // 结束（不延迟）
        await WriteSseAsync(new
        {
            id,
            @object = "chat.completion.chunk",
            created,
            model,
            choices = new[] { new { index = 0, delta = new { }, finish_reason = "stop" } }
        }, ct, addDelay: false);
        await Response.WriteAsync("data: [DONE]\n\n", ct);
        await Response.Body.FlushAsync(ct);
        
        var requestEndTime = DateTime.UtcNow;
        var totalTime = (requestEndTime - requestStartTime).TotalMilliseconds;
        Console.WriteLine($"[Stub] 请求完成，总时长: {totalTime:F1}ms");
    }

    [HttpPost("v1/images/generations")]
    public IActionResult ImageGenerations([FromBody] StubImageGenRequest request)
    {
        var size = NormalizeSize(request?.Size);
        var (w, h) = ParseSizeOrDefault(size, 1024, 1024);
        var n = Math.Clamp(request?.N ?? 1, 1, 20);
        var data = new List<object>(n);
        for (var i = 0; i < n; i++)
        {
            var color = RandomColor();
            var wm = BuildCenterWatermarkText(request?.Prompt, n <= 1 ? null : i + 1, n <= 1 ? null : n);
            var bytes = RenderSolidPng(w, h, color, watermarkText: wm);
            var id = PutImage(bytes);
            var url = BuildAssetUrl(id);
            data.Add(new { url });
        }

        var payload = new
        {
            created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            data
        };
        return Ok(payload);
    }

    [HttpPost("v1/images/edits")]
    [RequestSizeLimit(12 * 1024 * 1024)]
    public async Task<IActionResult> ImageEdits(CancellationToken ct)
    {
        // OpenAI compatible multipart: image(file) + prompt + n + size + response_format
        if (!Request.HasFormContentType) return BadRequest(new { error = new { message = "multipart/form-data required" } });
        var form = await Request.ReadFormAsync(ct);
        var file = form.Files.GetFile("image") ?? form.Files.FirstOrDefault();
        if (file == null || file.Length <= 0) return BadRequest(new { error = new { message = "image is required" } });

        byte[] inputBytes;
        await using (var fs = file.OpenReadStream())
        {
            using var ms = new MemoryStream();
            await fs.CopyToAsync(ms, ct);
            inputBytes = ms.ToArray();
        }

        var sizeRaw = form["size"].ToString();
        var size = NormalizeSize(sizeRaw);
        var (w, h) = ParseSizeOrDefault(size, 1024, 1024);
        var nRaw = form["n"].ToString();
        var n = int.TryParse(nRaw, out var nn) ? nn : 1;
        n = Math.Clamp(n, 1, 20);
        var prompt = form["prompt"].ToString();
        var watermarkBase = string.IsNullOrWhiteSpace(prompt) ? "PRD STUB" : $"PRD STUB | {prompt}";
        var data = new List<object>(n);
        for (var i = 0; i < n; i++)
        {
            var watermark = n <= 1 ? watermarkBase : $"{watermarkBase} | #{i + 1}";
            var outBytes = TryRenderWatermarkedFromInput(inputBytes, w, h, watermark);
            var id = PutImage(outBytes);
            var url = BuildAssetUrl(id);
            data.Add(new { url });
        }

        var payload = new
        {
            created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            data
        };
        return Ok(payload);
    }

    private string BuildAssetUrl(string id)
    {
        var host = $"{Request.Scheme}://{Request.Host}";
        return $"{host}/api/v1/stub/assets/{id}.png";
    }

    private static string PutImage(byte[] bytes)
    {
        var id = Guid.NewGuid().ToString("N");
        _imgStore[id] = (bytes, DateTimeOffset.UtcNow.Add(ImgTtl));
        // best-effort: 轻量清理过期项（避免无限增长）
        if (_imgStore.Count > 256)
        {
            foreach (var kv in _imgStore)
            {
                if (kv.Value.expireAt <= DateTimeOffset.UtcNow) _imgStore.TryRemove(kv.Key, out _);
            }
        }
        return id;
    }

    private static string NormalizeSize(string? s)
    {
        var raw = (s ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)) return "1024x1024";
        raw = raw.Replace("*", "x", StringComparison.OrdinalIgnoreCase).Replace("×", "x");
        return raw;
    }

    private static (int w, int h) ParseSizeOrDefault(string? s, int defW, int defH)
    {
        var raw = (s ?? string.Empty).Trim();
        var m = Regex.Match(raw, @"^(?<w>\d{2,5})x(?<h>\d{2,5})$", RegexOptions.IgnoreCase);
        if (!m.Success) return (defW, defH);
        var w = int.TryParse(m.Groups["w"].Value, out var ww) ? ww : defW;
        var h = int.TryParse(m.Groups["h"].Value, out var hh) ? hh : defH;
        w = Math.Clamp(w, 64, 4096);
        h = Math.Clamp(h, 64, 4096);
        return (w, h);
    }

    private static Color RandomColor()
    {
        var r = (byte)Random.Shared.Next(30, 230);
        var g = (byte)Random.Shared.Next(30, 230);
        var b = (byte)Random.Shared.Next(30, 230);
        return new Rgba32(r, g, b, 255);
    }

    private static byte[] RenderSolidPng(int w, int h, Color color, string? watermarkText)
    {
        using var img = new Image<Rgba32>(w, h);
        img.Mutate(ctx => ctx.BackgroundColor(color));
        if (!string.IsNullOrWhiteSpace(watermarkText))
        {
            DrawCenterWatermark(img, watermarkText);
        }
        DrawInnerFrame(img, colorHint: color);
        using var ms = new MemoryStream();
        img.SaveAsPng(ms);
        return ms.ToArray();
    }

    private static byte[] TryRenderWatermarkedFromInput(byte[] inputBytes, int w, int h, string watermarkText)
    {
        // 尽量加载用户图并缩放；失败则退回纯色图（仍带水印）
        try
        {
            using var input = Image.Load<Rgba32>(inputBytes);
            // contain（计算缩放与居中偏移）
            var scale = Math.Min((double)w / input.Width, (double)h / input.Height);
            var dw = Math.Max(1, (int)Math.Round(input.Width * scale));
            var dh = Math.Max(1, (int)Math.Round(input.Height * scale));
            var dx = Math.Max(0, (w - dw) / 2);
            var dy = Math.Max(0, (h - dh) / 2);

            input.Mutate(ctx => ctx.Resize(new ResizeOptions
            {
                Size = new Size(dw, dh),
                Mode = ResizeMode.Stretch,
                Sampler = KnownResamplers.Bicubic
            }));

            using var canvas = new Image<Rgba32>(w, h);
            canvas.Mutate(ctx =>
            {
                ctx.BackgroundColor(new Rgba32(0, 0, 0, 255));
                ctx.DrawImage(input, new Point(dx, dy), 1f);
            });
            DrawWatermark(canvas, watermarkText);
            DrawInnerFrame(canvas, colorHint: null);

            using var ms = new MemoryStream();
            canvas.SaveAsPng(ms);
            return ms.ToArray();
        }
        catch
        {
            var color = RandomColor();
            return RenderSolidPng(w, h, color, watermarkText);
        }
    }

    private static void DrawWatermark(Image<Rgba32> img, string text)
    {
        // 右下角水印：半透明底 + 文本（用于 image edits，更“像真实服务”）
        var w = img.Width;
        var h = img.Height;
        var pad = Math.Max(10, Math.Min(w, h) / 50);
        var fontSize = Math.Max(12, Math.Min(w, h) / 28);
        var font = CreateBestEffortFont(fontSize, FontStyle.Bold);

        var options = new TextOptions(font);
        var measured = TextMeasurer.MeasureSize(text, options);
        var boxW = (int)Math.Ceiling(measured.Width) + pad * 2;
        var boxH = (int)Math.Ceiling(measured.Height) + pad * 2;
        var x = Math.Max(0, w - boxW - pad);
        var y = Math.Max(0, h - boxH - pad);

        var bg = new Rgba32(0, 0, 0, 130);
        var fg = new Rgba32(255, 255, 255, 220);

        img.Mutate(ctx =>
        {
            ctx.Fill(bg, new RectangleF(x, y, boxW, boxH));
            ctx.DrawText(text, font, fg, new PointF(x + pad, y + pad));
        });
    }

    private static void DrawCenterWatermark(Image<Rgba32> img, string text)
    {
        // 中间水印：只写一块（不铺满），用于快速验证“prompt 是否透传 + 返回容器是否遮挡”
        var w = img.Width;
        var h = img.Height;
        var min = Math.Max(1, Math.Min(w, h));
        var pad = Math.Max(12, min / 40);
        var fontSize = Math.Max(16, Math.Min(64, min / 18));
        var font = CreateBestEffortFont(fontSize, FontStyle.Bold);

        var lines = (text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Take(3)
            .ToList();
        if (lines.Count == 0) lines.Add("PRD STUB");

        var options = new TextOptions(font);
        var sizes = lines.Select(x => TextMeasurer.MeasureSize(x, options)).ToList();
        var textW = (float)Math.Ceiling(sizes.Max(s => s.Width));
        var textH = (float)Math.Ceiling(sizes.Sum(s => s.Height));

        // 上限：避免水印太大遮住画面
        var maxBoxW = (float)(w * 0.72);
        if (textW > maxBoxW)
        {
            // 简单兜底：按宽度压缩字号（最小 14）
            var scale = maxBoxW / Math.Max(1, textW);
            var fs2 = Math.Max(14, (int)Math.Floor(fontSize * scale));
            font = CreateBestEffortFont(fs2, FontStyle.Bold);
            options = new TextOptions(font);
            sizes = lines.Select(x => TextMeasurer.MeasureSize(x, options)).ToList();
            textW = (float)Math.Ceiling(sizes.Max(s => s.Width));
            textH = (float)Math.Ceiling(sizes.Sum(s => s.Height));
        }

        var boxW = textW + pad * 2;
        var boxH = textH + pad * 2;
        var x0 = (w - boxW) / 2f;
        var y0 = (h - boxH) / 2f;

        var bg = new Rgba32(0, 0, 0, 110);
        var fg = new Rgba32(255, 255, 255, 228);
        var stroke = new Rgba32(255, 255, 255, 90);
        var stroke2 = new Rgba32(0, 0, 0, 70);

        img.Mutate(ctx =>
        {
            ctx.Fill(bg, new RectangleF(x0, y0, boxW, boxH));
            // 轻描边让不同底色都可读
            ctx.Draw(stroke2, 2f, new RectangularPolygon(x0, y0, boxW, boxH));
            ctx.Draw(stroke, 1f, new RectangularPolygon(x0 + 1, y0 + 1, Math.Max(1, boxW - 2), Math.Max(1, boxH - 2)));

            var y = y0 + pad;
            for (var i = 0; i < lines.Count; i++)
            {
                var line = lines[i];
                var sz = sizes[i];
                var lx = x0 + (boxW - sz.Width) / 2f;
                ctx.DrawText(line, font, fg, new PointF(lx, y));
                y += sz.Height;
            }
        });
    }

    private static void DrawInnerFrame(Image<Rgba32> img, Color? colorHint)
    {
        // 内置边框：用于验证“返回图片容器是否被遮挡/裁切”
        var w = img.Width;
        var h = img.Height;
        var min = Math.Max(1, Math.Min(w, h));
        var inset = Math.Max(6, min / 70);
        var thick = Math.Max(4f, min / 160f);

        var rect = new RectangularPolygon(inset, inset, Math.Max(1, w - inset * 2), Math.Max(1, h - inset * 2));
        var baseColor = TryGetColorHint(img, colorHint);
        var inv = Invert(baseColor);
        // 双层强对比：外层用“反色”全不透明，内层再补一个“黑/白”防止反色落到灰区不够显眼
        var bw = ChooseBlackOrWhite(inv);
        var outer = new Rgba32(inv.R, inv.G, inv.B, 255);
        var inner = new Rgba32(bw.R, bw.G, bw.B, 255);
        img.Mutate(ctx =>
        {
            ctx.Draw(outer, thick + 2f, rect);
            ctx.Draw(inner, thick, new RectangularPolygon(inset + 2, inset + 2, Math.Max(1, w - (inset + 2) * 2), Math.Max(1, h - (inset + 2) * 2)));
        });
    }

    private static Rgba32 TryGetColorHint(Image<Rgba32> img, Color? colorHint)
    {
        try
        {
            if (colorHint.HasValue)
            {
                var c = colorHint.Value;
                // Color -> RGBA32
                return c.ToPixel<Rgba32>();
            }

            // edits 场景：从图像内容采样（九宫格）估一个“主背景色”
            var w = img.Width;
            var h = img.Height;
            if (w <= 0 || h <= 0) return new Rgba32(0, 0, 0, 255);

            var xs = new[] { w / 6, w / 2, (w * 5) / 6 };
            var ys = new[] { h / 6, h / 2, (h * 5) / 6 };
            long r = 0, g = 0, b = 0, n = 0;
            for (var iy = 0; iy < ys.Length; iy++)
            {
                for (var ix = 0; ix < xs.Length; ix++)
                {
                    var x = Math.Clamp(xs[ix], 0, Math.Max(0, w - 1));
                    var y = Math.Clamp(ys[iy], 0, Math.Max(0, h - 1));
                    var p = img[x, y];
                    r += p.R;
                    g += p.G;
                    b += p.B;
                    n++;
                }
            }
            if (n <= 0) return new Rgba32(0, 0, 0, 255);
            return new Rgba32((byte)(r / n), (byte)(g / n), (byte)(b / n), 255);
        }
        catch
        {
            return new Rgba32(0, 0, 0, 255);
        }
    }

    private static Rgba32 Invert(Rgba32 c) => new((byte)(255 - c.R), (byte)(255 - c.G), (byte)(255 - c.B), 255);

    private static Rgba32 ChooseBlackOrWhite(Rgba32 c)
    {
        // 亮度阈值：高亮背景用黑，暗背景用白
        var lum = (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0;
        return lum >= 0.55 ? new Rgba32(0, 0, 0, 255) : new Rgba32(255, 255, 255, 255);
    }

    private static string BuildCenterWatermarkText(string? prompt, int? index, int? total)
    {
        var p = (prompt ?? string.Empty).Trim();
        p = Regex.Replace(p, @"\s+", " ");
        if (p.Length > 80) p = p[..80] + "…";

        var head = "PRD STUB";
        if (index.HasValue && total.HasValue && total.Value > 1)
        {
            head = $"{head} #{index.Value}/{total.Value}";
        }

        if (string.IsNullOrWhiteSpace(p)) return head;
        // 两行：第一行固定标识，第二行带 prompt（不铺满）
        return $"{head}\n{p}";
    }

    private static FontFamily GetBestFontFamily()
    {
        if (_bestFontFamilySet) return _bestFontFamily;
        lock (_fontLock)
        {
            if (_bestFontFamilySet) return _bestFontFamily;

            var families = SystemFonts.Collection.Families?.ToList() ?? new List<FontFamily>();
            if (families.Count == 0)
            {
                // 极端兜底：让 SystemFonts 自己决定（不会为空，但可能不支持 CJK）
                _bestFontFamily = SystemFonts.CreateFont("Arial", 12).Family;
                _bestFontFamilySet = true;
                return _bestFontFamily;
            }

            foreach (var name in PreferredCjkFonts)
            {
                var hit = families.FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrWhiteSpace(hit.Name))
                {
                    _bestFontFamily = hit;
                    _bestFontFamilySet = true;
                    return _bestFontFamily;
                }
            }

            _bestFontFamily = families[0];
            _bestFontFamilySet = true;
            return _bestFontFamily;
        }
    }

    private static Font CreateBestEffortFont(float size, FontStyle style)
    {
        try
        {
            var fam = GetBestFontFamily();
            return new Font(fam, size, style);
        }
        catch
        {
            return SystemFonts.CreateFont("Arial", size, style);
        }
    }

    private async Task WriteSseAsync(object obj, CancellationToken ct, bool addDelay = false)
    {
        // 模拟大模型延迟：先延迟再写入（10ms，既能看到流式效果又不会太慢）
        if (addDelay)
    {
            await Task.Delay(10, ct);
        }
        
        var json = JsonSerializer.Serialize(obj);
        await Response.WriteAsync("data: " + json + "\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private static IEnumerable<string> SplitIntoChunks(string s, int chunkSize)
    {
        var raw = s ?? string.Empty;
        if (raw.Length <= chunkSize) return new[] { raw };
        var list = new List<string>();
        for (var i = 0; i < raw.Length; i += chunkSize)
        {
            var n = Math.Min(chunkSize, raw.Length - i);
            list.Add(raw.Substring(i, n));
        }
        return list;
    }

    /// <summary>
    /// 按逗号分隔文本，模拟大模型流式返回行为
    /// </summary>
    private static IEnumerable<string> SplitByComma(string s)
    {
        var raw = s ?? string.Empty;
        if (string.IsNullOrEmpty(raw)) return new[] { raw };
        
        var parts = new List<string>();
        var lastIndex = 0;
        
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] == ',' || raw[i] == '，') // 支持中英文逗号
            {
                // 包含逗号本身
                parts.Add(raw.Substring(lastIndex, i - lastIndex + 1));
                lastIndex = i + 1;
            }
        }
        
        // 添加最后一段（如果有）
        if (lastIndex < raw.Length)
        {
            parts.Add(raw.Substring(lastIndex));
        }
        
        // 如果没有逗号，按固定长度分段（兼容无标点文本）
        if (parts.Count == 0 || (parts.Count == 1 && parts[0].Length > 50))
        {
            return SplitIntoChunks(raw, 24);
        }
        
        return parts;
    }

    private static string ExtractUserText(StubChatRequest? req)
    {
        if (req?.Messages == null) return "";
        // 取最后一个 user 内容（兼容 string 或 array）
        for (var i = req.Messages.Count - 1; i >= 0; i--)
        {
            var m = req.Messages[i];
            if (!string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase)) continue;
            if (m.Content.ValueKind == JsonValueKind.String) return m.Content.GetString() ?? "";
            if (m.Content.ValueKind == JsonValueKind.Array)
            {
                // 兼容 content=[{type:"text",text:"..."},{type:"image_url",...}]
                foreach (var part in m.Content.EnumerateArray())
                {
                    if (part.ValueKind != JsonValueKind.Object) continue;
                    if (part.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "text")
                    {
                        if (part.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String)
                        {
                            return tx.GetString() ?? "";
                        }
                    }
                }
            }
        }
        return "";
    }

    private static string InferMode(string model, StubChatRequest? req)
    {
        var m = (model ?? "").Trim().ToLowerInvariant();
        if (m.Contains("intent")) return "intent";
        if (m.Contains("vision")) return "vision";
        // 若 message content 里含 image_url，也视为 vision
        if (req?.Messages != null)
        {
            foreach (var msg in req.Messages)
            {
                if (msg.Content.ValueKind != JsonValueKind.Array) continue;
                foreach (var part in msg.Content.EnumerateArray())
                {
                    if (part.ValueKind != JsonValueKind.Object) continue;
                    if (part.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "image_url")
                    {
                        return "vision";
                    }
                }
            }
        }
        return "chat";
    }
}

public sealed class StubChatRequest
{
    public string? Model { get; set; }
    public bool Stream { get; set; }
    public List<StubChatMessage> Messages { get; set; } = new();
}

public sealed class StubChatMessage
{
    public string Role { get; set; } = "user";
    public JsonElement Content { get; set; }
}

public sealed class StubImageGenRequest
{
    public string? Model { get; set; }
    public string? Prompt { get; set; }
    public int? N { get; set; }
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; }
    public bool? InitImageProvided { get; set; }
    public bool? InitImageUsed { get; set; }
}


