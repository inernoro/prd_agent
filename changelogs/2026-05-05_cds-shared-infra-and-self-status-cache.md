| fix | cds | startInfraService 改为幂等：共享 mongo/redis 等 long-lived infra 容器在 deploy 时不再被 docker rm -f 强删（保护用户正在使用的连接），running 直接复用、stopped 改用 docker start 唤醒、不存在才创建 |
| perf | cds | /api/self-status?probe=remote 加 60 秒 in-process 缓存，前端 GlobalUpdateBadge 反复轮询不再每次触发 git fetch（之前 5-10 秒导致页面整体卡） |
