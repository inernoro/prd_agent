| feat | prd-api | PM 项目知识库复用文档库：DocumentStore 加 PmProjectId、PmProject 加 KnowledgeStoreId，新增 GET /pm/projects/{id}/knowledge/store（find-or-create + 旧 PmKnowledgeFile 最大努力迁移）；DocumentStore 读写权限按项目成员判定，项目库从个人/公开列表隐藏 |
| feat | prd-admin | PM 项目知识库 tab 改用复用组件 DocumentStoreBrowser（封装 DocBrowser+document-store service），获得文件夹目录/多格式上传/MD预览/标签全套；保留成员托管站点区块 |
| feat | prd-admin | 文件预览支持 HTML 真渲染：html 条目用 sandbox iframe 渲染原文件（fileUrl），替代剥标签后的纯文本，sandbox 防 XSS |
