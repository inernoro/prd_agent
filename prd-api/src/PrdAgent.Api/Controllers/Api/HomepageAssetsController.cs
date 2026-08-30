using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 首页资源（四张快捷卡背景 + Agent 封面图/视频）
/// Slot 命名：`card.{id}` / `agent.{agentKey}.image` / `agent.{agentKey}.video`
/// COS 路径：`icon/homepage/{slot-with-dots-as-slashes}.{ext}`
/// </summary>
[ApiController]
[Route("api/assets/homepage")]
[Authorize]
[AdminController("assets", AdminPermissionCatalog.AssetsRead, WritePermission = AdminPermissionCatalog.AssetsWrite)]
public class HomepageAssetsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<HomepageAssetsController> _logger;
    private readonly IAssetStorage _assetStorage;
    private readonly HomepageAssetCopier _copier;

    // 允许 a-z0-9._- ，首字符必须字母/数字；点号用于分段（card.marketplace / agent.prd-agent.image）
    private static readonly Regex SlotRegex = new(@"^[a-z0-9][a-z0-9._\-]{0,127}$", RegexOptions.Compiled);
    // Agent 封面/视频 slot 解析（与老 CDN 目录 icon/backups/agent/{key}.{ext} 对齐）
    private static readonly Regex AgentImageSlotRegex = new(@"^agent\.(.+)\.image$", RegexOptions.Compiled);
    private static readonly Regex AgentVideoSlotRegex = new(@"^agent\.(.+)\.video$", RegexOptions.Compiled);
    // Hero 顶部 banner slot：`hero.{id}` → 写入老路径 `icon/title/{id}.{ext}`
    private static readonly Regex HeroSlotRegex = new(@"^hero\.(.+)$", RegexOptions.Compiled);
    private const long MaxUploadBytes = 20 * 1024 * 1024; // 20MB：图片 + 短视频

    public HomepageAssetsController(
        MongoDbContext db,
        ILogger<HomepageAssetsController> logger,
        IAssetStorage assetStorage,
        HomepageAssetCopier copier)
    {
        _db = db;
        _logger = logger;
        _assetStorage = assetStorage;
        _copier = copier;
    }

    private static (bool ok, string? error, string normalized) NormalizeSlot(string slot)
    {
        var s = (slot ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) return (false, "slot 不能为空", s);
        if (s.Length > 128) return (false, "slot 不能超过 128 字符", s);
        if (s.Contains('/') || s.Contains('\\')) return (false, "slot 不允许包含 / 或 \\", s);
        if (s.Contains("..", StringComparison.Ordinal)) return (false, "slot 不允许包含 ..", s);
        if (!SlotRegex.IsMatch(s)) return (false, "slot 仅允许小写字母/数字/点/下划线/中划线，且需以字母或数字开头", s);
        if (s.StartsWith('.') || s.EndsWith('.')) return (false, "slot 不允许以 . 开头或结尾", s);
        return (true, null, s);
    }

    private static string ExtractExtensionFromFileName(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return "png";
        var ext = Path.GetExtension(fileName)?.TrimStart('.').ToLowerInvariant();
        return string.IsNullOrWhiteSpace(ext) ? "png" : ext;
    }

    private static string GuessExtensionFromMime(string mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        if (m.Contains("gif")) return "gif";
        if (m.Contains("png")) return "png";
        if (m.Contains("webp")) return "webp";
        if (m.Contains("svg")) return "svg";
        if (m.Contains("jpeg") || m.Contains("jpg")) return "jpg";
        if (m.Contains("mp4")) return "mp4";
        if (m.Contains("webm")) return "webm";
        if (m.Contains("quicktime") || m.Contains("mov")) return "mov";
        return "png";
    }

    private static string GuessMimeByExt(string ext)
    {
        var e = (ext ?? string.Empty).Trim().ToLowerInvariant().TrimStart('.');
        return e switch
        {
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            _ => "application/octet-stream"
        };
    }

    private static string BuildObjectKey(string slot, string ext)
    {
        // Agent 封面/视频：写回老 CDN 目录 `icon/backups/agent/{key}.{ext}`，
        // 保证设置页上传的就是老代码硬编码读取的同一份文件（图片 `.png/.jpg/.webp`，视频 `.mp4/.webm`）。
        var imgM = AgentImageSlotRegex.Match(slot);
        if (imgM.Success) return $"icon/backups/agent/{imgM.Groups[1].Value}.{ext}";
        var vidM = AgentVideoSlotRegex.Match(slot);
        if (vidM.Success) return $"icon/backups/agent/{vidM.Groups[1].Value}.{ext}";
        // 首页顶部 Hero banner：写回老路径 `icon/title/{id}.{ext}`
        var heroM = HeroSlotRegex.Match(slot);
        if (heroM.Success) return $"icon/title/{heroM.Groups[1].Value}.{ext}";
        // 其他 slot（如 card.*）：沿用 icon/homepage/{slot 点号转斜线}.{ext}
        var path = slot.Replace('.', '/');
        return $"icon/homepage/{path}.{ext}";
    }

    private static HomepageAssetDto ToDto(HomepageAsset x) => new()
    {
        Slot = x.Slot,
        Url = x.Url,
        Mime = x.Mime,
        SizeBytes = x.SizeBytes,
        UpdatedAt = x.UpdatedAt,
        Prompt = x.Prompt
    };

    /// <summary>
    /// 列表：返回所有已上传的首页资源。
    /// </summary>
    [HttpGet("list")]
    [ProducesResponseType(typeof(ApiResponse<List<HomepageAssetDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var list = await _db.HomepageAssets.Find(_ => true).SortBy(x => x.Slot).ToListAsync(ct);
        var dto = list.Select(ToDto).ToList();
        return Ok(ApiResponse<List<HomepageAssetDto>>.Ok(dto));
    }

    /// <summary>
    /// 上传/替换：slot + 文件，按 slot 覆盖写入。
    /// </summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<HomepageAssetDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Upload([FromForm] string slot, [FromForm] IFormFile file, CancellationToken ct)
    {
        var adminId = this.GetRequiredUserId();

        var (ok, err, slotNorm) = NormalizeSlot(slot);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "slot 不合法"));

        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, $"文件过大（上限 {MaxUploadBytes / 1024 / 1024}MB）"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var mime = (file.ContentType ?? string.Empty).Trim();
        var ext = ExtractExtensionFromFileName(file.FileName);
        if (string.IsNullOrWhiteSpace(ext) || ext == "png")
        {
            var fromMime = GuessExtensionFromMime(mime);
            if (!string.IsNullOrWhiteSpace(fromMime)) ext = fromMime;
        }
        if (string.IsNullOrWhiteSpace(mime) || mime == "application/octet-stream")
        {
            mime = GuessMimeByExt(ext);
        }

        var objectKey = BuildObjectKey(slotNorm, ext);
        await _assetStorage.UploadToKeyAsync(objectKey, bytes, mime, ct);
        var url = _assetStorage.BuildUrlForKey(objectKey);

        var now = DateTime.UtcNow;
        var existing = await _db.HomepageAssets.Find(x => x.Slot == slotNorm).Limit(1).FirstOrDefaultAsync(ct);
        if (existing == null)
        {
            var rec = new HomepageAsset
            {
                Id = Guid.NewGuid().ToString("N"),
                Slot = slotNorm,
                RelativePath = objectKey,
                Url = url,
                Mime = mime,
                SizeBytes = bytes.LongLength,
                CreatedByAdminId = adminId,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _db.HomepageAssets.InsertOneAsync(rec, cancellationToken: ct);
            _logger.LogInformation("Uploaded homepage asset: slot={Slot} ext={Ext} size={Size}", slotNorm, ext, bytes.LongLength);
            return Ok(ApiResponse<HomepageAssetDto>.Ok(ToDto(rec)));
        }

        // 如扩展名变化，尝试清理旧 COS 对象（忽略错误）
        if (!string.Equals(existing.RelativePath, objectKey, StringComparison.Ordinal))
        {
            try { await _assetStorage.DeleteByKeyAsync(existing.RelativePath, ct); }
            catch (Exception ex) { _logger.LogWarning("Failed to delete old homepage asset {Key}: {Msg}", existing.RelativePath, ex.Message); }
        }

        await _db.HomepageAssets.UpdateOneAsync(
            x => x.Id == existing.Id,
            Builders<HomepageAsset>.Update
                .Set(x => x.RelativePath, objectKey)
                .Set(x => x.Url, url)
                .Set(x => x.Mime, mime)
                .Set(x => x.SizeBytes, bytes.LongLength)
                // 手工上传覆盖掉 AI 生成的那版时，旧提示词就不再描述这张图了，一并清掉
                .Set(x => x.Prompt, (string?)null)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        existing.Prompt = null;
        existing.RelativePath = objectKey;
        existing.Url = url;
        existing.Mime = mime;
        existing.SizeBytes = bytes.LongLength;
        existing.UpdatedAt = now;

        _logger.LogInformation("Replaced homepage asset: slot={Slot} ext={Ext} size={Size}", slotNorm, ext, bytes.LongLength);
        return Ok(ApiResponse<HomepageAssetDto>.Ok(ToDto(existing)));
    }

    /// <summary>
    /// 认领：把一次生图任务的产物挂到某个 slot 上（管理端「首页预览图」的生成落地口）。
    ///
    /// **先把字节复制进我们自己的存储，再写槽位**。早先这里是直接引用生图产物的地址，
    /// 理由是「Worker 存的是内容寻址对象，地址恒定」——但那只在 run 绑了工作区时成立。
    /// 首页配图这条 run 没有工作区，Worker 的落存整段跳过，`Url` 就是供应商返回的地址，
    /// 常带签名、有有效期：生成当天首页正常，等它过期，未登录访客看到的是一排裂图，
    /// 而管理端不报错。复制的代价是七张图多存一份，换来一条能一句话说清的不变量：
    /// 首页槽位引用的对象一定是我们自己存的。
    /// </summary>
    [HttpPost("adopt-image-run")]
    [ProducesResponseType(typeof(ApiResponse<HomepageAssetDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> AdoptImageRun([FromBody] AdoptImageRunRequest req, CancellationToken ct)
    {
        var adminId = this.GetRequiredUserId();

        var (ok, err, slotNorm) = NormalizeSlot(req?.Slot ?? string.Empty);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "slot 不合法"));

        var runId = (req?.RunId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId).Limit(1).FirstOrDefaultAsync(ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "生图任务不存在"));
        // 只有任务发起人能把它的产物挂到首页 slot 上，避免拿到别人的 runId 就能改首页
        if (!string.Equals(run.OwnerAdminId, adminId, StringComparison.Ordinal))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "生图任务不存在"));

        var itemIndex = req?.ItemIndex ?? 0;
        var imageIndex = req?.ImageIndex ?? 0;
        var item = await _db.ImageGenRunItems
            .Find(x => x.RunId == runId && x.ItemIndex == itemIndex && x.ImageIndex == imageIndex)
            .Limit(1)
            .FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "生图结果不存在"));
        if (item.Status != ImageGenRunItemStatus.Done)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "这张图还没生成完成，不能挂到首页"));
        // 出图了却没有地址：调用方按 b64_json 发的、又没有 workspace 落资产，产物只在 base64 里。
        // 这里引用的是 URL，认领不了——说清楚是哪一步的问题，别报成「还没生成完成」。
        if (string.IsNullOrWhiteSpace(item.Url))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "这张图只有 base64、没有可引用的地址，挂不到首页。发起生图时请用 responseFormat=url"));

        // 把字节取回来存进我们自己的存储。mime / 大小都以真正存下来的那份为准——
        // 不再从资产记录或 URL 后缀去猜：猜错只是标签不对，而这里拿到的是实物。
        HomepageAssetCopier.Copied copied;
        try
        {
            copied = await _copier.CopyAsync(item.Url!, ext => BuildObjectKey(slotNorm, ext), ct);
        }
        catch (HomepageAssetCopier.CopyFailedException ex)
        {
            _logger.LogWarning("Adopt copy failed: slot={Slot} run={Run} msg={Msg}", slotNorm, runId, ex.Message);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        var imageUrl = copied.Url;
        var mime = copied.Mime;
        var sizeBytes = copied.SizeBytes;

        var prompt = (req?.Prompt ?? item.Prompt ?? string.Empty).Trim();
        if (prompt.Length > 4000) prompt = prompt[..4000];

        var now = DateTime.UtcNow;
        // 这一句只是读，但它排在上传**之后**——被取消的话，下面那两处 CancellationToken.None
        // 的写库一句都跑不到，等于白保护：字节已经落在存储上（同 key 时线上那张图已经被换掉），
        // 库里还是旧的。上传之后的每一步都不再看请求还连不连着。
        var existing = await _db.HomepageAssets.Find(x => x.Slot == slotNorm).Limit(1)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (existing == null)
        {
            var rec = new HomepageAsset
            {
                Id = Guid.NewGuid().ToString("N"),
                Slot = slotNorm,
                RelativePath = copied.ObjectKey,
                Url = imageUrl,
                Mime = mime,
                SizeBytes = sizeBytes,
                Prompt = string.IsNullOrWhiteSpace(prompt) ? null : prompt,
                CreatedByAdminId = adminId,
                CreatedAt = now,
                UpdatedAt = now
            };
            // 字节已经上传完了，这一步是把它认下来。用 CancellationToken.None：管理员这时
            // 关掉标签页的话，对象留在存储里而库里没有记录，这次认领白做还留个孤儿。
            await _db.HomepageAssets.InsertOneAsync(rec, cancellationToken: CancellationToken.None);
            _logger.LogInformation("Adopted image-gen result into homepage slot={Slot} run={Run}", slotNorm, runId);
            return Ok(ApiResponse<HomepageAssetDto>.Ok(ToDto(rec)));
        }

        // 旧对象只在「确实换了一个 key」时才删。扩展名没变时新旧 key 相同，此刻那个 key 上
        // 躺着的已经是刚上传的新图——照删就是把自己刚存的东西删掉，首页当场裂。
        // **删除还必须排在库里切换成功之后**：先删后写的话，中间一旦取消或写库失败，
        // 记录还指着一个已经不存在的对象，首页那一格就此变成裂图，而这次认领是失败的。
        var staleKey = string.Equals(existing.RelativePath, copied.ObjectKey, StringComparison.Ordinal)
            ? string.Empty
            : existing.RelativePath;

        await _db.HomepageAssets.UpdateOneAsync(
            x => x.Id == existing.Id,
            Builders<HomepageAsset>.Update
                .Set(x => x.RelativePath, copied.ObjectKey)
                .Set(x => x.Url, imageUrl)
                .Set(x => x.Mime, mime)
                .Set(x => x.SizeBytes, sizeBytes)
                .Set(x => x.Prompt, string.IsNullOrWhiteSpace(prompt) ? null : prompt)
                .Set(x => x.UpdatedAt, now),
            // 同上，也是 None。这条尤其不能半路取消：新旧 key 相同时，存储上那个对象已经被
            // 覆盖成新图了，库里却还留着旧图的 mime / 大小 / 提示词，页面与记录当场对不上。
            cancellationToken: CancellationToken.None);

        // 切换已经落库，这时候删旧对象才安全；删失败也只是留个孤儿，不会让首页裂图。
        // 用 CancellationToken.None：请求这时已经成功了，客户端断开不该把清理掐掉。
        if (!string.IsNullOrWhiteSpace(staleKey))
        {
            try { await _assetStorage.DeleteByKeyAsync(staleKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning("Failed to delete old homepage asset {Key}: {Msg}", staleKey, ex.Message); }
        }

        existing.RelativePath = copied.ObjectKey;
        existing.Url = imageUrl;
        existing.Mime = mime;
        existing.SizeBytes = sizeBytes;
        existing.Prompt = string.IsNullOrWhiteSpace(prompt) ? null : prompt;
        existing.UpdatedAt = now;

        _logger.LogInformation("Replaced homepage slot={Slot} with image-gen result run={Run}", slotNorm, runId);
        return Ok(ApiResponse<HomepageAssetDto>.Ok(ToDto(existing)));
    }

    /// <summary>
    /// 删除：按 slot 同时清理 DB 记录 + COS 对象。
    /// </summary>
    [HttpDelete("{slot}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Delete([FromRoute] string slot, CancellationToken ct)
    {
        var (ok, err, slotNorm) = NormalizeSlot(slot);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "slot 不合法"));

        var existing = await _db.HomepageAssets.Find(x => x.Slot == slotNorm).Limit(1).FirstOrDefaultAsync(ct);
        if (existing == null)
            return Ok(ApiResponse<object>.Ok(new { deleted = false, reason = "not found" }));

        // RelativePath 为空 = 这条只是引用了生图产物的 URL，对象不归本 slot 所有，不能删
        if (!string.IsNullOrWhiteSpace(existing.RelativePath))
        {
            try { await _assetStorage.DeleteByKeyAsync(existing.RelativePath, ct); }
            catch (Exception ex) { _logger.LogWarning("Failed to delete homepage asset object {Key}: {Msg}", existing.RelativePath, ex.Message); }
        }

        var res = await _db.HomepageAssets.DeleteOneAsync(x => x.Id == existing.Id, ct);
        _logger.LogWarning("Admin deleted homepage asset slot={Slot}", slotNorm);
        return Ok(ApiResponse<object>.Ok(new { deleted = res.DeletedCount > 0 }));
    }
}

/// <summary>
/// 对外首页（`/home`）的配图读取 —— **匿名可读**。
///
/// 为什么不复用 `api/homepage/assets`：那个端点是 `[Authorize]`，服务的是登录后的
/// 首页；而 `/home` 是不登录就能打开的宣传页，拿不到 token。
///
/// 只暴露 `landing.` 前缀这一族，不是整张表：这里是公网无鉴权面，把全部 slot
/// （含内部卡片背景、Agent 封面）一并吐出去等于白送一份资源清单。
/// </summary>
[ApiController]
[Route("api/v1/landing/preview-assets")]
[AllowAnonymous]
public class LandingPreviewAssetsController : ControllerBase
{
    private const string SlotPrefix = "landing.";
    private readonly MongoDbContext _db;

    public LandingPreviewAssetsController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>返回 slot → url 的字典；没有配图的幕不出现在结果里。</summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<Dictionary<string, string>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var list = await _db.HomepageAssets
            .Find(x => x.Slot.StartsWith(SlotPrefix))
            .ToListAsync(ct);

        // 只给 slot 与 url：提示词、体积、上传者都是内部信息，公网面不该带
        var map = list
            .Where(x => !string.IsNullOrWhiteSpace(x.Url))
            .ToDictionary(x => x.Slot, x => x.Url);
        return Ok(ApiResponse<Dictionary<string, string>>.Ok(map));
    }
}

/// <summary>把一次生图任务的某张产物挂到首页 slot 上。</summary>
public class AdoptImageRunRequest
{
    /// <summary>目标槽位，如 `landing.layers`</summary>
    public string Slot { get; set; } = string.Empty;

    /// <summary>生图任务 Id（必须是调用者本人发起的）</summary>
    public string RunId { get; set; } = string.Empty;

    /// <summary>任务内第几条计划项（一次「全部重新生成」会有多条）</summary>
    public int ItemIndex { get; set; }

    /// <summary>该计划项里的第几张图（当前每项只生一张，恒为 0）</summary>
    public int ImageIndex { get; set; }

    /// <summary>本次实际用的提示词；留空则回落到生图结果自带的那条</summary>
    public string? Prompt { get; set; }
}

/// <summary>
/// 用户侧首页资源读取（任意登录用户可读，无管理员权限要求）。
/// LandingPage 通过此端点拉取上传的卡片背景/Agent 封面进行覆盖渲染。
/// </summary>
[ApiController]
[Route("api/homepage/assets")]
[Authorize]
public class HomepageAssetsPublicController : ControllerBase
{
    private readonly MongoDbContext _db;

    public HomepageAssetsPublicController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 返回 slot → {url, mime} 的字典，前端按需合并到默认资源上。
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<Dictionary<string, HomepageAssetDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var list = await _db.HomepageAssets.Find(_ => true).ToListAsync(ct);
        var map = list.ToDictionary(
            x => x.Slot,
            x => new HomepageAssetDto
            {
                Slot = x.Slot,
                Url = x.Url,
                Mime = x.Mime,
                SizeBytes = x.SizeBytes,
                UpdatedAt = x.UpdatedAt
                // 不带 Prompt：这个端点只挡了登录，任何登录用户都能拉。提示词是管理员
                // 写的，管理端自己走 /api/assets/homepage/list（带 assets.read 门）能拿到。
            });
        return Ok(ApiResponse<Dictionary<string, HomepageAssetDto>>.Ok(map));
    }
}
