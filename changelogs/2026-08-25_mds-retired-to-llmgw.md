| feat | llmgw | OpenAI 与 OpenRouter 两个上游 Provider 接入网关控制台并导入模型（连接测试双绿） |
| refactor | prd-admin | 模型管理四个 tab（应用模型池/模型池/平台/中继）整套下线，`/mds` 改为指向 LLM Gateway 控制台的墓碑页 |
| refactor | prd-admin | LLM 实验台移除「设为主/意图/视觉/生图模型」写入口，上游模型弹窗移除「主模型分类」写回入口 |
| refactor | prd-api | 新增 `MdsWriteRetiredFilter`：`api/mds` 下的写操作统一 410 并指路网关，读接口与运行时解析路径原样保留 |
| test | prd-api | 新增 `MdsWriteRetiredGuardTests`：按路由模板断言写挡读放，并守住闸的全局注册与豁免清单长度 |
