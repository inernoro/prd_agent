| fix | prd-admin | 视频 Agent 切到 selectedRunId 后 mode fetch 失败（任务被删/网络错/字段缺失）不再无限「加载任务中…」死锁，统一退回作品架并 toast 提示；loading 面板也加了「返回作品架」逃生按钮 |
| fix | prd-admin | 高级创作页轮询：run 终态后用户继续点单镜「渲染」/「重新设计」时自动重启轮询；轮询是否运行同时考虑 run.status 与任意 scene 是否处于 Generating/Rendering 过渡态，scene 跑完才停 |
