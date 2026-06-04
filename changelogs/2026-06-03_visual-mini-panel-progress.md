| fix | prd-admin | 智能体·视觉创作 mini 面板：生图等待从静态 spinner 升级为爬升进度条 + 分级状态文案(含模型名/已用时) + 取消按钮，消除 30s+ 空白等待；新增 genPhaseText 单测 |
| feat | prd-admin | 视觉创作 mini 面板生成结果支持点击全屏放大(lightbox + ESC/点击关闭 + 原图/下载)，解决 640px 抽屉里图太小看不清 |
| refactor | prd-admin | 视觉创作 mini 面板移除内嵌的千行水印编辑器(水印由视觉创作统一管理/服务端自动叠加)；模型/尺寸行在无可选项时整行隐藏(奥卡姆剃刀) |
| refactor | prd-admin | 知识库文档「再加工」入口按钮(下拉菜单 + 工具栏)更名为「智能体」 |
| feat | prd-api | 知识库智能体抽屉对话后端持久化:新增 document_store_conversations 集合 + GET/PUT/DELETE conversation 端点(按 userId+entryId upsert,不走 Run 规避旧"污染新会话"bug),修复关浏览器标签页对话全清空 |
| feat | prd-admin | 智能体抽屉接入对话后端持久化:开抽屉从后端恢复(优先于 sessionStorage,避开旧 run 污染)、去抖落库、"开启全新对话"清后端;mini 面板「已生成未插入」图随对话持久化 + 重开回填 |
| fix | prd-admin | 智能体抽屉:取消挂起的去抖后端保存于"新对话"清空前 + 切换文档时,杜绝 pending save 在 DELETE/切换后落库把旧对话复活或写错文档(Bugbot/Codex P2/Medium) |
| fix | prd-admin | 视觉创作 mini 面板同步 initialResult/initialPrompt 的后续 prop 变化:修复后端异步回填的暂存图被隐藏、"为这段配图"重新预填不生效(Bugbot Medium) |
