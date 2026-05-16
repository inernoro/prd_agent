| fix | prd-admin | 知识库文档正文支持内嵌 HTML 渲染（rehype-raw + sanitize 防 XSS） |
| fix | prd-api | 修复划词评论/访客记录因 User.Id 序列化报错导致"添加失败"与登录用户显示匿名 |
| feat | prd-admin | 知识库文档新增"替换文件"功能，原地替换内容保留标签/主文档/置顶/位置 |
| feat | prd-api | 新增 POST /api/document-store/entries/{id}/replace 原地替换条目文件端点 |
