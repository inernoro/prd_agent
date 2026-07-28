| docs | cds | 新增 doc/debt.cds.release-system.md 债务台账：阶段一有意延期的 7 条边界 + 真实环境证据清单，并同步 doc/index.yml 与 guide.list.directory.md |
| test | cds | 新增生产发布真 SSH 端到端验收（真 sshd + 真 ssh2 + 真路由，无任何注入）：取消后目标保持占用、取消后不再写目标机器、回滚过同一道并发闸、排空期间 /releases/* 拿 503；四条逐条红绿闭环，本机无 sshd 时整套自动跳过 |
| test | cds | 新增提缺陷转发真 HTTP 端到端验收（本地假 MAP + 真 global fetch/FormData）：断言 create → attachments → submit 的真实顺序与真实字节，以及附件上传失败时如实降级 |
| test | llmgw | 前端附件总量闸用真实 5MB 量级 base64 验证：两张 5MB 图必须在前端就被拦下（base64 口径），单张 5MB 不误伤 |
