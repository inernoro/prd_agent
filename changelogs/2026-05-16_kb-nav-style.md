| fix | prd-api | 知识库总访问量按行业做法去重：同一访客 30 分钟窗口内重复打开/刷新同一文档不再 +1，独立访客与总时长基于全量事件聚合 |
| fix | prd-admin | B9 知识库"发布到智识殿堂"按钮由灰色 surface-action 改为 surface-action-accent，明确可点击 |
| fix | prd-admin | B1 知识库文档浏览器去掉额外 px-5 双重内缩，卡片左右与上方 TabBar 边缘对齐，消除左上角空白竖条 |
| feat | prd-api | B4 划词评论支持"不选中也能评论"：SelectedText 为空时按全文评论接受，不再 400，不参与 rebind |
| feat | prd-admin | B4 评论抽屉无选区时也可输入并提交全文评论，卡片展示"全文评论"标签 |
| fix | prd-admin | B6 划词选区改以 selectionchange 为主信号 + dblclick 兜底 + 防抖，双击选行/拖拽选区稳定保留不再瞬间消失 |
| feat | prd-admin | F1 知识库文档预览右侧新增"本页章节"导航（TOC），slug 复用正文规则、点击平滑滚动、IntersectionObserver 高亮当前标题，无标题/窄屏自动隐藏 |
| feat | prd-admin | F2 借鉴文档站观感优化知识库正文排版：更大行距/字号、标题上间距强化层级、列表/引用/代码块留白加大、底部留白；H1/H2/表格/hr 边框由硬编码白改主题 token（修白天主题不可见） |
| feat | prd-admin | F3 知识库左侧文件夹改为"章节分组"样式：加粗放大标题、上下分隔线、折叠箭头移到右侧、子项缩进更清晰；不改拖拽/右键/主文档逻辑 |
| fix | prd-admin | B6 二次修复：选区 offset 定位由"indexOf 失败即丢弃选区"改为分级回退（精确→空白归一化→行首标记剥离→兜底），定位失败也照常产出选区，blockquote/标题/列表项双击或拖拽选中稳定保留且"添加评论"浮层必现，修复划词后浮层不出现的回归 |
| fix | prd-admin | 知识库文档标题/正文/TOC 统一走新增 lib/frontmatter.ts 的 parseFrontmatter：左侧"正文标题"识别 YAML frontmatter 的 title 并去成对引号、无 title 回退首个正文标题；MarkdownViewer 与 TOC 不再把首个 ---/title:/description: 块当正文渲染 |
| fix | prd-admin | 知识库未选中文件时的预览占位图标由 FileText 改为书籍语义 BookOpen（加载中态仍走 MapSectionLoader 不变） |
| fix | prd-api | 知识库上传文件/新建文档时补设 DocumentEntry.LastChangedAt=UtcNow，新条目立即带 NEW 徽标、24h 后自动消失（此前两端点漏设导致 NEW 永不显示） |
| feat | prd-admin | 知识库左侧文件树视觉升级：行 hover/选中改为不贴边的 9px 圆角整块高亮 + 内侧细 accent 条（替代又粗又方的贴边竖条），行距/图标文字间距更舒展，文件夹章节标题改大写小字 muted + 单条细分隔线，搜索框/底部统计轻量化；全部走主题 token，dark+light 双主题适配 |
| feat | prd-admin | 知识库搜索去掉"标题搜索/内容搜索"切换按钮，默认永远同时搜标题+内容；标题未命中仅正文命中的条目加「内容包含」轻量标记，placeholder 统一为"搜索标题或内容…" |
| fix | prd-api | 知识库搜索关键词正则转义(避免 [draft]/v1.0/foo( 误匹配或报错) + 访客停留时长改累加(去重窗口内重开不再覆盖前次时长) |
| fix | prd-api | 知识库访客统计改用 MongoDB $facet 聚合管道在服务端算总访问量/独立访客/总停留时长，不再把该 store 全量 view event 拉回应用层内存（大访问量下内存与延迟不可控），响应结构不变 |
| fix | prd-admin | 知识库 TOC slug 与正文 heading id 统一：抽出共享 headingTextToSlug（剥 markdown 标记 + 剥内嵌 HTML 标签 + HTML 实体解码 + 同一 GithubSlugger），rehypeRaw 渲染含 <kbd>/<span> 的标题点目录可精确跳转 |
| fix | prd-admin | 知识库正文 sanitize schema 移除对所有元素的内联 style 放行（仅保留 className/id 与 KaTeX math），堵住公开知识库经 rehypeRaw 用 position:fixed 钓鱼/background-image 数据外带的 CSS 注入面，代价为内嵌 style 间距失效 |
| fix | prd-api | 知识库替换文件为无可提取正文（图片/音频/扫描 PDF）时，把该条目下非全文划词评论批量置为 Orphaned，避免旧锚点评论变孤儿仍按 Active 高亮（全文评论保持 Active 不动） |
| fix | prd-api | 知识库访问去重窗口改用滚动 LastSeenAt（旧行回退 EnteredAt）而非原始 EnteredAt，长会话多次刷新不再因首次进入时间超窗误判为新访问导致 ViewCount 虚增 |
| fix | prd-admin | 知识库搜索修复竞态：在途搜索响应回来时仅当仍是最新关键词才采纳，否则丢弃；清空搜索框立即回到本地全量树，不再残留上一次扁平搜索结果 |
| fix | prd-admin | 修复 MarkdownViewer 重渲染复用有状态 slugger 致 heading id 漂移、TOC/锚点失配（每次渲染前 reset） |
| fix | prd-admin | 知识库替换当前选中文件后预览不刷新：DocBrowser 内容加载缓存键由 entryId 改为 entryId+updatedAt（内容版本），替换后 updatedAt 变化自动重载新正文，移除 undefined→id 的 setTimeout hack；不影响 useViewTracking 埋点（仍以 entryId 为键） |
| fix | prd-api | 知识库替换文件清理旧 Attachment/ParsedPrd DB 记录，避免每次替换都把上一版正文与附件记录变成永久孤儿（与 DeleteEntry 一致只删 DB 记录、不动共享 blob；CT.None + try/catch 尽力而为，清理失败不影响替换主流程） |
| fix | prd-admin | 划词选区 offset 基于剥离 frontmatter 的正文解析（修复标题等同时出现在 frontmatter 时锚点错位）+ 搜索陈旧响应/异常时 spinner 兜底解除 |
| fix | prd-api | 知识库全文评论：图片/音频/扫描PDF/被无文本文件替换过的条目（DocumentId 为空）此前被"该条目尚未关联正文"400 拦截无法评论；改为仅有锚点评论才强制要求正文，全文评论允许 DocumentId 为空（ContentHash 跳过算并存 null、DocumentId 存 string.Empty） |
| fix | prd-admin | 修复含转义尖括号标题（如 `# Use &lt;T&gt; generics`）rendered 侧 slug 被 HTML 标签剥离正则误删致与 TOC 不一致：headingTextToSlug 增加 alreadyRendered 参数，rendered 路径跳过剥标签/解实体，两侧共用同一 normalize+slugger（SSOT） |
| fix | prd-api | 知识库划词评论 rebind/orphan 过滤由 `!c.IsWholeDocument`（LINQ 译为 `{IsWholeDocument:false}`）改为 `Filter.Ne(IsWholeDocument,true)`，覆盖缺该新增字段的历史评论（false/null/缺字段三态），不再静默漏掉旧评论 |
| fix | prd-admin | 知识库 TOC 切换文档时 activeId 由 `prev ?? 首项` 惰性保留改为重置为新文档首个 heading id，消除切文档高亮闪烁/停在上一篇标题 |
| fix | prd-admin | 修复划词选区 offset 三级回退 step3 的 endOffset 用 strippedText.length（已剥 markdown 标记，偏短甚至越界）：改为优先末词在 raw 中的位置+末词长度，兜底原始可见文本长度，并 clamp 到 [startOffset, raw.length] |
