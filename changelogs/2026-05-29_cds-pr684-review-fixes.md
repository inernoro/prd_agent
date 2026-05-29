| fix | cds | [项目设置] 虚拟 compose 首次保存修复:legacy 项目无持久化 composeYaml 时,PUT diff 基线改用 synthesizeComposeFromState(与 GET 一致),避免未改动的平台字段(ports)被误判为新增而拒绝保存(Codex review P2) |
| fix | cds | infra resync 现在能检测 restartPolicy 变化:compose-parser 从 yaml 的 restart: 字段解析 restartPolicy,diffSignatures 不再硬编码覆盖,与文件头声称的重建触发条件一致(Cursor Bugbot) |
| refactor | cds | infra cmd 白名单(minio/elasticsearch 必须显式 command)抽到 config/infra-cmd-whitelist.ts 做 SSOT,pending-import 与 project-infra-resync 共用,消除两处重复(Cursor Bugbot) |
