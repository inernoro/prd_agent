| fix | prd-api | monorepo 的 packages/*/docs 恢复默认预勾——packages 是源码工作区不是依赖树 |
| fix | prd-admin | 重试同步的乐观「同步中」在服务端给出新状态后撤掉，不再卡住按钮 |
| fix | prd-admin | 同步中的目录父条目单独按 id 轮询，子文档超过一页也不会把它挤掉导致轮询提前停 |
