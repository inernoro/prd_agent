| fix | prd-admin | 命令面板（Cmd+K）取消按权限过滤入口：请求日志 / 提示词 / 实验室 / 自动化规则 / 模型中心 / 团队协作等条目不再因当前用户缺少细粒度权限而完全隐藏，改由目标页自行校验 authz |
| fix | prd-admin | 命令面板卡片鼠标移出后 hover 高亮立即消失：拆分本地 isHovered 与键盘 selectedId，视觉取两者或，不再卡住在上次停留的卡上 |
| fix | prd-admin | 命令面板搜索框聚焦改为圆角矩形：包一层 label 容器承载 focus-within ring（圆角 + 紫色描边），input 本体加 no-focus-ring 压掉全局 :focus-visible 直角 outline |
