| feat | prd-api | 支持多对象存储 Provider 切换（tencentCos / cloudflareR2），通过 ASSETS_PROVIDER 环境变量选择 |
| refactor | prd-api | 补全 IAssetStorage 接口（TryDownloadBytesAsync、ExistsAsync），消除 14 处 TencentCosStorage 类型耦合 |
| feat | prd-api | 新增 CloudflareR2Storage 实现（S3 兼容 API，AWSSDK.S3），支持 Cloudflare R2 对象存储 |
| refactor | prd-api | Base64 扩展方法改为基于 IAssetStorage 接口，不再绑定具体存储实现 |
