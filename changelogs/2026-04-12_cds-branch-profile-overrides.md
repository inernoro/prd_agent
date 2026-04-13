| feat | cds | 分支级 BuildProfile 覆盖（继承 + 扩展）：每分支可独立定制 dockerImage/command/env/resources/activeDeployMode 等，未设置的字段继承公共基线 |
| feat | cds | 新增 `BuildProfileOverride` 类型 + `BranchEntry.profileOverrides` 字段 |
| feat | cds | 新增 `applyProfileOverride()` 与 `resolveEffectiveProfile()`，合并顺序：baseline → branch override → deploy mode |
| feat | cds | 新增 REST 端点：GET/PUT/DELETE `/api/branches/:id/profile-overrides[/:profileId]` |
| feat | cds | Dashboard 部署菜单新增「容器配置 (继承/覆盖)」入口 + 模态框（公共默认展示 / 字段级继承徽章 / 环境变量合并预览） |
| feat | cds | 部署日志里增加 `(分支自定义)` 标签与 `branchOverrideKeys` 详情，便于追溯 |
| test | cds | 新增 11 个单元测试覆盖合并逻辑（env 键级合并 / 优先级顺序 / 空覆盖 / deploy mode 切换） |
