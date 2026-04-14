| feat | cds | P4 Part 2 真项目创建：`POST /api/projects` 接受 name/slug/gitRepoUrl/description，调 `docker network create cds-proj-<id>` 并持久化（带 rollback）；`DELETE /api/projects/:id` 幂等删除 docker 网络 + 项目条目，legacy 项目 403 保护 |
| feat | cds | `Project` 类型新增 `dockerNetwork?` 字段，`createProjectsRouter` 新增 shell + config 依赖注入 |
| feat | cds | 前端 `projects.html` 新增创建项目对话框（name/slug/gitRepoUrl/description 四字段 + 内联错误 + ESC 关闭），项目卡片 hover 出现删除按钮（legacy 项目除外），删除前弹 confirm 确认 |
| test | cds | 新增 9 条 POST/DELETE 单测（成功路径、4 档 400 校验、409 duplicate、500 docker 失败 + rollback、幂等网络创建、legacy 403、未知 id 404），全量测试 353 → **362 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 Part 2 交付清单勾选 |
