| fix | prd-api | 快捷指令下载接口优先使用 macOS `shortcuts sign --mode anyone` 返回签名 `.shortcut`，签名不可用时不再伪装成一键安装 |
| fix | prd-admin | 快捷指令安装页改为签名下载优先、iCloud 模板其次、手动配置兜底，扫码安装路径更明确 |
| fix | prd-api | 内置 PrdAgent 收藏 iCloud 模板链接，并让快捷指令模板列表兼容前端读取的 `items` 字段 |
| feat | prd-api | 快捷指令授权默认 1 年有效，过期后拒绝 collect/install/download；管理端可按当前用户隔离延长到 3 年后 |
| feat | prd-admin | 快捷指令页新增实时收件箱，轮询展示当前登录用户通过快捷指令发来的最新收藏记录 |
| fix | prd-api | 启动时为历史快捷指令回填 `CreatedAt + 1 年` 的过期时间，避免旧授权永久有效 |
