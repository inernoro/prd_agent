using Microsoft.Extensions.Logging;

namespace PrdAgent.Api.Tests.Services;

public sealed class ListLogger<T> : ILogger<T>, IDisposable
{
    private readonly List<string> _messages = new();

    public IReadOnlyList<string> Messages => _messages;

    public IDisposable BeginScope<TState>(TState state) => this;

    public void Dispose()
    {
    }

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        _messages.Add(formatter(state, exception));
    }
}

public sealed class TestHostEnvironment : Microsoft.Extensions.Hosting.IHostEnvironment
{
    public string EnvironmentName { get; set; } = "Tests";
    public string ApplicationName { get; set; } = "PrdAgent.Api.Tests";
    public string ContentRootPath { get; set; } = string.Empty;
    public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
}
