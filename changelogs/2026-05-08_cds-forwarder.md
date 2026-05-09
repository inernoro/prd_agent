| feat | cds | 新增独立 forwarder 进程(cds-forwarder.service)替代蓝绿部署 — 业务流量与 self-update 物理隔离,daemon 重启 *.miduo.org 不再抖动 |
| feat | cds | 新增 ForwarderRoutePublisher,daemon 周期把 running 分支表写到 .cds/forwarder-routes.json,forwarder 进程 fs.watch 增量加载 |
| feat | cds | exec_cds.sh 新增 forwarder-run + install-forwarder 子命令,sudo 一次即可安装 systemd unit + 开机启动 |
| feat | cds | nginx 模板 cds_worker upstream 在 CDS_USE_FORWARDER=1 时切到 forwarder 端口(默认 9090) |
| refactor | cds | 蓝绿改为 opt-in:默认禁用 supervisor;需要重启用蓝绿设置 CDS_USE_BLUE_GREEN=1(原 CDS_DISABLE_BLUE_GREEN=1 仍兼容) |
