## 可操作的框架示例

示例使用正式 CDS Web 中的组件和主题。各入口固定到同一份私有示意稿版本。

- [示意稿件](https://cds.miduo.org/design?project=prd-agent&design=DSN-40F72C21&version=1&tab=preview&screen=example-desktop)
- [组件陈列](https://cds.miduo.org/design?project=prd-agent&design=DSN-40F72C21&version=1&tab=preview&screen=components-desktop)
- [桌面导航](https://cds.miduo.org/design?project=prd-agent&design=DSN-40F72C21&version=1&tab=preview&screen=navigation-desktop)
- [手机导航](https://cds.miduo.org/design?project=prd-agent&design=DSN-40F72C21&version=1&tab=preview&screen=navigation-phone)
- [监控模块](https://cds.miduo.org/design?project=prd-agent&design=DSN-40F72C21&version=1&tab=preview&screen=monitor-desktop)
- [交付与可复用源码](https://cds.miduo.org/design?project=prd-agent&design=DSN-40F72C21&version=1&tab=delivery)

「组件陈列」可操作主要状态并复制实际运行的 React 源码。「交付」可下载完整文件和验收截图。
在固定源码与依赖上可重复生成同一份 HTML。重复写入现有相同输出会返回 unchanged。
示例保留 CDS 主按钮和橙色背景，暗色文字沿用交付源码中的深色前景。浅、深色文字对比分别实测为 4.86:1 和 7.10:1。

## 公共组件来源

- `ConsoleLayout`、`AppShell`、`TopBar`、`AppRail` 与手机菜单组成 CDS 公共壳。桌面与手机从同一份 `RailNav` 渲染主导航，按路由与权限显示入口和高亮。新增模块内容由壳体承载。[公共壳源码](https://github.com/inernoro/prd_agent/blob/7f0f6e9ff3798985a79e55f64d6ea928b67452df/cds/web/src/components/layout/AppShell.tsx)
- 系统设置使用公共壳，桌面分组目录与手机 `SettingsDirectory` 连接同一组设置页签。选择权限总览可直接核对两端。[系统设置实站](https://cds.miduo.org/cds-settings#identity) · [手机目录源码](https://github.com/inernoro/prd_agent/blob/7f0f6e9ff3798985a79e55f64d6ea928b67452df/cds/web/src/pages/cds-settings/SettingsDirectory.tsx)
- 项目、分支和代码审查的页面容器、筛选和控件以正式站为参照。各模块按任务保留已有的列表、卡片与详情布局。[项目](https://cds.miduo.org/project-list) · [分支](https://cds.miduo.org/branches/prd-agent) · [代码审查](https://cds.miduo.org/code-reviews)

## 模块差异样例

监控使用同一个公共壳，并在 `TopBar` 中部放入 `MonitorViewNav`。服务工作区有自己的密度档、筛选、状态符号和健康矩阵。监控的局部调色和断点在该模块内取用，公共主题的状态色保持原有语义。设计稿应把这类规则记录为模块差异。[监控实站](https://cds.miduo.org/status) · [监控入口源码](https://github.com/inernoro/prd_agent/blob/7f0f6e9ff3798985a79e55f64d6ea928b67452df/cds/web/src/pages/StatusPage.tsx) · [监控工作区样式](https://github.com/inernoro/prd_agent/blob/7f0f6e9ff3798985a79e55f64d6ea928b67452df/cds/web/src/pages/status/monitor-workspace.css)
