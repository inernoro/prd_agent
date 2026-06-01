| fix | prd-api | GitHubDirectorySyncService SHA 缓存复用必须校验 Document.RawContent 非空，避免"空壳 Document"通过缓存路径传染到所有 SHA 相同的同步条目（用户表现：同步时间更新但右侧"暂无可预览的内容"） |
| feat | prd-api | 同步路径自愈：SHA 相同但 Document 为空的存量条目，下次同步时强制重新拉取一次 |
