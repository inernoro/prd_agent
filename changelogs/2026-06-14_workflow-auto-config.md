| feat | prd-api | 工作流对话助手新增「校验+自动接线+自愈+缺项扫描」闭环：AI 生成的工作流自动规范化插槽、按 dataType 自动接线、结构错误回喂 LLM 自愈最多 2 轮，把产物从草稿变可跑件 |
| feat | prd-admin | 工作流助手对话气泡新增自动校验卡：展示校验状态、自动接线说明、待补齐配置/密钥项 |
| fix | prd-api | 修复工作流 from-chat SSE 事件用 `event: message` 包裹导致前端按 data.type 分发失效（workflow_created/generated/delta 事件无法触达） |
| feat | prd-api | 对话助手系统提示注入「暂未开放能力」清单（定时/Webhook 触发），引导 AI 改用手动触发而非静默省略 |
| feat | prd-admin | 工作流自动校验卡的「待补项」改为就地可填表单：填完一键「补齐并应用到编辑器」把值烘焙进节点配置/变量，省去逐节点找配置 |
