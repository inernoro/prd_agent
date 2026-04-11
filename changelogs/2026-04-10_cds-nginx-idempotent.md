| fix | cds | exec_cds.sh 的 nginx 渲染改为内容对比后才写盘 (write_if_changed)，避免每次 start 都误打印"配置已生成"噪音，自更新时 docker compose 真正感知到"无变化"而不重启容器 |
| feat | cds | 当 cds-site.conf / nginx.conf 发生变化且容器已在运行时，自动 nginx -t 校验 + nginx -s reload 热重载，用户新加的根域名立刻生效且无停机 |
