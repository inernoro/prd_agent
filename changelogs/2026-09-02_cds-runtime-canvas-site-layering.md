| feat | cds | 运行画布改为「入口 → 站点 → 壳 → 前缀成员」分层：按 host 分组，静态站是壳，API 按前缀挂在壳下，无路由服务挂在引用它的服务下 |
| feat | cds | 服务角色（web / api / worker）改由服务端判定：cds.role 声明优先，其次路由事实、服务名、默认；画布徽标标出推断并悬停给出依据 |
| feat | cds | 同一 host 上被多个服务声明的路由前缀在画布标「冲突」并给修法 |
| refactor | cds | forwarder 的按名约定（默认站 / `/api/` 接管）抽成 route-conventions 唯一模块，发布器与服务图共用 |
