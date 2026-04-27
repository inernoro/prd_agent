| fix | prd-admin | 修复 phantom 路由：launcherCatalog 写的 /prompts 在 App.tsx 实际不存在（点击 404）已删除；/models 实际是 /mds，已纠正 |
| fix | prd-admin | infra:my-assets 路由从查询字符串别名 `/visual-agent?tab=assets` 改为真实路由 `/my-assets` |
| feat | prd-admin | 新增 navCoverage.test.ts 自动化护栏：CI 扫描 App.tsx 所有 Route，每条必须在 launcherCatalog 注册 / 在 ALLOW_LIST 显式豁免 / 是参数化子路由；同时检测 phantom 路由（catalog 注册了但 App.tsx 没有），未通过测试直接 fail CI |
| docs | rules | 重写 .claude/rules/navigation-registry.md：明确 SSOT 模型 + 三类注册位置（agent/toolbox/utility-infra）+ 后端 menuCatalog 自动并入 + 自动化测试用法 |
