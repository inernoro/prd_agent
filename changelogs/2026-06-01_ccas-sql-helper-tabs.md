| feat | prd-admin | ccas-agent 新增「SQL助手」tab：内置 IN 转化、按行去重两个子工具，纯前端字符串处理零回传 |
| chore | prd-admin | ccas-agent 使用帮助抽屉去掉「封面图在哪加」一节，该信息属管理员后台职责，不在终端用户文档里赘述 |
| feat | prd-admin | ccas-agent SQL助手新增「常用语句」子 tab：内置陈智版 / 米多版 4 条排查 SQL，支持搜索 + 一键复制 + 方言徽章；数据/UI 分离，加新条目只动数据文件 |
| refactor | prd-admin | ccas-agent SQL助手「常用语句」改为左目录右内容布局，左右独立滚动；同步把 IN 转化 / 去重 / 容器层 overflow 重新分层，避免外层全局滚动跟内部 textarea 滚动打架 |
| feat | prd-api | ccas-agent 新增 `POST /api/ccas-agent/sql-ai/stream` SSE 端点，CcasSqlAiPrompts 把陈智版（BagCode/BoxCode 嵌套）+ 米多版（字段拍平）schema 内化进 system prompt，按方言 + 关联模式动态拼接 |
| feat | prd-admin | ccas-agent SQL助手新增「AI 助手」子 tab：自然语言提问 → SSE 流式生成可执行 SQL + 中文业务说明；顶部数据库版本 / 关联模式切换；复制 SQL 智能提取 fenced 代码块；满足 ai-model-visibility 顶部模型徽章 |
