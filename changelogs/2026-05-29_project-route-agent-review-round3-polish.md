| fix | prd-api | SSE WriteEvent + 心跳协程的 catch 列表新增 IOException，客户端断开时不再被外层 catch 当成业务异常上报，日志干净 |
| fix | prd-api | AnalyzePlanStream 的 writeLock SemaphoreSlim 用 using 释放，规范资源生命周期 |
| feat | prd-admin | 公共站点说明 AdminView 顶部新增「最近由 X 于 时间 更新」修改痕迹 + 多人协作提示文案，对应权限放开后的可追溯性要求 |
