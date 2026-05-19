| fix | cds | 分支「停止」改为只 docker stop 保留容器（不再 docker rm），停止后「重新启动」可秒级 docker restart 唤醒，无需重新部署 |
| refactor | cds | ContainerService 拆分 stop（暂停保留）/ remove（销毁），删分支/重置/孤儿清理/force-rebuild/janitor 等销毁路径改用 remove |
| feat | cds | 主动停止前写入 [CDS-STOP] 哨兵到容器日志末尾，配合 lastStopSource 账本区分「正常停止」与「莫名崩溃」，异常退出现场日志得以保留待查 |
