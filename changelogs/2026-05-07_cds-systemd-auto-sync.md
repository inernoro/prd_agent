| feat | cds | systemd unit 自动同步：daemon 启动时如果检测到 /etc/systemd/system/cds-master.service 与 repo 模板 drift（且当前是 root），自动重写 + systemctl daemon-reload + 备份旧文件，UI drift banner 永远不再要求用户手动 sudo |
