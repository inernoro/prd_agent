| feat | cds | 新增 ./exec_cds.sh migrate-env 子命令，扫描 .cds.env/.env/~/.bashrc/当前 shell 后按 CDS_ canonical / CDS legacy / 项目级 三类分流，自动写 .cds.env 与 migration-project-env.txt（提示用户去 Dashboard 配置），不动源文件、幂等可重跑 |
| feat | cds | 启动时识别 .cds.env 中的 CDS legacy 旧名（JWT_SECRET / AI_ACCESS_KEY / PREVIEW_DOMAIN / ROOT_DOMAINS / MAIN_DOMAIN / DASHBOARD_DOMAIN / SWITCH_DOMAIN）并打 deprecation warning，引导跑 migrate-env，仍兼容读取 |
| refactor | cds | 新增 cds/src/config/known-env-keys.ts 作为内置环境变量字典 SSOT；getCdsAiAccessKey() 优先读 CDS_AI_ACCESS_KEY，fallback 旧名 AI_ACCESS_KEY |
| fix | cds | runSmokeForBranch 不再用 `...process.env` 整体透传 host 环境给冒烟脚本，改为 PATH/HOME/LANG 等 shell 必需 + SMOKE_* 显式参数的白名单，杜绝 CDS_GITHUB_APP_PRIVATE_KEY 等密钥泄漏到子进程 |
