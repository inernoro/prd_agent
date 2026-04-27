| fix | cds | 前端 CURRENT_PROJECT_ID 不再 fallback 到字面量 'default'。无 ?project= 查询时自动跳 /project-list;?project= 指向不存在项目时也跳走,根除 legacy-cleanup 改名后旧书签产生的"加载项目失败 HTTP 404"
