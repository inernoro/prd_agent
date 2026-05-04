| fix | cds | 修复 [项目环境变量] CDS_PROJECT_ID/CDS_PROJECT_SLUG 可被 _global / project customEnv 覆盖(Bugbot Medium):新增 RESERVED_CDS_KEYS 集合,buildBranchEnvMap 在 merge 末尾强制还原系统派生值 |
| fix | cds | 修复 [CDS 系统设置] /api/self-force-sync 跳过 in-process web build 导致"已 force-sync 但前端没变"(Bugbot Medium):抽取 runInProcessWebBuild helper,self-update 与 force-sync 共用,保证 web/dist 一致刷新 |
