| fix | prd-admin | 涌现画布：停止/涌现出错时不再丢弃已到达的持久化节点（落位而非清空缓冲） |
| fix | prd-admin | 涌现画布：渐显未完成前父节点保持锁定，阻止同父重复探索/涌现/整理交错导致乱序落位 |
| fix | prd-admin | 涌现画布：revealNext 与 flushPending 去重逻辑对齐，避免 SSE 重发导致重复节点/nodeCount 多计 |
| fix | prd-admin | 涌现画布：涌现 onDone/onError 清空 emergeAnchorRef，防止陈旧锚点把后续探索节点误导到无槽 key 而孤立 |
