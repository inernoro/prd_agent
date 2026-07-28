| feat | prd-api | 海鲜市场新增角色技能套装：一条 curl 装齐一个角色的全部技能，匿名可下载，zip 内含 INSTALL.md 与 manifest |
| feat | prd-api | 新增匿名端点 GET /api/official-skills/bundles，返回角色标签与套装清单（含安装命令） |
| feat | prd-admin | 海鲜市场新增「我是」角色筛选行，按角色筛出套装与技能 |
| feat | 技能 | 新增 sdd-init 技能：探测项目现状，生成 CLAUDE.md 八条规则骨架 + doc 七类文档骨架 + 角色路线图与自检报告 |
| feat | 技能 | 补齐四个零仓库绑定但一直没上架的技能：plan-first、product-document-generator、doc-writer、flow-trace |
| refactor | prd-api | 技能依赖表从 Controller 硬编码搬到目录声明层，与套装共用递归展开逻辑 |
| fix | 技能 | 修正 tag 启发式误判：conflict-resolution 曾被标为「周报」、risk-matrix 标为「部署」 |
| fix | 技能 | acceptance-checklist 两个 reference 文件 de-emoji，对外分发内容不再夹带 emoji |
| test | prd-api | OfficialSkillCatalogTests 新增 7 项套装用例（注册、key 不撞、成员齐全、打包产物、fork、排序、角色） |
| test | 脚本 | 新增 scripts/test-official-skill-bundles.mjs 端到端自测：真解压校验分发产物，含三个负向用例 |
| docs | 文档 | 新增 design.skill.role-bundle 与 debt.skill.role-bundle，同步 index.yml 与目录索引 |
