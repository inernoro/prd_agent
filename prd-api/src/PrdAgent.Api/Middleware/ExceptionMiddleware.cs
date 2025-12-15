using System.Net;
using System.Text.Json;
using PrdAgent.Api.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 全局异常处理中间件
/// </summary>
public class ExceptionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ExceptionMiddleware> _logger;

    public ExceptionMiddleware(RequestDelegate next, ILogger<ExceptionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unhandled exception occurred");
            await HandleExceptionAsync(context, ex);
        }
    }

    private static async Task HandleExceptionAsync(HttpContext context, Exception exception)
    {
        context.Response.ContentType = "application/json";
        
        var (statusCode, errorCode, message) = exception switch
        {
            ArgumentException => (HttpStatusCode.BadRequest, ErrorCodes.INVALID_FORMAT, exception.Message),
            UnauthorizedAccessException => (HttpStatusCode.Unauthorized, ErrorCodes.UNAUTHORIZED, "未授权的访问"),
            KeyNotFoundException => (HttpStatusCode.NotFound, ErrorCodes.SESSION_NOT_FOUND, "资源不存在"),
            InvalidOperationException => (HttpStatusCode.BadRequest, ErrorCodes.INTERNAL_ERROR, exception.Message),
            _ => (HttpStatusCode.InternalServerError, ErrorCodes.INTERNAL_ERROR, "服务器内部错误")
        };

        context.Response.StatusCode = (int)statusCode;

        var response = ApiResponse<object>.Fail(errorCode, message);
        var json = JsonSerializer.Serialize(response, AppJsonContext.Default.ApiResponseObject);

        await context.Response.WriteAsync(json);
    }
}

/// <summary>
/// 扩展方法
/// </summary>
public static class ExceptionMiddlewareExtensions
{
    public static IApplicationBuilder UseExceptionMiddleware(this IApplicationBuilder builder)
    {
        return builder.UseMiddleware<ExceptionMiddleware>();
    }
}
