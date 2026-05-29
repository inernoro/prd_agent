| fix | cds | supervisor 启动子进程前先 chdir 到 repo cds/ 目录,避免 @reboot crontab(cwd=/root)下 master 按错误 cwd 推算 config/repoRoot、在错误目录读写 state(Codex P1) |
| fix | cds | supervisor stop 超时强杀时连同 node 子进程一起杀(原来只杀 supervisor shell,child 成孤儿继续跑导致下次启动端口冲突)(Codex P2) |
| fix | cds | cds.migrate-to-supervisor 重排序:先写 marker+crontab+起 supervisor,再 detached 停用 systemd,避免"先停 cds-master 把执行迁移的进程自己杀掉、supervisor 还没起"的死局(Codex P1) |
| fix | cds | 迁移后写 .cds-supervisor-mode marker,exec_cds.sh should_manage_with_systemd 见到即强制非 systemd,阻止 self-update 重启把 systemd 单元装回来与 supervisor 抢端口(Codex P2) |
