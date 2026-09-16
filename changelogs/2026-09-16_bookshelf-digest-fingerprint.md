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
| fix | prd-api | 精读稿认网关的 Error 块，中断的半篇不再落库成公共稿子 |
| fix | prd-api | 材料整份载入失败与「书单里没有这本书」分开报，不再压成同一句 404 |
| fix | prd-api | book_digests 的 BookId 唯一索引进 DBA 清单，并发首次生成不再写出两篇 |
| fix | prd-api | 精读稿提示词给第一段补逃生口，模型对这本书没把握时明说而不是编 |
| fix | prd-admin | 在途的进度拉取也随登出作废，堵住换账号串数据的另一半 |
| fix | prd-admin | 书页笔记跟随服务端 hydration，修复聚焦失焦即删掉已有笔记 |
| fix | prd-admin | 配图清单拉取失败时停用生成按钮，不再照着空清单花钱重画已有的图 |
| fix | prd-api | 成绩合并改比得分率，卷子改版后不会被题数变化倒置好坏 |
