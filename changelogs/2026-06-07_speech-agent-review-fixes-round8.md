| fix | prd-api | 演讲重新生成：旧节点改为"解析成功后才删 + 插",LLM/解析失败时上一轮 mindmap 不再永久丢失（Bugbot Medium + Codex P2 "Defer deleting old nodes until regeneration succeeds" / "Failed regen shows ghost nodes"） |
| fix | prd-admin | 演讲编辑器挂上 useSseStream 顶层 onError：HTTP 4xx/5xx/fetch 失败不再静默无提示（Bugbot Medium "Editor omits SSE hook onError"） |
| fix | prd-admin | 演讲编辑器切 deck 时重置 autoStarted 旗：新 deck 的 ?autoStart=1 不再被旧 mount 的 ref 卡住（Bugbot Low "autoStart skipped on deck switch"） |
| fix | prd-admin | 演讲创建页 KB 文档选择 pickKbEntry 加 fetchIdRef stale guard：快速切文档时慢响应不再覆盖后选的（Bugbot Medium "KB pick lacks stale guard"） |
