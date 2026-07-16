| fix | cds | 修复删除带 TCP 外部访问代理的分支后，残留 enabled 策略仍把代理名算作 active、导致孤儿收割器跳过仍公网暴露的 resource-external-access 容器（getActiveExternalAccessProxyContainerNames 增加归属分支存活校验，Codex P1） |
| fix | cds | cds-self compose 构建命令加 node_modules 自愈守卫：装依赖前探 .bin/tsc、.bin/vite 软链是否可执行，缺失即 rm -rf 该 node_modules 逼一次干净全装，根治 bind-mount worktree 下增量安装被并发/打断留半链导致 tsc 构建 exit 1 崩溃 |
