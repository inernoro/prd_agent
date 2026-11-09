| fix | design-runtime | 取证浏览器复用仅服务自身公开文件的本地服务作为出站代理，保留 Worker 功能并拒绝其他来源与网络连接 |
| perf | design-runtime | 空属性查询不再逐标签创建临时 Map，复用单次派生内的空属性映射并同步 CDS 镜像，保留原内存限额 |
| test | design-runtime | 保留原 Worker 零出站断言及期限，补齐启动脚本与代理来源验证，失败时记录有界请求路径辅助定位 |
