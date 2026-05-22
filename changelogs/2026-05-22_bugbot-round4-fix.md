| fix | prd-admin | 修复 Bugbot Medium：MySharesPage「字母统一长链」/s/{token} 仅在 shortSeq>0（已注册 ShortLink）时展示——否则与 /s/{seq} 同样 resolve missing，避免给出打不开的可复制链接 |
| fix | prd-api | WebPagesController + ReportAgentController：unifiedShareUrl 仅在 ShortSeq>0 时返回（否则 null），与 shortShareUrl 同条件，未注册 ShortLink 时只暴露有效的带前缀长链 |
