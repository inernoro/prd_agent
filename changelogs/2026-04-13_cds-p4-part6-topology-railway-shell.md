| feat | cds | P4 Part 6 全屏拓扑 Railway-fidelity 改造：新增 44px 左侧 icon sub-nav（拓扑/指标/日志/设置）、顶部 breadcrumb pill（项目名 + production env + 分支下拉）、浮动 + Add 按钮 + 6 项菜单（GitHub Repo / Database / Docker / Routing / Volume / Empty Service）、右侧 460px 服务详情滑入面板含 4 个标签页（Deployments / Variables / Metrics / Settings） |
| feat | cds | 节点单击行为重做：app/infra 节点单击都打开右侧滑入详情面板（Deployments tab 显示 ACTIVE pill + image + 状态，Settings tab 显示 service info + "在编辑器中打开"按钮跳转到 override modal），shift+click 仍是边高亮 |
| feat | cds | 进入拓扑模式时自动从 branches 列表挑 main/master 作为默认分支 stamp 到下拉框，单击节点立即可编辑（不再要求用户先手动选分支） |
| feat | cds | + Add 菜单的 6 项各自路由到现有 CDS 创建流程：Database/Docker → 切回列表 + 打开 infra modal；Routing → 打开 routing-rules 配置；Empty Service → 打开 build-profiles 配置；Volume/GitHub → 友好 toast 占位 |
| docs | cds | legend 提示文案动态化 + 顶部老 chip bar / legend 在 fs 模式下完全隐藏 |
