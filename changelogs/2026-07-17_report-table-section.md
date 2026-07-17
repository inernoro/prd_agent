| feat | prd-api | 周报模板新增"表格"章节类型：模板定义默认列，周报保存支持行 cells 与列增删合并进快照，AI 生成/Markdown 导入/规则兜底全链路支持表格行解析 |
| feat | prd-admin | 周报模板管理章节类型下拉新增"表格"（内嵌列编辑器），周报编辑器表格章节支持增删行、增删列、列改名，详情页/详情面板只读表格渲染 |
| fix | prd-api | 手动创建周报的模板快照深拷贝补齐 SectionType/DataSources/IssueCategories/IssueStatuses 字段（原漏拷导致手动创建的问题章节丢失分类/状态预设） |
| test | prd-api | ReportImportMarkdownTests 补表格章节导入 prompt schema 与 markdown 表格行兜底解析用例 |
