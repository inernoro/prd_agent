| feat | cds | 新增预览就绪探测（TCP + HTTP）与分支 `restarting` 状态；容器存活但未监听端口时不再暴露 502，而是持续展示友好等待页直到真正就绪 |
| feat | cds | proxy 层扩大等待页覆盖：building / starting / restarting / 无可用 upstream / ECONNREFUSED 均返回 503 + Retry-After 的友好等待 HTML，前端 2s 自动刷新 |
| feat | cds | nginx 增加 `error_page 502 504 @cds_waiting` 兜底：CDS master 不可达（自升级、崩溃）时回落到 `www/cds-waiting.html` 静态等待页，彻底消除 Cloudflare 502 |
| feat | cds | 已删除分支访问友好页：预览子域名命中本地 + 远端都找不到的分支时，短路显示"预览已下线"404 HTML 页，含活跃分支列表和 15 秒自动返回控制台 |
| feat | cds | `ContainerService.restartServiceInPlace` 支持热重启（docker restart 保留容器），为后续 pull + restart 热加载链路预留入口 |
| fix | cds | 部署流水线在容器存活后进入 `starting`，通过 readiness 探测再转 `running`；探测超时标记 `error` 而非假装成功 |
| style | cds | Dashboard 分支卡片统一配色：非活跃卡片（idle/stopped/error）的端口徽章与技术栈图标转黑白；摒弃蓝色 — 技术栈 SVG 改用 currentColor 继承徽章状态色，port-building 与 status-dot-building 从蓝色改为主题琥珀色；GitHub 标志保留专属视觉 |
