| perf | cds | mongo-split 写入合并：高频 save() 不再每次同步 structuredClone 整个 state，改为每事件循环 tick 至多一次快照+落盘，根治 master 事件循环被部署日志/调和器 save 风暴堵死（网页 524 超时、就绪探测超时误判、容器被当部署失败清理） |
