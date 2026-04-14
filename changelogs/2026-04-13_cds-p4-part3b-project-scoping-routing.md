| feat | cds | P4 Part 3b 后端 project scoping：`GET /api/branches` / `/api/routing-rules` / `/api/build-profiles` / `/api/infra` 新增 `?project=<id>` 查询过滤；`POST /api/branches` 接受 `projectId` 入参并校验项目存在 |
| feat | cds | P4 Part 3b 前端 project scoping：`app.js` 新增顶部常量 `CURRENT_PROJECT_ID`（从 URL `?project=` 读），`api()` helper 自动给 scoped GET 请求注入 `?project=<id>` 过滤；创建分支时在 body 里带上 projectId；Dashboard header 链接自动显示当前项目名 |
| test | cds | 新增 3 条 branches 路由过滤测试（?project= 过滤、POST unknown projectId 400、POST 正常 stamp），全量测试 375 → **378 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 整体完成：Part 1/2/3a/3b 全部勾选，新增"P4 完成意义"章节总结端到端多项目能力 |
