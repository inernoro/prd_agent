| security | prd-api | 凭证加密改用 IDataProtector（独立密钥环），不再复用 Jwt:Secret，避免单点密钥泄露风险 |
| fix | prd-api | 外部授权 UpdateAsync 合并 partial patch 与已存储凭证，避免部分更新清空未填字段导致授权失效 |
| fix | prd-api | 外部授权类型元信息接口移除 AllowAnonymous，需登录后访问 |
| fix | prd-admin | 整改 CSV 解析 header 检测改用关键词特征匹配，兼容自定义列名 |
| chore | prd-admin | 删除未引用的 storyHtmlTemplate.ts / inspectionHtmlTemplate.ts 死代码文件 |
