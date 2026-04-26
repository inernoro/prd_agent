| fix | cds | exec_cds.sh cert 子命令在缺少 crontab 的系统(Amazon Linux 2023 / 最小化 RHEL)上会卡在 acme.sh 安装的 Pre-check 失败:新增 ensure_crontab 自动安装 cronie/cron + 启用服务,失败时回退到 --force,并校验 acme.sh 真实落盘 \$HOME/.acme.sh/acme.sh,避免后续盲目调用不存在的二进制 |
| fix | cds | nginx_up 失败时把 docker compose up -d 的真实输出打到 stderr 而不是吞掉,cert_cmd 在 nginx 无法启动时直接退出而不是继续走 HTTP-01 (注定失败) |
| fix | cds | detect_os 识别 amzn / amazon (Amazon Linux),按 RHEL 系处理 |
