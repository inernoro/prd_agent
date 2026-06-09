| feat | prd-admin | 产品管理智能体缺陷「严重度+优先级」统一为 P0-P3「等级」，与需求/功能口径一致 |
| feat | prd-api | DefectReport 新增 Grade 字段；产品缺陷创建/编辑/图谱/概览/转需求改用 grade（旧数据由 severity 兜底） |
| fix | prd-admin | 产品管理智能体工作台「我的待办」及缺陷列表/概览/状态分布图，缺陷状态由英文(submitted)改为中文标签(已提交/待处理等) |
| feat | prd-api | 工作台「我的待办」新增 GET /products/{id}/my-todos 端点，只返回需我处理项（需求/功能按状态责任人+未到终态，缺陷跟我相关+未完成） |
| fix | prd-admin | 工作台「我的待办」改用 my-todos 端点，已处理/已流转/已完成的需求·功能·缺陷自动从待办消失，需求/功能状态显示中文工作流状态名 |
| fix | prd-admin | 产品管理智能体评论区@提醒：改用 /api/teams/search-users（普通成员可用），修复非管理员列表空无法@；KanbanBoard 处理人姓名同步改造 |
| fix | prd-admin | UserSearchSelect 下拉空间不足时向上翻转 + 按可用空间限高 + 左边界夹取，修复评论区@弹层靠底被裁切显示不全 |
| fix | prd-api | 工作台「我的待办」缺陷改为按状态责任人过滤：上报人仅在草稿/待验收才显示，提交流转到处理环节后从上报人待办消失（修复 reporter 提交后仍挂待办） |
