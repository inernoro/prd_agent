| fix | cds | auto-build（预览子域触发的构建）改用 `getBuildProfilesForProject(entry.projectId)`，不再遍历别的项目的 profile 导致"缺少 command 字段"或跨项目 service 污染 |
| fix | cds | auto-build 创建的分支显式 `projectId: 'default'`，让清理/隔离路径一致对待 |
| feat | cds | pending-import 提交时校验每个 app profile 必须带 command，否则 400 `invalid_profile`，不再让半成品 YAML 混进状态 |
