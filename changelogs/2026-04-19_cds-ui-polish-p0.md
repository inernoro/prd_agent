| fix | cds | 白天模式「+ 新建项目」按钮背景缺失 —— 选择器从 `.btn-primary-solid` 升级为 `button.btn-primary-solid`,让它与 `[data-theme="light"] button`(specificity 0,1,1) 平局,靠后声明顺序胜出;同时为描边加 1px accent 边框,悬浮色不再被全局 button:hover 盖掉 |
| fix | cds | 分支列表桌面端塌成单列 —— `.branch-list` 的 `display:flex` 让 CSS `column-count:3` 被完全忽略;`@media (min-width:768px)` 内显式翻回 `display:block` + `gap:0`,三/四列流式布局恢复 |
| fix | cds | 分支页顶部 `.view-mode-toggle` 比相邻 icon 按钮高半圈 —— 去掉遗留的 `margin:0 0 10px`,加 `min-height:36px` 对齐 `.icon-btn` 尺寸,整行 header-actions 共享同一条基线 |
| feat | cds | 分支页 ⚙ 菜单补回 6 条被移出去的快捷项(批量编辑环境变量 / 初始化配置 / 预览模式切换 / 镜像加速 / 浏览器标签名 / CDS 自动更新)+ 一键导出配置,并新增「快捷 · CDS 全局开关」分组标签(`.settings-menu-group-label`) —— 让用户在分支页也能触达高频操作,不必每次跳去项目列表 |
| feat | cds | 分支卡 port-badge 改用「语言/框架 icon + 端口号」—— 新增 portNode/portDotnet/portPython/portRust/portGo/portReact/portVue/portDb 语言图标;`detectPortIconKey(profile)` 从 dockerImage/command/id 推断(react > node / dotnet > net / mongo > go);隐藏 `api:` `admin:` 文字,profile 名字只保留在 tooltip(hover 显示) |
| test | cds | Project 别名 PUT 用例新增 6 条(验证 aliasName/aliasSlug 接受 / 清空 / 长度 / 正则 / 自 slug 冲突 / 跨项目 slug 冲突场景),738/738 通过 |
| chore | ci | `.github/workflows/ci.yml` 新增 cds-build job 并纳入 ci-status 聚合门禁 —— Phase 1 单一绿勾覆盖 server + admin + desktop + cds 四个子系统(CDS 仍保留独立 cds.yml 以保持操作员熟悉度,允许微量重复执行换取统一门禁) |
