using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 公开的模型列表控制器（用于开放平台客户端查询可用模型）
/// </summary>
[ApiController]
[AllowAnonymous]
public class PublicModelsController : ControllerBase
{
    private readonly ILogger<PublicModelsController> _logger;

    public PublicModelsController(ILogger<PublicModelsController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// 获取可用模型列表（公开接口，兼容 OpenAI 格式）
    /// 路径: GET /api/v1/config/models (OpenAI 标准路径)
    /// </summary>
    [HttpGet("api/v1/config/models")]
    public IActionResult GetConfigModels()
    {
        return GetModelsInternal();
    }

    /// <summary>
    /// 获取可用模型列表（公开接口，兼容 OpenAI 格式）
    /// 路径: GET /api/v1/models (备用路径)
    /// </summary>
    [HttpGet("api/v1/models")]
    public IActionResult GetModels()
    {
        return GetModelsInternal();
    }

    /// <summary>
    /// 内部实现：返回模型列表
    /// </summary>
    private IActionResult GetModelsInternal()
    {
        try
        {
            // 返回固定的模型列表（开放平台只支持 prdagent 模型）
            var models = new[]
            {
                new
                {
                    id = "prdagent",
                    @object = "model",
                    created = 1704067200, // 2024-01-01 00:00:00 UTC
                    owned_by = "prdagent",
                    permission = new object[] { },
                    root = "prdagent",
                    parent = (string?)null
                }
            };

            var response = new
            {
                @object = "list",
                data = models
            };

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting public models list");
            return StatusCode(500, new { error = new { message = "Internal server error", type = "internal_error" } });
        }
    }
}
