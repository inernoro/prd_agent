| fix | cds | C-4.1 严重漏洞修复:/api/_internal/promote 公网可调 — nginx 反代下 socket.remoteAddress 永远是 127.0.0.1,IP 校验完全失效。改用 token 双因子认证(随机 256-bit secret 落 .cds/internal-token 0600,timing-safe 比对) |
| feat | cds | 蓝绿默认开启 — 去掉 CDS_ENABLE_BLUE_GREEN 开关,supervisor 实例化即默认走蓝绿。CDS_DISABLE_BLUE_GREEN=1 仍是紧急熔断。运维零额外配置 |
