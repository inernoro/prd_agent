| fix | prd-api | 演讲重新生成节点替换改为两阶段 + InsertMany 单批：先 InsertMany 新节点（失败按新 Id 精确回滚），再 DeleteMany 快照旧 Id（按旧 Id 精确删，避免误伤并发），杜绝半棵树（Bugbot High "Node replace not atomic"） |
| fix | prd-api | 演讲 claim 不再归零 NodeCount：旧节点解析成功才删，失败时列表卡片继续显示旧 mindmap 的真实节点数（Bugbot Medium "NodeCount zeroed on failed regen"） |
| fix | prd-api | 演讲重新发布吊销旧分享链：先扫该 deck 名下所有 speech-agent 站点，把对应未 revoke 的 ShareLink 批量置 IsRevoked=true（Codex P2 "Revoke the previous speech share on republish"） |
| fix | prd-admin | 演讲 handleStart 同步清本地 errorMessage：避免上一轮失败的红条与「生成中」并排显示（Bugbot Medium "Stale error banner during regen"） |
