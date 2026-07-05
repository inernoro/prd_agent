| chore | ops | docker-compose.yml/dev 新增 llmgw（占位复用 api 镜像，端口 8090，read_only+tmpfs，注入 Mongo/ApiKeyCrypto/独立 LlmGwJwt 密钥）+ llmgw-web 静态站 service |
| chore | ops | deploy/nginx _standalone.conf 新增 /gw/ → llmgw:8090 路由（SSE proxy_buffering off + 长超时）及 8081 独立 server 块托管 llmgw-web 静态站 |
| chore | ops | cds-compose.yml 新增 llmgw + llmgw-web service（dev/static/express 三模式 + healthcheck label + cds.path-prefix）+ x-cds-env 补 LLMGW_JWT_SECRET |
| ci | ops | branch-image.yml 新增 llmgw / llmgw-web 镜像构建 job（path-filter 触发 + Dockerfile 存在性探测兜底，tag 规则 sha-/branch- 同 api/admin） |
| chore | ops | exec_dep.sh 补 PRD_AGENT_LLMGW_IMAGE（默认与 api 同源），llmgw 随 compose up 一起拉起 |
