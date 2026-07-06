| feat | prd-api | 新增 LLM Gateway pinned platform/model 精确调用链路，ModelLab/Arena 可经网关保持选定模型语义 |
| feat | prd-api | 打通 LLM Gateway multipart raw HTTP 跨进程文件引用协议，支持对象存储上传与 serving rehydrate 校验 |
| feat | prd-api | 将 LLM Gateway shadow 证据与 serving 请求日志切入独立 llm_gateway 数据域，MAP 业务日志继续留在 MAP |
| ops | scripts | 新增 LLM Gateway 发布前证据门脚本，统一检查 serving healthz、shadow 样本数、critical/httpFail 清零 |
| ops | deploy | exec_dep.sh 在 LLMGW_MODE=http 时强制执行 LLM Gateway 发布证据门，阻止无 shadow 证据的全量切换 |
| refactor | prd-api | 收口 Program、ModelDomainService、ModelLab、Arena 直连上游客户端，直连棘轮 baseline 清零 |
| test | prd-api | 补充 pinned model、multipart raw HTTP 与 GW 数据域守卫测试，并同步网关 serving/shadow/key gate 合约 fake 签名 |
