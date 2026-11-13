namespace PrdAgent.Api.Services.Speech;

/// <summary>服务端任务独立于MCP连接，四个消费循环通过Mongo原子认领。</summary>
public sealed class SpeechRunWorker(IServiceScopeFactory scopes, ILogger<SpeechRunWorker> logger) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
        => Task.WhenAll(Enumerable.Range(0, 4).Select(_ => ConsumeAsync(Guid.NewGuid().ToString("N"), stoppingToken)));

    private async Task ConsumeAsync(string id, CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var service = scope.ServiceProvider.GetRequiredService<SpeechGenerationService>();
                if (!await service.ProcessNextAsync(id)) await Task.Delay(1000, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                logger.LogError(ex, "Speech worker cycle failed");
                try { await Task.Delay(3000, stoppingToken); } catch (OperationCanceledException) { break; }
            }
        }
    }
}
