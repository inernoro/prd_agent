| feat | cds | CDS 卡片新增四色圆圈调试标记，支持 ripple 动效切换，标记后不会被优先停止容器 |
| fix | cds | 修复 CDS Widget 加载中卡死：API 响应结构解析错误（取对象当数组遍历） |
| refactor | prd-api | 提取 ResolveServerUrl 为共享扩展方法，统一修复 4 处 Request.Host 反代场景返回容器内部地址 |
| feat | cds | 颜色标记圈圈移到右上角 toolbar，部署日志按钮折叠进部署下拉菜单 |
| perf | cds | 颜色标记点击乐观更新，消除 300ms+ 延迟 |
