| refactor | cds | 合并 exec_cds.sh / exec_setup.sh / nginx/init_domain.sh / nginx/start_nginx.sh 为单一入口 cds/exec_cds.sh，命令收敛为 init/start/stop/restart/status/logs/cert |
| feat | cds | start 默认后台运行（nohup + PID 文件），--fg 进入前台；新增 init 交互式初始化写入 cds/.cds.env 并自动渲染 nginx 配置 |
| feat | cds | CDS_ROOT_DOMAINS 支持逗号分隔多根域名，每个根域名 D 自动生成三条路由：D → Dashboard、cds.D → Dashboard、*.D → Preview，miduo.org 与 mycds.net 可同时使用 |
| feat | cds | nginx 配置改为每次启动根据 .cds.env 重新渲染（cds/nginx/cds-site.conf），存在 certs/<domain>.crt 自动启用 HTTPS，缺省 HTTP-only 兜底 |
| refactor | cds | 根目录 exec_cds.sh 改为转发器，所有业务逻辑集中在 cds/exec_cds.sh；删除 host-env.example.sh 等遗留配置入口 |
| docs | doc | 更新 guide.cds-env.md 和 guide.quickstart.md 对齐新脚本接口，移除 .bashrc / exec_setup.sh / CDS_SWITCH_DOMAIN 等废弃表述 |
