| feat | cds | 分支从分支派生(快照拷贝):POST /branches 支持 sourceBranchId 深拷贝来源分支的 profileOverrides+extraProfiles 并写派生溯源指针;cdscli branch create 新增 --from |
| feat | cds | PR opened/reopened 自动回填派生指针(base 分支,只回填不拷贝配置);新增 POST /branches/:id/copy-config-from/:sourceId 显式一键拉取(拷贝前自动拍快照,可回滚,支持 ?redeploy=1) |
| feat | cds | ConfigSnapshot 快照覆盖分支层(profileOverrides/extraProfiles/派生指针):回滚仅恢复仍存在的分支、不复活已删分支、旧快照零迁移 no-op |
| feat | cds | 生效配置检查器新增派生溯源行(派生自哪个分支/何时/来源是否还在)+ 「重新拉取来源配置」按钮 |
| docs | cds | 新增 design.cds.config-tree.md:四层配置树模型 + 派生三层策略 + 溯源契约 + 波4(repo compose 纯结构种子/漂移巡检)波5(无 Agent 接入)方向;同步 index.yml 与 guide.list |
