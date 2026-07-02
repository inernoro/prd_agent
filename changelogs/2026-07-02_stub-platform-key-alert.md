| fix | prd-api | Stub 开发桩标记为无需 API key，避免占位密文解不开时反复触发平台密钥事故告警 |
| fix | prd-admin | 一键创建 Stub 平台不再写入占位 API key 密文 |
| ci | prd-admin | 修正 pnpm-workspace allowBuilds/packages 配置，兼容 CI 获取 pnpm store path |
