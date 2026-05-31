| fix | prd-admin | 任务树修复 4 处竞态：loadTree/卡点墙加 fetchIdRef 防陈旧响应、wheel 缩放 effect 依赖修正确保 svg 挂载后绑定、对话摘取 node 事件加树归属校验 |
| fix | prd-api | 任务树 UpdateNode 防护：根节点不可改父节点（避免整树失去根渲染空白）、新父节点不能是自身子孙（防环） |
| fix | prd-api | 任务树 CreateNode parentId 为空时挂到既有根，避免产生第二个根导致节点在画布消失 |
| fix | prd-api | 任务树 AddDependency 加边前做可达性检测，拒绝形成循环依赖（DependsOn 保持 DAG） |
| fix | prd-api | 任务树 ListBlockers 对 DependsOn 做 null 防护，避免卡点墙聚合时空引用崩溃（High） |
| fix | prd-api | 任务树 UpdateNode 禁止把非根节点清空父节点（防止产生第二个根导致节点消失） |
| fix | prd-admin | 对话摘取切树后节点落到原树时弹 toast 反馈（遵循 server-authority 不中断服务端任务） |
