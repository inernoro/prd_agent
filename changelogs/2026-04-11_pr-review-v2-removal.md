| refactor | prd-api | 下线旧 PR审查棱镜：删除 PrReviewPrismController (1211 行)、GitHubPrReviewPrismService (501 行)、PrReviewPrismSnapshotBuilder、PrReviewPrismSubmission 模型 |
| refactor | prd-api | 下线旧 PR审查棱镜：删除集成测试 (1087 行) + 单元测试 (145 行)，由 PrUrlParserTests 覆盖新 V2 路径 |
| refactor | prd-api | 下线旧 PR审查棱镜：从 MongoDbContext 移除 PrReviewPrismSubmissions 集合与索引；AppSettings 删除 PrReviewPrismGitHubTokenEncrypted 字段 |
| refactor | prd-api | 下线旧 PR审查棱镜：AdminPermissionCatalog / BuiltInSystemRoles / AdminMenuCatalog 移除 pr-review-prism.use，替换为 pr-review.use |
| refactor | prd-admin | 下线旧 PR审查棱镜：删除 pages/pr-review-prism (1781 行) + services/real/prReviewPrism.ts + PrReviewPrismCardArt，由 /pr-review V2 页面替代 |
| refactor | prd-admin | 下线旧 PR审查棱镜：从 App.tsx / authzMenuMapping / AgentLauncherPage / MobileHomePage / toolboxStore 移除所有 pr-review-prism 引用 |
| refactor | ci | 删除 .github/pr-architect/* 整个目录（README / manifests / review-rules / design-sources / decision-card-template）与 5 个 workflow、5 个 Python 脚本、PULL_REQUEST_TEMPLATE.md |
| refactor | skills | 删除 .claude/skills/pr-prism-bootstrap 与 scripts/bootstrap-pr-prism.sh / init-pr-prism-basis.sh |
| refactor | doc | 下线 doc/guide.pr-prism-bootstrap-package.md / guide.pr-prism-onboarding.md；spec.srs.md 第 4.24 节从 PR 审查棱镜改写为 PR 审查工作台 V2；rule.data-dictionary.md / rule.app-identity.md 同步更新 |
| chore | doc | 清理未发布的 V1 历史 changelog 碎片：2026-04-08_map-home-pr-review-prism.md、2026-04-09_pr-review-prism-complete.md（V1 从未发版，清理避免 CHANGELOG 出现从未面世的功能） |
