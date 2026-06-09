| feat | prd-admin | 产品管理智能体缺陷「严重度+优先级」统一为 P0-P3「等级」，与需求/功能口径一致 |
| feat | prd-api | DefectReport 新增 Grade 字段；产品缺陷创建/编辑/图谱/概览/转需求改用 grade（旧数据由 severity 兜底） |
| fix | prd-admin | 产品管理智能体工作台「我的待办」及缺陷列表/概览/状态分布图，缺陷状态由英文(submitted)改为中文标签(已提交/待处理等) |
| feat | prd-api | 工作台「我的待办」新增 GET /products/{id}/my-todos 端点，只返回需我处理项（需求/功能按状态责任人+未到终态，缺陷跟我相关+未完成） |
| fix | prd-admin | 工作台「我的待办」改用 my-todos 端点，已处理/已流转/已完成的需求·功能·缺陷自动从待办消失，需求/功能状态显示中文工作流状态名 |
| fix | prd-admin | 产品管理智能体评论区@提醒：改用 /api/teams/search-users（普通成员可用），修复非管理员列表空无法@；KanbanBoard 处理人姓名同步改造 |
| fix | prd-admin | UserSearchSelect 下拉空间不足时向上翻转 + 按可用空间限高 + 左边界夹取，修复评论区@弹层靠底被裁切显示不全 |
| fix | prd-api | 工作台「我的待办」缺陷改为按状态责任人过滤：上报人仅在草稿/待验收才显示，提交流转到处理环节后从上报人待办消失（修复 reporter 提交后仍挂待办） |
| feat | prd-api | 产品管理智能体新增工作助手问答 SSE 端点 POST /products/{id}/assistant/ask：以该产品全量数据+知识库文档为上下文流式回答，严格按产品成员权限闸口、只限本产品、知识库仅取文本索引截断 |
| feat | prd-admin | 工作台新增「工作助手」入口，点击从右侧滑出抽屉(占视口30%)，问答形式调用AI，预置本月需求分析/需求矩阵分析/缺陷分析三个快捷问题 |
| feat | prd-api | AI助手上下文补全人员(处理人/负责人/上报人/团队)与关系(功能→需求、缺陷→追溯对象)，prompt 改为纯文本输出+深度分析(关系挖掘/人员负载/经验总结建议)，修复"查无某人"；端点重命名为 AI助手 |
| fix | prd-admin | AI助手回答去除 Markdown 标记渲染为纯文本(stripMarkdown)；「工作助手」改名「AI助手」 |
| fix | prd-admin | UserSearchSelect 已选 value 在关闭态预拉目录解析显示名，修复「处理人」已指派却显示占位空白 |
| fix | prd-admin | AI助手抽屉改主流聊天样式：用户/AI 各带头像+气泡(底色+边框)，回答可一键复制，字号收小；对话存 sessionStorage(按产品隔离)关闭重开不丢+手动清除；工作台入口移到 SectionShell 右上角不占空间 |
