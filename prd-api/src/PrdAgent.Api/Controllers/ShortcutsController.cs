using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 苹果快捷指令 API — 支持创建个人快捷指令、扫码安装、一键收藏
/// </summary>
[ApiController]
[Route("api/shortcuts")]
public class ShortcutsController : ControllerBase
{
    private const string AppKey = "shortcuts-agent";

    private readonly MongoDbContext _db;
    private readonly ILogger<ShortcutsController> _logger;
    private readonly IConfiguration _config;

    public ShortcutsController(MongoDbContext db, ILogger<ShortcutsController> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;
        _config = config;
    }

    #region 快捷指令管理（JWT 认证）

    /// <summary>
    /// 创建快捷指令（生成 scs- token，仅返回一次）
    /// </summary>
    [Authorize]
    [HttpPost]
    public async Task<IActionResult> CreateShortcut([FromBody] CreateShortcutRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        // 默认名 "天狼星"，用户可自定义任意名称
        var name = string.IsNullOrWhiteSpace(request.Name) ? "天狼星" : request.Name.Trim();

        // 生成 token
        var (token, hash, prefix) = UserShortcut.GenerateToken();

        // 校验绑定类型
        var bindingType = request.BindingType ?? ShortcutBindingType.Collect;
        if (bindingType is not (ShortcutBindingType.Collect or ShortcutBindingType.Workflow or ShortcutBindingType.Agent))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "bindingType 必须是 collect/workflow/agent"));

        // 如果绑定工作流/智能体，校验目标 ID
        if (bindingType != ShortcutBindingType.Collect && string.IsNullOrWhiteSpace(request.BindingTargetId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "绑定工作流或智能体时 bindingTargetId 不能为空"));

        // 获取绑定目标名称（快照）
        string? bindingTargetName = request.BindingTargetName;
        if (bindingType == ShortcutBindingType.Workflow && !string.IsNullOrWhiteSpace(request.BindingTargetId))
        {
            var workflow = await _db.Workflows
                .Find(x => x.Id == request.BindingTargetId)
                .FirstOrDefaultAsync(ct);
            if (workflow == null)
                return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "工作流不存在"));
            bindingTargetName ??= workflow.Name;
        }

        var shortcut = new UserShortcut
        {
            UserId = userId,
            Name = name,
            TokenHash = hash,
            TokenPrefix = prefix,
            DeviceType = request.DeviceType ?? "ios",
            Icon = request.Icon ?? "⚡",
            Color = request.Color ?? "#007AFF",
            BindingType = bindingType,
            BindingTargetId = request.BindingTargetId?.Trim(),
            BindingTargetName = bindingTargetName,
            BindingVariables = request.BindingVariables
        };

        await _db.UserShortcuts.InsertOneAsync(shortcut, cancellationToken: ct);

        _logger.LogInformation("Shortcut created: {Id} {Name} for user {UserId}", shortcut.Id, shortcut.Name, userId);

        // 优先使用前端传来的 clientBaseUrl（前端知道真实域名），再 fallback 到 ResolveServerUrl
        var serverUrl = !string.IsNullOrWhiteSpace(request.ClientBaseUrl)
            ? request.ClientBaseUrl.TrimEnd('/')
            : ResolveServerUrl();
        var installPageUrl = $"{serverUrl}/api/shortcuts/{shortcut.Id}/install-page?t={token}";

        // token 明文仅在创建时返回一次
        return Ok(ApiResponse<object>.Ok(new
        {
            shortcut.Id,
            shortcut.Name,
            shortcut.TokenPrefix,
            shortcut.DeviceType,
            Token = token, // 仅此一次
            InstallPageUrl = installPageUrl, // 前端用此 URL 生成 QR 码
            shortcut.CreatedAt
        }));
    }

    /// <summary>
    /// 列出我的快捷指令
    /// </summary>
    [Authorize]
    [HttpGet]
    public async Task<IActionResult> ListMyShortcuts(CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var shortcuts = await _db.UserShortcuts
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        // 不返回 tokenHash
        var items = shortcuts.Select(s => new
        {
            s.Id,
            s.Name,
            s.TokenPrefix,
            s.DeviceType,
            s.Icon,
            s.Color,
            s.BindingType,
            s.BindingTargetId,
            s.BindingTargetName,
            s.IsActive,
            s.LastUsedAt,
            s.CollectCount,
            s.CreatedAt
        });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 删除快捷指令（吊销 token）
    /// </summary>
    [Authorize]
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteShortcut([FromRoute] string id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var result = await _db.UserShortcuts.DeleteOneAsync(
            x => x.Id == id && x.UserId == userId, ct);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "快捷指令不存在或无权限"));

        _logger.LogInformation("Shortcut deleted: {Id} by user {UserId}", id, userId);

        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    /// <summary>
    /// 获取安装信息（供前端生成 QR 码）
    /// </summary>
    [Authorize]
    [HttpGet("{id}/setup")]
    public async Task<IActionResult> GetSetupInfo([FromRoute] string id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var shortcut = await _db.UserShortcuts
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (shortcut == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "快捷指令不存在"));

        // 获取默认模板的 iCloud 链接
        var template = await _db.ShortcutTemplates
            .Find(x => x.IsDefault && x.IsActive)
            .FirstOrDefaultAsync(ct);

        var serverUrl = ResolveServerUrl();

        return Ok(ApiResponse<object>.Ok(new
        {
            shortcut.Id,
            shortcut.Name,
            shortcut.TokenPrefix,
            shortcut.DeviceType,
            ServerUrl = serverUrl,
            CollectEndpoint = $"{serverUrl}/api/shortcuts/collect",
            ICloudUrl = template?.ICloudUrl,
            TemplateName = template?.Name,
            TemplateVersion = template?.Version,
            // 注意：QR 码应编码此 URL，但 token 需要前端在创建时拿到后拼接
            // 格式：{serverUrl}/api/shortcuts/{id}/install-page?t={token}
            InstallPageUrlPattern = $"{serverUrl}/api/shortcuts/{shortcut.Id}/install-page?t={{token}}",
            Instructions = new
            {
                Ios = new[]
                {
                    "打开 iPhone 相机扫描二维码",
                    "在弹出的页面中点击「添加快捷指令」",
                    "授权允许快捷指令访问网络",
                    "回到任意 App，点击分享 → 选择此快捷指令即可收藏"
                },
                Android = new[]
                {
                    "安装 HTTP Shortcuts 应用（Google Play 可下载）",
                    "在应用中新建快捷方式",
                    $"设置 URL 为: {serverUrl}/api/shortcuts/collect",
                    "设置请求方式为 POST，添加 Authorization 头",
                    "保存后即可从分享菜单使用"
                }
            }
        }));
    }

    /// <summary>
    /// 获取安装页数据（JSON，供前端公开页面渲染）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("{id}/install-data")]
    public async Task<IActionResult> GetInstallData(
        [FromRoute] string id,
        [FromQuery(Name = "t")] string? token,
        CancellationToken ct)
    {
        var shortcut = await _db.UserShortcuts
            .Find(x => x.Id == id)
            .FirstOrDefaultAsync(ct);

        if (shortcut == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "快捷指令不存在"));

        if (string.IsNullOrEmpty(token) || !token.StartsWith("scs-"))
            return BadRequest(ApiResponse<object>.Fail("INVALID_TOKEN", "无效的 token"));

        var hash = UserShortcut.HashToken(token);
        if (hash != shortcut.TokenHash)
            return Unauthorized(ApiResponse<object>.Fail("TOKEN_MISMATCH", "token 不匹配"));

        var serverUrl = ResolveServerUrl();
        var downloadUrl = $"{serverUrl}/api/shortcuts/{shortcut.Id}/download?t={Uri.EscapeDataString(token)}";

        var template = await _db.ShortcutTemplates
            .Find(x => x.IsDefault && x.IsActive)
            .FirstOrDefaultAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            shortcut.Name,
            shortcut.Icon,
            shortcut.Color,
            Token = token,
            DownloadUrl = downloadUrl,
            ICloudUrl = template?.ICloudUrl,
            ServerUrl = serverUrl,
        }));
    }

    /// <summary>
    /// 安装引导页面（旧版 HTML 直出，保留兼容）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("{id}/install-page")]
    public async Task<IActionResult> GetInstallPage(
        [FromRoute] string id,
        [FromQuery(Name = "t")] string? token,
        CancellationToken ct)
    {
        // 校验 shortcut 存在
        var shortcut = await _db.UserShortcuts
            .Find(x => x.Id == id)
            .FirstOrDefaultAsync(ct);

        if (shortcut == null)
            return NotFound("快捷指令不存在");

        // 安全校验：token hash 必须匹配
        if (string.IsNullOrEmpty(token) || !token.StartsWith("scs-"))
            return BadRequest("无效的 token");

        var hash = UserShortcut.HashToken(token);
        if (hash != shortcut.TokenHash)
            return Unauthorized("token 不匹配");

        // 获取默认模板
        var template = await _db.ShortcutTemplates
            .Find(x => x.IsDefault && x.IsActive)
            .FirstOrDefaultAsync(ct);

        var serverUrl = ResolveServerUrl();

        var downloadUrl = $"{serverUrl}/api/shortcuts/{shortcut.Id}/download?t={Uri.EscapeDataString(token)}";

        // 返回 HTML 安装引导页
        var html = GenerateInstallPageHtml(
            shortcutName: shortcut.Name,
            token: token,
            serverUrl: serverUrl,
            iCloudUrl: template?.ICloudUrl,
            downloadUrl: downloadUrl);

        return Content(html, "text/html; charset=utf-8");
    }

    /// <summary>
    /// 生成安装引导页 HTML
    /// </summary>
    private static string GenerateInstallPageHtml(string shortcutName, string token, string serverUrl, string? iCloudUrl, string downloadUrl)
    {
        var escapedName = System.Net.WebUtility.HtmlEncode(shortcutName);
        var escapedDownloadUrl = System.Net.WebUtility.HtmlEncode(downloadUrl);

        var iCloudSection = string.IsNullOrEmpty(iCloudUrl)
            ? ""
            : $@"<div style=""margin-top:16px;"">
                    <p style=""color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;"">或使用 iCloud 模板（需手动配置 token）</p>
                    <a href=""{System.Net.WebUtility.HtmlEncode(iCloudUrl)}""
                       style=""display:inline-block;padding:10px 20px;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);
                              text-decoration:none;border-radius:10px;font-size:14px;border:1px solid rgba(255,255,255,0.15);"">
                       iCloud 模板
                    </a>
                </div>";

        return $@"<!DOCTYPE html>
<html lang=""zh-CN"">
<head>
    <meta charset=""UTF-8"">
    <meta name=""viewport"" content=""width=device-width, initial-scale=1.0, user-scalable=no"">
    <title>安装快捷指令 - {escapedName}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center;
            padding: 20px;
        }}
        .card {{
            background: rgba(255,255,255,0.08); backdrop-filter: blur(20px);
            border-radius: 24px; padding: 40px 32px; max-width: 420px; width: 100%;
            text-align: center; border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }}
        .icon {{ font-size: 64px; margin-bottom: 16px; }}
        h1 {{ font-size: 24px; font-weight: 700; margin-bottom: 8px; }}
        .subtitle {{ color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 32px; }}
        .step {{
            background: rgba(255,255,255,0.06); border-radius: 16px; padding: 16px;
            margin-bottom: 12px; text-align: left; display: flex; align-items: flex-start; gap: 12px;
        }}
        .step-num {{
            background: #007aff; color: white; width: 28px; height: 28px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; font-weight: 700;
            font-size: 14px; flex-shrink: 0;
        }}
        .step-text {{ font-size: 15px; line-height: 1.5; }}
        .primary-btn {{
            display: inline-block; margin-top: 24px; padding: 16px 32px;
            background: #007aff; color: white; text-decoration: none;
            border-radius: 14px; font-size: 18px; font-weight: 600;
            transition: all 0.2s ease; border: none; cursor: pointer;
        }}
        .primary-btn:active {{ background: #0056b3; transform: scale(0.97); }}
        .feature-list {{
            margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.1);
            text-align: left;
        }}
        .feature-list h3 {{ font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 12px; }}
        .feature {{ font-size: 13px; color: rgba(255,255,255,0.6); margin-bottom: 6px; padding-left: 8px; }}
        .android-section {{
            margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.1);
        }}
        .android-section h3 {{ font-size: 16px; margin-bottom: 12px; color: rgba(255,255,255,0.7); }}
        .copy-btn {{
            display: inline-block; margin-top: 8px; padding: 10px 24px;
            background: rgba(255,255,255,0.12); color: white; border: 1px solid rgba(255,255,255,0.2);
            border-radius: 10px; font-size: 14px; cursor: pointer; transition: all 0.2s ease;
        }}
        .copy-btn:active {{ background: rgba(255,255,255,0.2); transform: scale(0.97); }}
    </style>
</head>
<body>
    <div class=""card"">
        <div class=""icon"">⚡</div>
        <h1>{escapedName}</h1>
        <div class=""subtitle"">PrdAgent 快捷指令 · 一键安装</div>

        <div class=""step"">
            <div class=""step-num"">1</div>
            <div class=""step-text"">点击下方按钮下载快捷指令（密钥已内置）</div>
        </div>
        <div class=""step"">
            <div class=""step-num"">2</div>
            <div class=""step-text"">iOS 弹出提示，点击「添加快捷指令」</div>
        </div>
        <div class=""step"">
            <div class=""step-num"">3</div>
            <div class=""step-text"">在任意 App 点击<strong>分享 → {escapedName}</strong>即可收藏</div>
        </div>

        <a href=""{escapedDownloadUrl}"" class=""primary-btn"">📲 下载并安装快捷指令</a>

        {iCloudSection}

        <div class=""feature-list"">
            <h3>内置功能</h3>
            <div class=""feature"">✅ 密钥已预置，无需手动配置</div>
            <div class=""feature"">✅ 自动版本检查，有更新时提醒</div>
            <div class=""feature"">✅ 分享菜单一键收藏 URL/文本</div>
            <div class=""feature"">✅ 收藏成功后系统通知反馈</div>
        </div>

        <div class=""android-section"">
            <h3>Android 用户</h3>
            <p style=""font-size:13px;color:rgba(255,255,255,0.5);line-height:1.6;"">
                安装 <strong>HTTP Shortcuts</strong> 应用，新建快捷方式：<br>
                URL: <code style=""color:#007aff;"">{serverUrl}/api/shortcuts/collect</code><br>
                方法: POST · Header: Authorization: Bearer {token[..Math.Min(12, token.Length)]}...
            </p>
            <button class=""copy-btn"" onclick=""copyToken()"">📋 复制完整 Token</button>
        </div>
    </div>

    <script>
        function copyToken() {{
            var t = '{token}';
            navigator.clipboard.writeText(t).then(function() {{
                alert('Token 已复制');
            }}).catch(function() {{
                var ta = document.createElement('textarea');
                ta.value = t;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                alert('Token 已复制');
            }});
        }}
    </script>
</body>
</html>";
    }

    /// <summary>
    /// 直接下载 .shortcut 文件（token 预嵌入，iOS 可直接安装）
    /// 扫码 → 打开安装页 → 点"直接安装" → 下载 .shortcut → iOS 提示添加 → 完成
    /// </summary>
    [AllowAnonymous]
    [HttpGet("{id}/download")]
    public async Task<IActionResult> DownloadShortcutFile(
        [FromRoute] string id,
        [FromQuery(Name = "t")] string? token,
        CancellationToken ct)
    {
        var shortcut = await _db.UserShortcuts
            .Find(x => x.Id == id)
            .FirstOrDefaultAsync(ct);

        if (shortcut == null)
            return NotFound("快捷指令不存在");

        if (string.IsNullOrEmpty(token) || !token.StartsWith("scs-"))
            return BadRequest("无效的 token");

        var hash = UserShortcut.HashToken(token);
        if (hash != shortcut.TokenHash)
            return Unauthorized("token 不匹配");

        var serverUrl = ResolveServerUrl();

        var plistXml = ShortcutPlistGenerator.Generate(
            shortcutName: shortcut.Name,
            token: token,
            serverUrl: serverUrl);

        var fileName = $"{shortcut.Name}.shortcut";
        var bytes = System.Text.Encoding.UTF8.GetBytes(plistXml);

        return File(bytes, "application/x-shortcut", fileName);
    }

    /// <summary>
    /// 下载通用模板 .shortcut 文件（管理员用，下载后在 Mac/iPhone 上安装并分享到 iCloud 获取链接）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("template-download")]
    public IActionResult DownloadTemplateFile([FromQuery] string? name)
    {
        var templateName = string.IsNullOrWhiteSpace(name) ? "PrdAgent 收藏" : name.Trim();
        var plistXml = ShortcutPlistGenerator.GenerateTemplate(templateName);
        var bytes = System.Text.Encoding.UTF8.GetBytes(plistXml);
        return File(bytes, "application/x-shortcut", $"{templateName}.shortcut");
    }

    /// <summary>
    /// 版本检查端点（快捷指令运行时调用，支持自动更新提示）
    /// 对标截图中的 Config.update 模式
    /// </summary>
    [AllowAnonymous]
    [HttpGet("version-check")]
    public IActionResult VersionCheck()
    {
        var serverUrl = ResolveServerUrl();

        return Ok(new
        {
            version = ShortcutPlistGenerator.CurrentVersion,
            download = $"{serverUrl}/api/shortcuts/templates",
            changelog = $"v{ShortcutPlistGenerator.CurrentVersion}: 收藏快捷指令"
        });
    }

    #endregion

    #region 收藏操作（scs- token 认证）

    /// <summary>
    /// 收藏链接/文本（快捷指令主入口）
    /// </summary>
    [AllowAnonymous]
    [HttpPost("collect")]
    public async Task<IActionResult> Collect([FromBody] CollectRequest request, CancellationToken ct)
    {
        // 手动校验 scs- token
        var shortcut = await ValidateShortcutTokenAsync(ct);
        if (shortcut == null)
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "无效的 token"));

        if (!shortcut.IsActive)
            return Unauthorized(ApiResponse<object>.Fail("DISABLED", "快捷指令已禁用"));

        if (string.IsNullOrWhiteSpace(request.Url) && string.IsNullOrWhiteSpace(request.Text))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "url 和 text 不能同时为空"));

        // 创建收藏
        var collection = new UserCollection
        {
            UserId = shortcut.UserId,
            ShortcutId = shortcut.Id,
            Url = request.Url?.Trim(),
            Text = request.Text?.Trim(),
            Tags = request.Tags ?? new List<string>(),
            Source = "shortcuts",
            Status = CollectionStatus.Saved
        };

        await _db.UserCollections.InsertOneAsync(collection, cancellationToken: ct);

        // 更新快捷指令使用统计
        await _db.UserShortcuts.UpdateOneAsync(
            x => x.Id == shortcut.Id,
            Builders<UserShortcut>.Update
                .Set(x => x.LastUsedAt, DateTime.UtcNow)
                .Inc(x => x.CollectCount, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // 记录 ChannelTask（用于渠道管理统一追踪）
        var task = new ChannelTask
        {
            Id = GenerateTaskId(),
            ChannelType = ChannelTypes.Shortcuts,
            SenderIdentifier = shortcut.TokenPrefix,
            MappedUserId = shortcut.UserId,
            Intent = ChannelTaskIntent.SaveLink,
            TargetAgent = AppKey,
            OriginalContent = request.Url ?? request.Text ?? "",
            Status = ChannelTaskStatus.Completed,
            CompletedAt = DateTime.UtcNow,
            Result = new ChannelTaskResult
            {
                Type = "text",
                TextContent = "已收藏",
                Data = new Dictionary<string, object>
                {
                    ["collectionId"] = collection.Id,
                    ["shortcutId"] = shortcut.Id
                }
            }
        };
        task.StatusHistory.Add(new ChannelTaskStatusChange
        {
            Status = ChannelTaskStatus.Completed,
            At = DateTime.UtcNow,
            Note = "直接完成"
        });

        await _db.ChannelTasks.InsertOneAsync(task, cancellationToken: ct);

        _logger.LogInformation(
            "Shortcut collect: user {UserId} via {ShortcutName} ({BindingType}) saved {Url}",
            shortcut.UserId, shortcut.Name, shortcut.BindingType, request.Url ?? "(text)");

        // 根据绑定类型，异步触发后台任务（收藏已完成，额外动作后台运行）
        string message = $"已收藏到「{shortcut.Name}」";
        string? executionId = null;

        if (shortcut.BindingType == ShortcutBindingType.Workflow && !string.IsNullOrWhiteSpace(shortcut.BindingTargetId))
        {
            // 创建工作流执行（后台运行，立即返回）
            var variables = new Dictionary<string, string>
            {
                ["input_url"] = request.Url?.Trim() ?? "",
                ["input_text"] = request.Text?.Trim() ?? "",
                ["shortcut_name"] = shortcut.Name,
                ["collection_id"] = collection.Id
            };

            // 合并绑定时预设的变量
            if (shortcut.BindingVariables != null)
            {
                foreach (var kv in shortcut.BindingVariables)
                    variables.TryAdd(kv.Key, kv.Value);
            }

            var execution = new WorkflowExecution
            {
                WorkflowId = shortcut.BindingTargetId,
                WorkflowName = shortcut.BindingTargetName ?? "",
                TriggerType = "shortcut",
                TriggeredBy = shortcut.UserId,
                TriggeredByName = shortcut.Name,
                Variables = variables,
                Status = WorkflowExecutionStatus.Queued
            };

            await _db.WorkflowExecutions.InsertOneAsync(execution, cancellationToken: CancellationToken.None);
            executionId = execution.Id;
            message = $"已收藏，工作流「{shortcut.BindingTargetName ?? "未命名"}」正在执行...";

            _logger.LogInformation(
                "Shortcut triggered workflow: {WorkflowId} execution {ExecutionId} via {ShortcutName}",
                shortcut.BindingTargetId, execution.Id, shortcut.Name);
        }
        else if (shortcut.BindingType == ShortcutBindingType.Agent && !string.IsNullOrWhiteSpace(shortcut.BindingTargetId))
        {
            message = $"已收藏，智能体「{shortcut.BindingTargetName ?? shortcut.BindingTargetId}」正在处理...";
            // TODO: Phase 2 - 路由到对应智能体
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            collection.Id,
            collection.Url,
            collection.Status,
            ShortcutName = shortcut.Name,
            shortcut.BindingType,
            ExecutionId = executionId,
            Message = message
        }));
    }

    /// <summary>
    /// 查询我的收藏（分页，支持 JWT 或 scs- token）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("collections")]
    public async Task<IActionResult> GetCollections(
        [FromQuery] string? keyword,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        // 支持两种认证方式
        string? userId = GetUserId(); // JWT
        if (string.IsNullOrEmpty(userId))
        {
            var shortcut = await ValidateShortcutTokenAsync(ct);
            userId = shortcut?.UserId;
        }

        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录或 token 无效"));

        var filterBuilder = Builders<UserCollection>.Filter;
        var filters = new List<FilterDefinition<UserCollection>>
        {
            filterBuilder.Eq(x => x.UserId, userId)
        };

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Regex(x => x.Url, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                filterBuilder.Regex(x => x.Text, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))
            ));
        }

        var filter = filterBuilder.And(filters);

        if (page < 1) page = 1;
        if (pageSize < 1) pageSize = 20;
        if (pageSize > 100) pageSize = 100;

        var total = await _db.UserCollections.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.UserCollections
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            Items = items,
            Total = (int)total,
            Page = page,
            PageSize = pageSize
        }));
    }

    /// <summary>
    /// 删除收藏
    /// </summary>
    [AllowAnonymous]
    [HttpDelete("collections/{id}")]
    public async Task<IActionResult> DeleteCollection([FromRoute] string id, CancellationToken ct)
    {
        // 支持两种认证方式
        string? userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
        {
            var shortcut = await ValidateShortcutTokenAsync(ct);
            userId = shortcut?.UserId;
        }

        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录或 token 无效"));

        var result = await _db.UserCollections.DeleteOneAsync(
            x => x.Id == id && x.UserId == userId, ct);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "收藏不存在或无权限"));

        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    #endregion

    #region 绑定目标查询

    /// <summary>
    /// 获取可绑定的目标列表（工作流 + 智能体），供创建表单下拉选择
    /// </summary>
    [Authorize]
    [HttpGet("binding-targets")]
    public async Task<IActionResult> GetBindingTargets(CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        // 查询用户的工作流
        var workflows = await _db.Workflows
            .Find(x => x.CreatedBy == userId && x.IsEnabled)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(50)
            .ToListAsync(ct);

        var workflowItems = workflows.Select(w => new
        {
            Id = w.Id,
            w.Name,
            w.Description,
            w.Icon,
            Type = "workflow"
        });

        // 内置智能体列表
        var agents = new[]
        {
            new { Id = "prd-agent", Name = "PRD 智能解读", Description = "PRD 文档解析与问答", Icon = "📋", Type = "agent" },
            new { Id = "literary-agent", Name = "文学创作", Description = "文章配图、文学创作", Icon = "✍️", Type = "agent" },
            new { Id = "visual-agent", Name = "视觉创作", Description = "高级视觉创作工作区", Icon = "🎨", Type = "agent" },
            new { Id = "defect-agent", Name = "缺陷管理", Description = "缺陷提交与跟踪", Icon = "🐛", Type = "agent" },
            new { Id = "video-agent", Name = "视频生成", Description = "文章转视频教程", Icon = "🎬", Type = "agent" },
        };

        return Ok(ApiResponse<object>.Ok(new
        {
            workflows = workflowItems,
            agents
        }));
    }

    #endregion

    #region 模板管理

    /// <summary>
    /// 获取快捷指令模板列表（公开）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("templates")]
    public async Task<IActionResult> GetTemplates(CancellationToken ct)
    {
        var templates = await _db.ShortcutTemplates
            .Find(x => x.IsActive)
            .SortByDescending(x => x.IsDefault)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { templates }));
    }

    /// <summary>
    /// 创建快捷指令模板（管理员）
    /// </summary>
    [Authorize]
    [HttpPost("admin/templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "名称不能为空"));

        if (string.IsNullOrWhiteSpace(request.ICloudUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "iCloud 链接不能为空"));

        var template = new ShortcutTemplate
        {
            Name = request.Name,
            Description = request.Description,
            ICloudUrl = request.ICloudUrl,
            Version = request.Version ?? "1.0",
            IsDefault = request.IsDefault,
            CreatedBy = GetAdminId()
        };

        await _db.ShortcutTemplates.InsertOneAsync(template, cancellationToken: ct);

        _logger.LogInformation("Shortcut template created: {Id} {Name}", template.Id, template.Name);

        return Ok(ApiResponse<ShortcutTemplate>.Ok(template));
    }

    /// <summary>
    /// 删除快捷指令模板（管理员）
    /// </summary>
    [Authorize]
    [HttpDelete("admin/templates/{id}")]
    public async Task<IActionResult> DeleteTemplate([FromRoute] string id, CancellationToken ct)
    {
        var result = await _db.ShortcutTemplates.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));

        return NoContent();
    }

    #endregion

    #region Helper Methods

    /// <summary>
    /// 从 Authorization: Bearer scs-xxx 中校验 token，返回对应 UserShortcut
    /// </summary>
    private async Task<UserShortcut?> ValidateShortcutTokenAsync(CancellationToken ct)
    {
        var authHeader = Request.Headers.Authorization.FirstOrDefault();
        if (string.IsNullOrEmpty(authHeader))
            return null;

        string? token = null;
        if (authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            token = authHeader["Bearer ".Length..].Trim();

        if (string.IsNullOrEmpty(token) || !token.StartsWith("scs-"))
            return null;

        var hash = UserShortcut.HashToken(token);

        return await _db.UserShortcuts
            .Find(x => x.TokenHash == hash)
            .FirstOrDefaultAsync(ct);
    }

    private string? GetUserId()
    {
        return User.FindFirst("sub")?.Value ?? User.FindFirst("userId")?.Value;
    }

    private string? GetAdminId()
    {
        return User.FindFirst("sub")?.Value ?? User.FindFirst("userId")?.Value;
    }

    private string ResolveServerUrl() => Request.ResolveServerUrl(_config);

    private static string GenerateTaskId()
    {
        var date = DateTime.UtcNow.ToString("yyyyMMdd");
        var seq = Guid.NewGuid().ToString("N")[..6].ToUpper();
        return $"TASK-{date}-{seq}";
    }

    #endregion
}

#region Request DTOs

public class CreateShortcutRequest
{
    /// <summary>快捷指令名称（不传则默认"天狼星"）</summary>
    public string? Name { get; set; }

    /// <summary>设备类型：ios / android / other</summary>
    public string? DeviceType { get; set; }

    /// <summary>图标（emoji 或 icon name）</summary>
    public string? Icon { get; set; }

    /// <summary>主题色（hex）</summary>
    public string? Color { get; set; }

    /// <summary>绑定类型：collect（默认）| workflow | agent</summary>
    public string? BindingType { get; set; }

    /// <summary>绑定目标 ID（工作流 ID 或 agent appKey）</summary>
    public string? BindingTargetId { get; set; }

    /// <summary>绑定目标名称（可选，不传则自动获取）</summary>
    public string? BindingTargetName { get; set; }

    /// <summary>工作流变量默认值（绑定 workflow 时使用）</summary>
    public Dictionary<string, string>? BindingVariables { get; set; }

    /// <summary>前端传入的基础 URL（如 https://miduo.org），用于生成正确的二维码地址</summary>
    public string? ClientBaseUrl { get; set; }
}

public class CollectRequest
{
    /// <summary>要收藏的 URL</summary>
    public string? Url { get; set; }

    /// <summary>附加文字（或纯文本收藏）</summary>
    public string? Text { get; set; }

    /// <summary>标签</summary>
    public List<string>? Tags { get; set; }
}

public class CreateTemplateRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string ICloudUrl { get; set; } = string.Empty;
    public string? Version { get; set; }
    public bool IsDefault { get; set; } = false;
}

#endregion
