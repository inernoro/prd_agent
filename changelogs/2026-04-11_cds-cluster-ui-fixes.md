| feat | cds | 设置菜单新增「退出集群」快捷入口，hybrid/executor 角色直接一键退出，无需再进入集群弹窗 |
| fix | cds | 单节点 scheduler 模式电池徽章恢复为本地容器槽视图（不再卡在「集群 …」占位），仅在实际有远端执行器时切换为集群视图 |
| fix | cds | 首次加载分支列表不再闪现「暂无分支」过渡文案，初始保留 CDS 加载动画直到数据就绪，空状态升级为带插图+CTA 的设计态 |
| fix | cds | DELETE/停止分支现在会识别 entry.executorId 并代理到远端执行器 /exec/delete /exec/stop，不再只清掉主节点状态而留下僵尸容器 |
| feat | cds | scheduler 启停改为 UI 开关：新增 PUT /api/scheduler/enabled + SchedulerService.setEnabled + state.json 持久化，容量弹窗内 on/off 切换，状态通过 state-stream 广播 |
| feat | cds | 执行器状态页加入详细的「为什么没有 Dashboard」解释（避免 split-brain / 运维成本 / 控制平面单一），并指引使用主节点的退出集群按钮 |
| chore | cds | 单节点模式隐藏多余的「执行器集群 1/1 在线」面板，header 电池徽章已充分展示容量 |
