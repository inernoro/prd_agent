using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/logs/archives")]
[Authorize]
[AdminController("logs", AdminPermissionCatalog.LogsRead, WritePermission = AdminPermissionCatalog.LogsWrite)]
public sealed class LogArchivesController(LogArchiveService archives, IConfiguration config, ILogger<LogArchivesController> logger) : ControllerBase
{
    private string Owner => InstanceIdentity.Get(config);
    private static DateTime? Date(BsonDocument b, string key) => b.TryGetValue(key, out var v) && v.IsValidDateTime ? v.ToUniversalTime() : null;
    private static object Summary(BsonDocument b) => new
    {
        id = b["_id"].AsString, source = b["Source"].AsString, status = b["Status"].AsString,
        createdAt = Date(b, "CreatedAt"), from = Date(b, "From"), to = Date(b, "To"), count = b["Count"].ToInt32(),
        rawBytes = b["RawBytes"].ToInt64(), storedBytes = b["StoredBytes"].ToInt64(), migrated = b.GetValue("Migrated", 0).ToInt32(),
        verifiedAt = Date(b, "VerifiedAt"), restoredAt = Date(b, "RestoredAt"),
        records = b["Records"].AsBsonArray.Select(x => new { id = x["Id"].ToString(), requestId = x["RequestId"].ToString() })
    };
    private async Task<IActionResult> Guard(Func<Task<IActionResult>> action)
    {
        try { return await action(); }
        catch (LogArchiveSetupException ex) { return BadRequest(ApiResponse<object>.Fail("LOG_ARCHIVE_NOT_READY", ex.Message)); }
        catch (KeyNotFoundException) { return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "归档不存在，请刷新列表后重试。")); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("Log archive operation failed; type {Type}", ex.GetType().Name);
            return StatusCode(503, ApiResponse<object>.Fail("LOG_ARCHIVE_UNAVAILABLE", "归档暂时无法完成，请检查冷库连接和密钥后重试；已保存的日志仍保留。"));
        }
    }
    [HttpGet]
    public Task<IActionResult> List([FromQuery] string? source, [FromQuery] DateTime? from, [FromQuery] DateTime? to, [FromQuery] string? requestId, CancellationToken ct)
        => Guard(async () => Ok(ApiResponse<object>.Ok(new { items = (await archives.ListAsync(Owner, source, from, to, requestId, ct)).Select(Summary) })));
    [HttpGet("policy")]
    public Task<IActionResult> Policy(CancellationToken ct) => Guard(async () =>
    {
        var p = await archives.PolicyAsync(Owner, ct);
        return Ok(ApiResponse<object>.Ok(new { ready = archives.Ready, enabled = p["Enabled"].AsBoolean, hotDays = p["HotDays"].ToInt32(),
            lastCompletedAt = Date(p, "LastCompletedAt"), error = p.GetValue("Error", "").AsString }));
    });
    public sealed record PolicyRequest(bool Enabled, int HotDays = 30);
    [HttpPut("policy")]
    public Task<IActionResult> Policy(PolicyRequest request, CancellationToken ct) => Guard(async () =>
    {
        if (request.HotDays is < 7 or > 365) return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "热库保留时间须为 7 至 365 天，请修改后重试。"));
        if (request.Enabled && !PrdAgent.Infrastructure.Security.DeploymentAuthority.IsAuthoritativeDeployment(config))
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "当前环境只供预览，请在正式环境配置自动归档。"));
        await archives.SetPolicyAsync(Owner, request.Enabled, request.Enabled, request.HotDays, ct);
        return Ok(ApiResponse<object>.Ok(new { saved = true }));
    });
    [HttpPost("{id}/verify")]
    public Task<IActionResult> Verify(string id, CancellationToken ct) => Guard(async () => { await archives.VerifyAsync(Owner, id, ct); return Ok(ApiResponse<object>.Ok(new { verified = true })); });
    [HttpPost("{id}/restore")]
    public Task<IActionResult> Restore(string id, CancellationToken ct) => Guard(async () => Ok(ApiResponse<object>.Ok(new { restored = await archives.RestoreAsync(Owner, id, ct) })));
    [HttpGet("{id}/download")]
    public Task<IActionResult> Download(string id, CancellationToken ct) => Guard(async () =>
    {
        Response.Headers.CacheControl = "no-store";
        return File(await archives.DownloadAsync(Owner, id, ct), "application/gzip", "map-logs-" + id + ".json.gz");
    });
    [HttpGet("{id}/records/{recordId}")]
    public Task<IActionResult> Record(string id, string recordId, CancellationToken ct) => Guard(async () =>
    {
        var payload = await archives.ContentsAsync(Owner, id, ct);
        var record = payload["Records"].AsBsonArray.Select(x => x.AsBsonDocument).FirstOrDefault(x => x["_id"].ToString() == recordId);
        if (record == null) throw new KeyNotFoundException();
        Response.Headers.CacheControl = "no-store";
        return Ok(ApiResponse<object>.Ok(new { json = record.ToJson(new JsonWriterSettings { OutputMode = JsonOutputMode.CanonicalExtendedJson }) }));
    });
}
