| feat | prd-api | MCP 接入台第一期后端：新增能力目录（视觉创作/文学创作/知识库/网页托管/海鲜市场）作为 scope 与工具的唯一事实源 |
| security | prd-api | 签发 AgentApiKey 时校验用户自身权限位与请求 scope 的交集，鉴权时对新 scope 二次核对，权限被回收后旧密钥即刻失效 |
| feat | prd-api | 新增视觉创作、文学创作、网页托管三个开放接口层，知识库开放层补写入端点（建库/写文档/改正文），均走 sk-ak + scope + boundUserId |
| feat | prd-api | MCP 内置工具从 5 个扩到 18 个，新增生图、创作、知识库写入、网页托管、市场取用类工具 |
| refactor | prd-api | scope「写蕴含读」判据收敛到能力目录一处，不再按资源名硬编码 document-store |
