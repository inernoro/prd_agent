| feat | prd-llmgw-serve | 新增独立 LLM serving 网关进程（PrdAgent.LlmGateway 升级为 ASP.NET 服务，DI 承载现有 LlmGateway/ModelResolver，HTTP 暴露 /gw/v1/{resolve,send,stream,raw,pools}，可被 MAP 及外部跨进程调用） |
| refactor | prd-api | 移除 Api 对 PrdAgent.LlmGateway 的 ProjectReference，serving 网关与 api 主镜像彻底解耦（其编译错误不再阻塞 MAP 部署） |
| ci | prd-agent | branch-image 新增 llmgw-serve-image 构建任务（prdagent-llmgw-serve 镜像，随 api path-filter 触发） |
