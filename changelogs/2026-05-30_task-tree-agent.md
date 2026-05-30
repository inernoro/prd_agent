| feat | prd-api | 新增个人任务树 Agent 后端：TaskTree/TaskNode 模型 + task_trees/task_nodes 集合 + TaskTreeController（树/节点 CRUD、依赖 DAG 增删、卡点上报、对话摘取 SSE 流式经 LLM Gateway） |
| feat | prd-api | 注册 AppCaller task-tree-agent.extract::chat、权限 task-tree.use（并入三个内置角色） |
| feat | prd-admin | 新增个人任务树页面 /task-tree：思维树可视化（横向 tidy / 径向布局、拖拽平移 + 滚轮缩放）、节点进度编辑、卡点墙上报视图、对话摘取任务（SSE 流式打字） |
| feat | prd-admin | task-tree 注册到 navRegistry + 百宝箱（wip）+ shortLabel；新增 service/contracts/api 端点 |
