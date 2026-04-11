| perf | cds | restart 重排为 "先 build 再 stop"：tsc 在旧进程还在服务时就写出 dist，停掉旧进程到新进程绑端口的空窗从 10-16s 收缩到 2-4s，消除 Cloudflare 502 Bad gateway 体感 |
| perf | cds | tsconfig 开启 incremental + tsBuildInfoFile，warm 构建从 5s 降到 3s（小 VM 收益更明显） |
| feat | cds | 前端新增重启检测遮罩：SSE 中断时展示"CDS 正在重启"卡片，轮询 /healthz，后端恢复后自动刷新页面，替代原本的 Cloudflare 502 硬错 |
