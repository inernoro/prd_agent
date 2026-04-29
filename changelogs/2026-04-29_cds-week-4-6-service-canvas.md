| feat | cds | BranchListPage 改造为 Railway 风格 service-canvas：左侧 320px 资源列表（跟踪分支 + 远程分支两组），右侧主工作区显示选中分支的状态、服务、操作和日志；首次进入自动选中"最近运行"分支 |
| feat | cds | 新增 OpsDrawer 组件：右侧滑入抽屉承载容量、主机健康、执行器、批量运维、活动流等低频运维操作；TopBar 增加「运维」按钮触发；Esc / 点遮罩关闭 |
| refactor | cds | 删除 BranchListPage 中央"分支卡瀑布"布局；分支列表改为单行可点击的紧凑行（状态点 + 名称 + 状态文 + 服务 + 时间）；批量复选框右移、密度切换不再需要（master view 默认舒适） |
| refactor | cds | 远程分支列表从右侧运维栏挪到左侧资源列表，紧贴跟踪分支下方，保持一键部署链路最短 |
