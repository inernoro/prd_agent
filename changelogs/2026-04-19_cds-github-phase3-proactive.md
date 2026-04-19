| feat | cds | PR 评论 slash 命令:`/cds redeploy` 强制重部署、`/cds stop` 停预览容器、`/cds logs` 回复最近 40 条部署日志、`/cds help` 显示帮助,所有命令 bot 自动回复确认 |
| feat | cds | GitHub 删分支(delete 事件) → CDS 自动 POST /branches/:id/stop 清理对应预览容器,防止孤儿 |
| feat | cds | GitHub repo 被重命名/转移/删除(repository 事件) → 自动解绑 Project 的 github 链接,避免 webhook 打到错的项目 |
| feat | cds | release 事件 acknowledged(占位实现,为未来 release tag → 生产部署预留钩子) |
| feat | cds | dispatcher +19 测试用例(slash 命令 8 条、delete 3 条、repository 3 条、release 1 条)覆盖 |
