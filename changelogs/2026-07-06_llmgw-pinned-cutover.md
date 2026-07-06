| feat | prd-api | 新增 LLM Gateway pinned platform/model 精确调用链路，ModelLab/Arena 可经网关保持选定模型语义 |
| feat | prd-api | 打通 LLM Gateway multipart raw HTTP 跨进程文件引用协议，支持对象存储上传与 serving rehydrate 校验 |
| refactor | prd-api | 收口 Program、ModelDomainService、ModelLab、Arena 直连上游客户端，直连棘轮 baseline 清零 |
| test | prd-api | 补充 pinned model 与 multipart raw HTTP 契约测试，并同步网关 serving/shadow/key gate 合约 fake 签名 |
