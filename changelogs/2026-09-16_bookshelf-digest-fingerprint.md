| feat | prd-api | 精读稿新鲜度判据加入材料指纹，改挂规则后旧稿自动重生成 |
| refactor | prd-api | 取稿与生成两处的新鲜度判断收敛成唯一函数 IsFresh |
| docs | doc | 新增公共藏书阁精读稿设计文档，四层存储与两维判据成文 |
| fix | prd-admin | 藏书阁进度登出即清，修复换账号后串数据 |
| fix | prd-api | bookshelf_progress 唯一索引补进 DBA 可执行清单 |
| fix | prd-api | bookshelf_progress 与 book_digests 补进 DataSyncScope 分类 |
| fix | prd-api | AppCaller golden 快照补上精读稿那一条 |
| fix | prd-api | 结业考及格与否改由服务端算，不再采信前端送上来的 passed |
| fix | prd-api | 成绩合并先比是否计入通关再比分数，修复裸考满分后读完整卷永远不通关 |
| fix | prd-admin | 本地成绩合并对齐服务端口径，已通关记录不再被裸考重考覆盖 |
| fix | prd-admin | 进度保存加在途序号守卫，先发后到的响应不再改错同步状态 |
| fix | prd-admin | 藏书阁对错标记改用 SVG icon，去掉勾叉字形 |
| chore | prd-api | 精读稿生成补上 LlmRequestContext 作用域，请求日志可归因到具体点击 |
