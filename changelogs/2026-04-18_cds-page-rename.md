| refactor | cds | 三页面语义化重命名：projects.html→/project-list, index.html 列表视图→/branch-list, 拓扑视图→/branch-panel；旧路径 301 永久重定向，书签不失效 |
| refactor | cds | setViewMode 切换视图时同步 URL（pushState）+ 页面 title，分支列表/分支面板有独立可书签地址 |
| refactor | cds | 所有内部导航链接（app.js / projects.js / settings.js / settings.html / index.html）统一换为语义路径 |
| refactor | cds | 登录后跳转默认目标从 /projects.html 改为 /project-list（middleware + auth routes） |
