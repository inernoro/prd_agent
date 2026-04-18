| fix | prd-api | 修复 DocumentSyncWorker 因 HttpClient 30s 超时抛 TaskCanceledException 被 catch filter 误判为"关机取消"漏掉，最终拖垮整个 Host 导致无法登录的问题 |
| fix | prd-api | HostOptions.BackgroundServiceExceptionBehavior 显式设为 Ignore，避免任一 BackgroundService 未捕获异常时整个进程被停 |
