| fix | prd-admin | 修复直接打开页面时网络波动导致误注销问题（App.tsx 仅在 UNAUTHORIZED 时注销，DISCONNECTED/SERVER_UNAVAILABLE 不再触发 logout） |
| fix | prd-api | 修复生图消息记录中泄漏系统前缀的问题（ImageGenRunWorker 存储 [GEN_DONE]/[GEN_ERROR] 时统一剥离 "Generate an image based on the following description:" 前缀） |
| fix | prd-api | 修复参考图风格提示词泄漏到消息记录的问题（ImageGenRunPlanItem 新增 DisplayPrompt 字段保存用户原始 prompt，ImageGenController 和 LiteraryAgentImageGenController 在追加风格提示词前先保存原始 prompt） |
