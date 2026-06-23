| fix | cds | 修复分支部署失败时卡片永远转圈不更新：部署 catch 分支补发 branch.status SSE 事件，前端无需刷新即可看到失败态 |
| feat | cds | 项目页新增"清理停止分支"一键清理（清理孤儿右侧）+ POST /api/branches/cleanup-stopped |
| fix | cds | 修复 Webhook 日志按分支过滤双重前缀 bug 导致"永远只命中一条"：比对前 ref 归一化去 refs/heads/ 前缀 |
| perf | cds | Janitor 周期安全清理 Docker 悬空镜像 + 构建缓存（不碰容器/卷/有 tag 镜像），根治几百次构建后构建越来越慢 |
| docs | cds | 新增 debt.cds-performance 性能债务台账：构建变慢根因(Docker 垃圾堆积) + mongo 索引非主因结论 + 逐步解决路线 |
