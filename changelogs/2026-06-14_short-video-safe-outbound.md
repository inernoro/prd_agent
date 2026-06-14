| security | prd-api | 短视频素材与视频转文字下载改用 SafeOutbound 校验，阻断内网地址 SSRF |
| security | prd-api | 模型平台 API key 加密改为独立 ApiKeyCrypto__Secret，兼容旧 JWT 密文并支持自动迁移 |
| security | cds | 项目容器不再使用 CDS_JWT_SECRET 兜底注入 Jwt__Secret，避免 CDS 自身密钥轮换穿透业务项目 |
