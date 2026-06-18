| fix | prd-api | 后台任务"定向消费"：知识库 Agent（字幕/视频转文字、文档再加工）与短视频解析的 run 增加 OwnerInstanceId（=git 分支），Worker 只领取属于本实例（或历史无主）的 queued 任务、启动兜底也只回收本实例的 running 任务。根治共享 Mongo 下多分支/主干容器互抢任务、A 分支的任务被跑旧代码的 B 容器消费的问题（见 cross-project-isolation 规则） |
| fix | prd-admin | 短视频卡片右栏无可见互动指标时不再为其预留 60px padding |
| fix | prd-api | 定向消费边界修复：启动兜底回收一并回收历史无主（OwnerInstanceId 空）的 running 任务，避免上线前旧代码遗留的在途任务永卡 running；再加工续聊重新排队、字幕去重复用时把 run 归属改/限定为当前实例，避免复用别的分支/主干拥有的 queued run 后本实例不处理导致永卡（Codex P2） |
