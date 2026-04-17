| feat | cds | P1 多项目外壳：新增 `/api/projects` 路由（4 个端点，向下延伸到 P4 创建/删除）+ `projects.html` 项目列表着陆页 + `GET /` 302 重定向到 `/projects.html`，Dashboard header 加"← 项目"返回链接 |
| test | cds | 新增 `tests/routes/projects.test.ts` 6 条单测覆盖 GET/POST/DELETE 路径 (298/298 绿) |
| docs | cds | 对齐 `design.cds-multi-project.md` + `plan.cds-multi-project-phases.md` 的 P1 交付清单，说明前端是纯 HTML 而非 React |
