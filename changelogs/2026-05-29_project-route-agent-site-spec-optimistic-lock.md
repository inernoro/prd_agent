| feat | prd-api | UpsertSiteSpec 增加乐观锁：客户端提交 expectedUpdatedAt，与 DB 当前 UpdatedAt 差 >100ms 返 409 STALE_UPDATE，避免多人协作时静默覆盖 |
| feat | prd-api | UpsertSiteSpec 增加后端 markdown 大小校验（2 MB 上限），防止恶意客户端绕过前端 1 MB 限制 |
| feat | prd-admin | 公共站点说明顶部新增「重新加载」按钮 + 服务端原文 ref 做 dirty 检测，有未保存草稿时弹 confirm 防止误覆盖 |
| feat | prd-admin | upsertSiteSpec service 新增 expectedUpdatedAt 字段；save 时遇 STALE_UPDATE 错误高亮提示本地草稿仍保留 |
