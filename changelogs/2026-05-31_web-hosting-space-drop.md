| fix | prd-admin | 修复网页托管在团队空间内拖拽上传的网页错误落到个人空间的问题（dropzone 上传后跟随当前空间投送，与弹窗上传路径保持一致） |
| perf | prd-admin | 网页托管列表预览改用 IntersectionObserver 懒挂 iframe，仅视口内卡片加载整页，离屏卸载，缓解大网页拖慢网速 |
| fix | prd-api | 修复网页托管评论作者/分享访问者用户名恒显示「用户」：GetDisplayName 读错 claim 名（应为 displayName），改为正确读取 + DB 兜底 |
| fix | prd-api | 网页托管分享标题去掉「{用户} 分享给你的」前缀（新链接不再写入；旧链接展示侧剥离，免数据迁移） |
| fix | prd-api | 修复网页托管访问统计取到 Docker 内网 IP（172.20.* / ::ffff:）：新增 GetRealClientIp 读 X-Forwarded-For/X-Real-IP 并规整 IPv4-mapped 地址 |
| fix | prd-admin | 网页托管分享页头部去掉「{用户} 分享给你的」前缀，直接显示站点标题 |
| fix | prd-admin | 网页托管 dropzone 拖拽上传：归属团队失败时不再静默报成功，弹错误提示告知仍在个人空间；并补齐团队空间编辑权限闸门，只读 viewer 不能通过拖拽绕过上传按钮投放到团队 |
