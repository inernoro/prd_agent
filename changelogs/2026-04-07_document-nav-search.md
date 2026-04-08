| feat | prd-admin | 文档浏览器支持多文档置顶（pin），右键上下文菜单替代直接设为主文档 |
| feat | prd-admin | 文件树标题显示切换：默认使用正文第一行，可切换为文件名 |
| feat | prd-admin | 搜索支持文档内容搜索（可选开关），后端存储 ContentIndex 到 MongoDB |
| fix | prd-admin | 修复知识库详情页刷新后丢失状态的 bug（sessionStorage 持久化 storeId） |
| feat | prd-admin | 知识库卡片显示最近文档预览列表，增大卡片高度 |
| feat | prd-api | DocumentStore 新增 PinnedEntryIds 字段，支持多文档置顶 |
| feat | prd-api | DocumentEntry 新增 ContentIndex 字段，上传和同步时自动截取前 2000 字存入 |
| feat | prd-api | 新增 PUT /stores/{storeId}/pinned-entries 置顶/取消置顶端点 |
| feat | prd-api | 新增 GET /stores/with-preview 端点，返回空间列表含最近文档预览 |
| feat | prd-api | ListEntries 端点新增 searchContent 参数，支持内容搜索 |
| fix | prd-admin | 文档列表左侧留白过大，非文件夹项移除空白占位符 |
| feat | prd-admin | 支持拖拽文件到文件夹（HTML5 drag & drop） |
| feat | prd-admin | 右键菜单新增删除选项（文件/文件夹） |
| feat | prd-admin | 文档在线编辑：预览面板新增编辑模式（Markdown textarea + 保存） |
| feat | prd-admin | 加号按钮改为下拉菜单：文档/上传文件/新建文件夹（已实现）+ 模板/AI写作/链接（置灰待实现） |
| feat | prd-admin | 每个文件夹允许独立设置主文档（存储在 folder.metadata.primaryChildId） |
| feat | prd-admin | 本地搜索同时匹配 title/summary/正文第一行，开启内容搜索时自动触发回填 |
| feat | prd-api | 新增 PUT /entries/{entryId}/move 移动文档条目端点 |
| feat | prd-api | 新增 PUT /entries/{entryId}/content 文档内容在线编辑端点 |
| feat | prd-api | 新增 PUT /entries/{folderId}/primary-child 设置文件夹主文档端点 |
| feat | prd-api | 新增 POST /stores/{storeId}/rebuild-content-index 回填内容索引端点 |
| fix | prd-admin | 修复拖拽文件树条目时误触发右侧上传遮罩（仅响应外部 Files 拖入） |
| feat | prd-admin | 文档浏览器左侧导航支持鼠标拖拽调整宽度（200~560px，sessionStorage 持久化） |
| feat | prd-admin | 文档浏览器左侧导航应用液态玻璃效果（backdrop-filter blur + saturate） |
| feat | prd-admin | 新建 src/lib/fileTypeRegistry.ts 文件类型注册表（PPT/Word/Excel/Code/Image 等 15 种类型） |
| fix | prd-admin | DocBrowser 文件图标从硬编码 switch 改为 FILE_TYPE_REGISTRY 查询，修复 PPTX 显示为文本图标的 bug |
| fix | prd-api | 上传端点 MIME 推断增加 .ppt/.pptx/.xls/.xlsx 支持 |
| fix | prd-api | 上传文档标题保留扩展名（便于前端按扩展名识别文件类型） |
| rule | .claude | frontend-architecture.md 新增「注册表模式」强制规则，禁止组件内硬编码 switch 类型判断 |
| fix | prd-admin | DocBrowser/DocumentStorePage 所有 Loader2 替换为统一的 MapSpinner/MapSectionLoader |
| rule | .claude | frontend-architecture.md 新增「统一加载组件」强制规则，禁止直接使用 lucide-react Loader2 |
| feat | prd-admin | 文档预览支持图片/视频/音频/PDF 直接渲染（按 fileTypeRegistry.preview 字段路由） |
| feat | prd-admin | 二进制文件兜底显示文件图标 + 下载按钮，不再"无文本内容"裸露提示 |
| feat | prd-admin | 编辑按钮仅对可编辑文本类型（md/txt/code/json/yaml/csv 等）显示 |
