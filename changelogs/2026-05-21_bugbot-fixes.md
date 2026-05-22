| fix | prd-api | 修复 Cursor Bugbot High/P1：MySharesController 知识库 `PrimaryPath` 从无效的 `/public/share/{token}` 改为有效的 `/library/share/{token}`（与 DocumentStorePage 创建 URL + ShortLinkRouter navigate 一致） |
| fix | prd-api | 修复 Bugbot P2：DocumentStoreController create-share 返回值恢复为完整 `DocumentStoreShareLink`（之前自定义匿名对象缺 viewCount/createdAt/isRevoked，前端 prepend 到 list 后字段缺失回归）；ShortLink 注册副作用保留 |
| fix | prd-admin | 修复 Bugbot High：ShareLinkTesterPage LEGACY_PATH 知识库路径 `/public/share/` → `/library/share/` |
| fix | prd-admin | 修复 Bugbot Medium：MySharesPage load 加 fetchIdRef 防过期响应守卫（filter/showRevoked 快速切换时丢弃旧回包，项目 learned rule） |
