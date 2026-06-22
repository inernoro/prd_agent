| fix | cds | 修复旧 deploy fenced cleanup 误删更新运行时容器导致预览回到 503 |
| fix | cds | 保留构建中分支的 forwarder 预览域名路由，避免部署状态回退时出现 unknown-host 503 |
| fix | cds | 源码部署容器自动注入 commit 与构建时间环境变量，保证 /api/version 可用于发布版本比对 |
