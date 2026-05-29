| fix | prd-api | GitRepoCacheService 加 per-cache-key SemaphoreSlim 锁，串行化同一仓库的并发 clone/fetch，避免两个用户同时引用同一 URL 时互相破坏 .git 目录 |
| feat | prd-api | GitRepoCacheService 启动时 fire-and-forget 异步清理超过 7 天未访问的缓存目录，防止 /tmp/project-route-agent-cache 无限累积 |
| test | prd-api | 新增 GitRepoCacheServiceTests：启动清理删旧留新 + 并发 EnsureClonedAsync 不死锁 |
