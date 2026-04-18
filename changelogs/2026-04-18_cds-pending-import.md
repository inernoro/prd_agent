| feat | cds | 新增 pending-import 流程：外部 Agent 可 POST /api/projects/:id/pending-import 提交 CDS 配置，由面板人工批准/拒绝（14 个新测试） |
| feat | cds | 部署 env 注入 CDS_PROJECT_SLUG / CDS_PROJECT_ID，compose YAML 可写 `"${CDS_PROJECT_SLUG}"` 实现多项目数据隔离 |
| chore | cds | "快速开始"按钮改名「初始化构建配置」并更新引导文案，反映新增 cds-compose.yaml 优先读取的行为 |
