| feat | cds | [项目设置 → 项目配置] 新增虚拟 cds-compose.yml SSOT:Project.composeYaml 持久化(approve PendingImport 即固化,不再丢弃原始 yaml)+ 下载/复制/编辑回写 + 配置变更广播 project.config.changed 事件 |
| feat | cds | 配置字段三级权威模型(config-authority.ts):repo(workDir/command/image,可改应回写)/ platform(端口/网络/域名,只读)/ user(env,可覆盖)。PUT /compose 强制权威校验,platform 字段被非平台调用方改动一律 403 + 违规清单 |
| feat | cds | 新增 GET /api/projects/:id/compose.yml(下载) + GET /compose(JSON 含三级权威标注) + PUT /compose(回写带权威校验)。老项目无 composeYaml 时从已落库 profile/infra 反向生成只读起点 |
