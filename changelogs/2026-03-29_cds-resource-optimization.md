| perf | prd-api | CDS API 容器添加 GC 堆限制(256MB)、分层编译、NuGet/build 缓存卷，内存限制 384M |
| perf | prd-admin | CDS Admin 容器添加 Node.js 堆限制(192MB)、pnpm store 缓存卷，内存限制 256M |
| perf | prd-api | CDS MongoDB 限制 WiredTiger 缓存 150MB、关闭诊断数据采集，内存限制 256M |
| perf | prd-api | CDS Redis 限制 maxmemory 32MB + allkeys-lru 淘汰策略，内存限制 48M |
| feat | prd-api | CDS 部署模式切换：支持 dev(热重载) / static(编译部署) 两种模式，通过 x-cds-deploy-modes 配置 |
