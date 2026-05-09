| fix | cds | cds-forwarder.service ReadWritePaths 改为 /opt/prd_agent/cds(原父路径未被 install-forwarder 的 sed 替换,导致 systemd 报 mount namespacing 失败拒启) |
| fix | cds | install-forwarder 增加父路径 sed 替换 + 自动写 CDS_USE_FORWARDER=1 到 /etc/cds/env(让 master 重启后启动 publisher) + reset-failed 清失败窗口 |
| refactor | cds | 取消 master workerPort listener 的 CDS_USE_FORWARDER 门控:master 5500 与 forwarder 9090 不冲突,bootstrap 期间双活作 defense in depth |
