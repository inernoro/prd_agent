| fix | prd-api | docker-compose.yml / docker-compose.dev.yml 的 api 服务补上 GitHubOAuth__ClientId / ClientSecret / Scopes 三个环境变量映射（docker compose 不会自动转发宿主机 env，必须显式声明），修复 PR Review Agent 提示 "尚未配置 GitHub OAuth App" 的问题 |
| fix | prd-admin | GitHubConnectCard 未配置提示改写：补充 .env 文件写法 / .bashrc 改完需重开终端 / 需要重跑 exec_dep.sh 的操作指引 |
