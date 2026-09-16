| feat | prd-admin | 新增公共藏书阁 /bookshelf：七卷心路历程书目（46 本）+ 25 道结业考题，按团队真实抱怨编排痛点药方表 |
| feat | prd-admin | 藏书阁支持开发者 / 产品经理双线筛选、已读标记、每卷结业考与逐题解析 |
| test | prd-admin | 新增藏书阁内容守卫 17 条（答案下标越界 / 痛点指向空卷 / 空话文案 / 卷题覆盖），已过红绿闭环 |
| test | prd-admin | 新增藏书阁闭环验收脚本 e2e/bookshelf-acceptance.mjs：双主题真浏览器走完 入口-展开-开考-交卷-解析，断言产物可见 |
| refactor | prd-admin | 藏书阁改为 Linear 视觉基准：列表密度优先（行高 40px / 圆角 6px / 正文 13px），左卷右书 list-detail 取代折叠卡片，痛点入口收成 chip 行 |
| refactor | prd-admin | 藏书阁改用智识殿堂的粗野骨架 + 30px 细网格底 + 五色分卷配色，浅暗双皮肤 |
| feat | prd-admin | tokens.css 新增 8 个 --shelf-* token（墨边/硬投影色/网格线/五色图标盒），暗浅双档双写 |
| feat | prd-api | 藏书阁进度上后端：BookshelfProgress 实体 + 三个端点（我的进度读/写、团队看板），UserId 唯一索引 |
| feat | prd-admin | 新增团队看板：每卷通关人数、成员进度行、「全队最薄弱的一卷」结论 |
| refactor | prd-admin | 藏书阁进度改为服务端优先、本地兜底；拉不到时保留本地记录不清空 |
| rule | platform | 新增 visual-anchor-first 规则：没拿到视觉锚点前不许凭空赌品味，主观词要变成带实测数值的档位表 |
| docs | platform | debt.frontend.md 藏书阁条目：两条结清（进度上后端、团队看板），四条新增（并发合并、同步失败提示、看板分页、卷六偏理论） |
| fix | prd-admin | 藏书阁同步失败不再沉默：页面亮状态条 + 手动重试 + 网络恢复自动补发；连点合并为一次请求 |
| test | prd-admin | 新增同步层守卫 10 条（失败亮态/不回滚/完整快照重试/防抖），已过红绿闭环 |
| feat | prd-admin | 藏书阁支持深链 ?vol=<卷id>，可把某一卷的链接直接甩给人；未知参数回落首卷 |
| test | prd-admin | 新增深链守卫 4 条，解析规则抽成唯一导出供测试导入（首版复刻判据导致改坏不红，已修） |
| feat | prd-admin | 藏书阁卷六「驭 AI」补 5 本实操书（怎么审 AI 写的代码）与 3 道考题 |
| test | prd-admin | 新增守卫「每卷至少三本 level ≤ 2 的可上手书」，验收脚本补卷六双主题断言 |
| docs | platform | debt.frontend 结清卷六书目缺口一条 |
| fix | prd-api | 藏书阁三个端点改用 ApiResponse 包装，补齐 error 键（缺它前端判否，看板白屏） |
| fix | prd-admin | 团队看板对畸形上游数据降级而非崩页 |
| test | prd-admin | e2e 补「服务端真的返回了数据」与「畸形上游响应」两条路径 |
| polish | prd-admin | 痛点文案从逐字引用同事原话改写为处境描述，移除页面上的真人姓名 |
| test | prd-admin | 新增守卫拦截原话回流（转述痕迹词） |
| merge | platform | 合并 main（含 llmgw 读方 schema 容忍修复），llmgw-serve 容器恢复 |
| feat | prd-admin | 结业考区分摸底与结业：成绩记住「当时读了几本」，裸考给出先读哪本 |
| feat | prd-api | 通关口径改为读过+通过，裸考通过单列 blindPassedByVolume |
| test | prd-admin | 新增 examContext 判据守卫与成绩往返守卫（读写两个方向） |
| fix | prd-admin | 藏书阁桌面档点痛点卡/卷卡后滚到书目区，不再只换选中色（卡片写着「去 XX」却不带人去） |
| test | prd-admin | 新增 2 条守卫（接线 + scrollIntoView 真实存在）与 e2e 位移判据（量书目区 boundingRect 是否进入视口） |
| feat | prd-admin | 藏书阁每本书可写一句心得（唯一的「学习」动作），看板显示心得条数 |
| feat | prd-api | 进度新增 BookNotes 字段，整包覆盖并清洗空白与超长 |
| feat | prd-admin | 移动端首页补藏书阁入口（此前手机用户只能靠别人发链接） |
| feat | prd-admin | 结业考题库 28 → 43 题，每卷至少 6 题 |
| polish | prd-admin | 藏书阁手机档对齐 appStoreTokens 的版式刻度，治「不整齐」 |
| test | prd-admin | 补心得往返守卫与每卷题量下限守卫 |
| fix | prd-admin | 藏书阁手机端左右留白不等（左12/右44），改全出血 + 对称内边距 |
| test | prd-admin | e2e 补手机端左右留白守卫，量真实 boundingRect |
| feat | prd-admin | 藏书阁手机档按 390 设计终稿重做：落地页与卷页拆成两级导航，七卷改 iOS 分组清单，处境卡横滑 |
| feat | prd-admin | 藏书阁手机档新增整屏答题与结果页（逐题对错 + 解析 + 错题指向的书），替代桌面弹窗 |
| feat | prd-admin | 藏书阁手机档新增整屏团队看板，结论先行（最薄弱的一卷）再给每卷通关人数与成员明细 |
| refactor | prd-admin | 抽出 useExamSession 与 useTeamBoard 作唯一判定源，桌面与手机共用，避免两侧各自算分与各自防御 |
| refactor | prd-admin | 手机档版式档位全部收敛到 appStoreTokens；粗野骨架（3px 墨边 / 硬投影 / 整卡五色底）退出手机档 |
| test | prd-admin | 新增 14 条手机档守卫（深链解析、四屏接线、档位出处、墨边退场、桌面未被改动），并补 e2e 手机端两级导航双主题闭环 |
| fix | prd-admin | 藏书阁卡片面改用自有实色档（暗 #303038 / 浅 #FDFBF8），相对底色亮度差从 +18.9 提到 +28.5，不再发虚 |
| fix | prd-admin | 嵌块按主题给方向：暗档比面更亮（iOS 惯例，暗色无法再往更暗走），浅档比面更暗 |
| test | prd-admin | 新增守卫：面与底色的亮度差有下限（暗 24 / 浅 14，浅档受纯白天花板约束），嵌块方向按主题判 |
| feat | prd-admin | 藏书阁手机端新增书页（第三级，`?vol=x&book=y`）：进去就读精读稿，没有就按需生成并逐字流式渲染；卷页书行从「就地展开写心得」改为「点进去读」 |
| fix | prd-admin | 藏书阁精读稿补 renderMarkdown，markdown 不再以原始语法裸露 |
| feat | prd-admin | 新增精读稿专用 markdown 渲染器，二三级标题保留真实层级 |
| fix | prd-api | 精读稿提示词分开材料用途：规则材料只供第三段，前两段只讲这本书 |
| fix | prd-api | 提示词版本升 v2，旧版稿子不再复用，进页自动重写 |
| fix | prd-api | 精读稿生成改用 CancellationToken.None，读者中途退出不再掐断整篇生成 |
| fix | prd-api | 精读稿重写时沿用库里那份 _id，修复 Mongo code 66 导致「重新生成」永远存不下 |
| feat | prd-admin | 藏书阁 50 本书逐本填上 relatedRules，精读稿第三段有料可写 |
| feat | prd-api | 藏书阁新增精读稿：按需生成（第一个点进这本书的人触发）、SSE 流式、一本一篇全站共享；提示词强制第三段只能引用本仓库真实规则与事故，不许编 |
| feat | prd-admin | 书目新增 relatedRules（书 → `.claude/rules/` 的映射），并生成后端可读的书目上下文（含规则导读与历史事故），两条守卫钉住它与源头一致 |
| feat | prd-admin | 新增「系统配图」：全站由模型生成的图片统一到系统设置一屏，按模块分组、三层提示词（拍法/画面描述/落点）、支持单张与整组重生成、一键补齐全站缺失 |
| feat | prd-admin | 公共藏书阁接入七卷卷面图，同一张同时用于卷页通栏、手机七卷行缩略、处境卡顶图与桌面当前卷卡；未生成时回落卷序汉字方块，零配图仍成立 |
| refactor | prd-admin | landingPreviewSlots 提升为 lib/imagery 系统级注册表（模块只声明图位，接新模块不改设置页），新增拍法「书脊静物」，设置页「首页预览图」并入「系统配图」并保留老链接别名 |
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
| fix | prd-admin | 本地成绩判据收敛到 examContext.isBetterExam，改比得分率，与服务端口径重新对齐 |
| fix | prd-admin | 精读稿署名常驻并补上平台，库里那篇也看得见是谁写的 |
| fix | prd-admin | 取稿等待期给产物形状的骨架与秒表，不再是一句不动的话 |
| fix | prd-admin | 落地页心得条数按角色过滤，与已读数同一个分母 |
| fix | prd-admin | 满分时不再显示「错的那几处」 |
| fix | prd-api | 进度并发首存撞唯一索引时重试合并，不再 500 丢掉这一发的快照 |
| fix | prd-admin | 本地有未同步改动时不接受服务端快照，先推上去，断网标的已读不再消失 |
| docs | doc | 精读稿设计文档删掉逐文件实现表（AGENTS.md §10：实现细节不进文档） |
| fix | prd-admin | 登出清理改由 authStore 饿加载路径发起，没进过藏书阁也能清掉上一个人的数据 |
| fix | prd-admin | 在途请求期间又改动时不再误清 dirty，最后一笔编辑不会被服务端旧快照盖掉 |
| fix | prd-admin | 配图清单失败时三个生成入口全部停用，上一版只守住了顶部那个 |
| fix | prd-api | 精读稿 SSE 补 10 秒 keepalive 心跳与写入串行化，长静默不再被代理掐断 |
| fix | prd-admin | 「再试一次」改为不强制重生成，连接断了不再多烧一篇并覆盖已落库的稿子 |
| fix | prd-api | 精读稿按部署作用域隔离，兄弟分支不再互相判过期、互相覆盖、反复重烧 |
| fix | prd-api | book_digests 唯一索引改为 BookId + DeploymentSlug 复合 |
| fix | prd-api | book_digests 复合索引沿用原名并声明旧定义，迁移掉只按 BookId 的那条 |
| fix | prd-api | 撞唯一索引后回头确认本作用域真有稿子，不再把永久失败当成「别人写好了」 |
| fix | prd-admin | 联网恢复的补推判据改看 dirty，断网重载后的改动不再永远推不上去 |
| fix | prd-admin | 桌面档笔记框也跟随 hydration，修复登录后立刻写一句会删掉已有笔记 |
| fix | prd-admin | 复用已有稿子时不再清空引用规则，「这一篇对上的是我们自己的」不再消失 |
| fix | prd-admin | 配图清单闸挪进 generate() 咽喉处，绕过按钮的入口也挡得住 |
| fix | prd-admin | 换号（不经过登出）也清上一个人的数据，跨账号串数据的第四条路径堵上 |
| fix | prd-api | 精读稿落库前要求见过终止块，上游流无声截断的半篇不再落成公共稿子 |
| fix | prd-admin | 慢回来的进度 GET 不再盖掉期间改过的本地状态，避免本地与服务端一起退回旧快照 |
| fix | prd-admin | 手机档考试屏绑到卷上，浏览器返回后点开另一卷不再带着上一卷的作答与成绩 |
| docs | prd-agent | 精读稿设计文档改回与代码一致：稿子按部署作用域隔离，兄弟分支读不到彼此新生成的那篇 |
| fix | prd-admin | 同步失败告知条抽成两档共用的组件，手机端不再静默失败 |
| fix | prd-admin | 桌面档 ?vol= 变回缺省或认不出时跟着回落首卷，不再停在上一次选的那一卷 |
| fix | prd-api | 系统配图 URL 带上自己的版本号，重新生成同一槽位后浏览器与 CDN 不再喂旧图 |
