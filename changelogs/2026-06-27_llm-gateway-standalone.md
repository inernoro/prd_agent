| feat | prd-llmgw | 新增独立 AI 大模型网关观测后端（自包含 ASP.NET 服务，共享 Mongo 读 llmrequestlogs，独立 JWT 账号体系，/gw/auth/login + /gw/logs/* 端点） |
| feat | prd-llmgw-web | 网关前端独立站补 Dockerfile + nginx（SPA 回退 + /gw 反代 llmgw:8090） |
| ops | prd-agent | docker-compose 的 llmgw/llmgw-web 切换到独立 prdagent-llmgw / prdagent-llmgw-web 镜像（不再复用 api 占位镜像） |
