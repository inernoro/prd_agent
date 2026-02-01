using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Tests.Services;

public sealed class ListLogger<T> : ILogger<T>, IDisposable
{
    private readonly List<string> _messages = new();

    public IReadOnlyList<string> Messages => _messages;

    IDisposable? ILogger.BeginScope<TState>(TState state) => this;

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

public sealed class NullAssetStorage : IAssetStorage
{
    public Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null)
    {
        return Task.FromResult(new StoredAsset(string.Empty, string.Empty, bytes.Length, mime));
    }

    public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        return Task.FromResult<(byte[] bytes, string mime)?>(null);
    }

    public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        return Task.CompletedTask;
    }

    public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
    {
        return null;
    }
}

public sealed class EmptyWatermarkFontAssetSource : IWatermarkFontAssetSource
{
    public IReadOnlyList<WatermarkFontAsset> LoadAll() => Array.Empty<WatermarkFontAsset>();
}
