| fix | cds | 搜索分支 / 选择远程分支不再自动开新窗口跳到 "CDS is preparing the preview..." 占位页；改为静默后台部署 + toast 提示「已添加 X，正在后台部署」；用户在分支卡看 BUILDING 状态并自行决定何时点预览 |
| fix | cds | 去掉 BranchDetailDrawer / OpsDrawer / CommandPalette 蒙版的 backdrop-blur，避免点详情后整个页面变模糊（用户反馈很难受）；蒙版改用 `bg-black/40` ~ `bg-black/50` 纯遮挡 |
| feat | cds | 分支页顶部新增「项目环境变量待补全」横幅：检测项目环境变量含 TODO / 请填写 / placeholder / FILL_ME / change_me 等占位时主动提示；横幅显示前 5 个 key + 总数；右侧主按钮「前往填写」一键跳转 `/settings/<projectId>#env` |
