| ops | prd-agent | docker-compose 新增 llmgw-serve 服务（serving 网关，8091）+ api 注入 LlmGateway__Mode/ServeBaseUrl/LlmGwServe__ApiKey（默认 inproc） |
| ops | prd-agent | cds-compose 接入 llmgw-serve（预览 /gw/v1/* 路由，dev+express 双模式）；_standalone.conf 加 /gw/v1/ → llmgw-serve:8091 反代 |
