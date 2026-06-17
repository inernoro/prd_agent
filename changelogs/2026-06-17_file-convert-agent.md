| feat | prd-api | 新增文件批量转换智能体（file-convert-agent）：FileConvertController / FileConvertWorker / FileParserService / TemplateRendererService，支持 CSV/Excel/JSON 源文件 + Word/Excel 模板批量生成 ZIP |
| feat | prd-api | 新增 MongoDB 集合 file_convert_tasks / file_convert_rules，支持任务状态跟踪与规则持久化 |
| feat | prd-admin | 新增 FileConvertPage（三步式：上传→映射→生成），SSE 实时进度推送，历史任务侧边栏 |
| feat | prd-admin | 新增 fileConvertService.ts，规则 CRUD + 文件上传解析 + 任务管理 API |
| feat | prd-admin | 百宝箱注册 file-convert-agent 条目（wip: true），navRegistry 路由 /file-convert-agent |
