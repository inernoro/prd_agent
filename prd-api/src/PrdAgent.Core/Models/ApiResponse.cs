namespace PrdAgent.Core.Models;

/// <summary>
/// 统一API响应格式
/// </summary>
public class ApiResponse<T>
{
    public bool Success { get; set; }
    public T? Data { get; set; }
    public ApiError? Error { get; set; }

    public static ApiResponse<T> Ok(T data) => new()
    {
        Success = true,
        Data = data,
        Error = null
    };

    public static ApiResponse<T> Fail(string code, string message) => new()
    {
        Success = false,
        Data = default,
        Error = new ApiError { Code = code, Message = message }
    };
}

/// <summary>
/// API错误信息
/// </summary>
public class ApiError
{
    public string Code { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// 错误码常量
/// </summary>
public static class ErrorCodes
{
    // 文档相关
    public const string INVALID_FORMAT = "INVALID_FORMAT";
    public const string CONTENT_EMPTY = "CONTENT_EMPTY";
    public const string DOCUMENT_TOO_LARGE = "DOCUMENT_TOO_LARGE";
    public const string DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND";
    
    // 会话相关
    public const string SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
    public const string SESSION_EXPIRED = "SESSION_EXPIRED";
    
    // 用户认证相关
    public const string INVALID_CREDENTIALS = "INVALID_CREDENTIALS";
    public const string USERNAME_EXISTS = "USERNAME_EXISTS";
    public const string INVALID_INVITE_CODE = "INVALID_INVITE_CODE";
    public const string ACCOUNT_DISABLED = "ACCOUNT_DISABLED";
    public const string ACCOUNT_LOCKED = "ACCOUNT_LOCKED";
    public const string WEAK_PASSWORD = "WEAK_PASSWORD";
    public const string UNAUTHORIZED = "UNAUTHORIZED";
    public const string PERMISSION_DENIED = "PERMISSION_DENIED";
    
    // 群组相关
    public const string GROUP_NOT_FOUND = "GROUP_NOT_FOUND";
    public const string INVALID_INVITE_LINK = "INVALID_INVITE_LINK";
    public const string INVITE_EXPIRED = "INVITE_EXPIRED";
    public const string ALREADY_MEMBER = "ALREADY_MEMBER";
    public const string GROUP_FULL = "GROUP_FULL";
    
    // 附件相关
    public const string INVALID_ATTACHMENT_TYPE = "INVALID_ATTACHMENT_TYPE";
    public const string ATTACHMENT_TOO_LARGE = "ATTACHMENT_TOO_LARGE";
    public const string UPLOAD_TIMEOUT = "UPLOAD_TIMEOUT";
    
    // 系统相关
    public const string RATE_LIMITED = "RATE_LIMITED";
    public const string LLM_ERROR = "LLM_ERROR";
    public const string INTERNAL_ERROR = "INTERNAL_ERROR";

    // 评论相关
    public const string PRD_COMMENT_NOT_FOUND = "PRD_COMMENT_NOT_FOUND";
}

