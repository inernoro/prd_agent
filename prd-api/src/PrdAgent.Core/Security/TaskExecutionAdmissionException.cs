namespace PrdAgent.Core.Security;

public sealed class TaskExecutionAdmissionException(string code, string message, int statusCode = 403)
    : InvalidOperationException(message)
{
    public string Code { get; } = code;
    public int StatusCode { get; } = statusCode;
}
