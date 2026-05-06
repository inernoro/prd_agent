| feat | cds | 新增 ProjectKind 'shared-service'：长生命周期共享基础设施服务（如 claude-sdk sidecar）的部署目标
| feat | cds | types.ts 新增 RemoteHost / ServiceDeployment / ServiceDeploymentLogEntry 接口；Project 新增 serviceImage / servicePort / releaseTag / targetHostIds / serviceEnv 字段
| feat | cds | StateService 新增远程主机 CRUD + ServiceDeployment append-only 历史，SSH 凭据走 sealToken（AES-256-GCM）加密
| feat | cds | 新增 /api/cds-system/remote-hosts CRUD（系统级，符合 scope-naming.md §3）；resolveApiLabel 同步补 6 条中文 label
| feat | cds | 新增 SidecarDeployer 5 阶段部署引擎骨架（connecting / installing / verifying / registering / running），ssh2 npm 依赖
| feat | cds | CdsSettingsPage 新增「远程主机」tab（运行时分组），列表 + 录入表单 + 启用/禁用切换
| docs | cds | 详见 doc/plan.cds-shared-service-extension.md
