| feat | cds | 运行画布改为「入口 → 站点 → 壳 → 前缀成员」分层：按 host 分组，静态站是壳，API 按前缀挂在壳下，无路由服务挂在引用它的服务下 |
| feat | cds | 服务角色（web / api / worker）改由服务端判定：cds.role 声明优先，其次路由事实、服务名、默认；画布徽标标出推断并悬停给出依据 |
| feat | cds | 同一 host 上被多个服务声明的路由前缀在画布标「冲突」并给修法 |
| refactor | cds | forwarder 的按名约定（默认站 / `/api/` 接管）抽成 route-conventions 唯一模块，发布器与服务图共用 |
| docs | cds | 新增「CDS 服务关系与跨项目引用」计划文档（活看板 + 四批次验收标准 + 设计稿链接） |
| feat | cds | 新增拓扑体检（前缀冲突 / 探活前缀 / 子域抢根路径 / 双公网面 / 游离服务 / 角色靠名字），规则只在后端一份；导入审批错误级阻断，可显式放行 |
| feat | cds | 新增 POST /api/compose/lint 与 GET /api/branches/:id/service-graph；compose 支持 cds.calls 显式声明调用关系 |
| feat | cdscli | verify 自动调用服务端拓扑体检并合并进门禁；新增 topology 子命令打印关系树；扫描生成器按模块扫控制器前缀，不再复制同一份清单，探活路径不进前缀，删除从未解析的 cds.path-prefixes 标签 |
