| fix | prd-admin | 演讲编辑器顶层 onError 与 onEvent.error 调度协同：顶层用 setTimeout 调度 load()，并发拒绝场景下 onEvent.error 同步取消，避免 banner 被秒抹（Bugbot Medium "Concurrency error banner cleared"） |
| fix | prd-admin | 演讲播放页切 deck 时重置 activeIndex / cameraTargetIndex / rawNodes / deck，避免从上一个 deck 的中段开始（Bugbot Medium "Play state persists across decks"） |
| fix | prd-api | 演讲重新发布顺序调整：先插入新分享链，再吊销旧链；新链创建失败时旧链未被吊销，避免死局（Bugbot Medium "Republish revokes before new link"） |
