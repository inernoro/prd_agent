| fix | cds | 验收报告 JSON 粘贴绕过全局 100kb 解析器，大报告(数 MB)可正常保存 |
| fix | cds | 本地账号 githubId 用唯一负数占位，避免多本地用户在 githubId 唯一索引撞键 |
| fix | cds | basic 模式登录放行 /api/auth/login 等路由，保住单用户部署登录回退 |
| fix | cds | 部署耗时仅在真正就绪(runtimeStartedAt)时采样，避免污染中位 ETA |
| fix | cds | mongo 用户操作痕迹按容量裁剪，避免无界增长 |
| security | cds | 验收报告路由对项目级 key 调用 assertProjectAccess，禁止跨项目列/读/改/删 |
| fix | cds | mongo 活动裁剪用 $lt 严格小于，避免同毫秒新记录被连带删除 |
| fix | cds | pending 发布版重建时 ETA 取目标模式样本桶，等待页/卡片不再误用热加载估算 |
| fix | cds | 预览等待 ETA 仅扫描本分支所属项目的 profile，避免他项目发布版 profile 串改估算 |
| security | cds | 验收报告项目级 key 全面收敛：禁访全局/他项目报告、建报告强制归本项目、关联分支限本项目 |
| security | cds | 被禁用账号不能再通过 GitHub OAuth 登录（handleCallback 校验 status） |
| fix | cds | 管理员改用户先重置密码再改状态，避免密码重置失败但状态已落库 |
| security | cds | 易失(memory)存储后端禁用首启 bootstrap，防重启后被自封 system owner |
| fix | cds | 本地账号创建捕获唯一索引冲突(E11000)，并补登 username 唯一稀疏索引文档 |
| feat | cds | github 模式网关同等放行 cdsp_/cdsg_/静态 AI key（与人类会话并存），项目报告作用域生效 |
| fix | cds | 本地登录处理器加 try/catch 兜底，存储后端异常返回 500 而非挂起 |
| fix | cds | 预览等待页 ETA 在途重建时以 lastDeployStartedAt 为锚点，不再回退到上一轮历史日志误算几小时 |
| fix | prd-admin | 知识库「接入 AI」弹窗在 allowedScopes 异步到达后重新播种预选 scope，一键签发不再因预选落空失败 |
| fix | cds | 执行器构建路径在成功 complete 时戳 runtimeStartedAt 并采样部署耗时，执行器构建的项目也能积累 ETA 历史 |
| fix | cds | 单服务/首次 clone 部署起点也钉 lastDeployStartedAt，且 ETA 解析在 stamped 不旧于最新日志时优先它，单服务重部署不再误算几小时 |
