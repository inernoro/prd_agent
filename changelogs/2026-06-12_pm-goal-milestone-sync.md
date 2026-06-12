| fix | prd-admin | 目标设为里程碑后「里程碑」tab 看不到：GoalsPanel 联动操作（设为/取消里程碑、删目标）通过 onMilestonesChanged 通知父级刷新 milestones，不再依赖整页刷新 |
| fix | prd-admin | 里程碑日历视图新增「未排期」区域：无截止日的里程碑（含目标联动里程碑）不再隐身，可点开补日期 |
| fix | prd-api | 删除目标时级联清理 AutoFromGoal 联动里程碑，不再留孤儿数据（手动建的关联里程碑不动） |
| feat | prd-api | 里程碑列表返回 autoFromGoal 字段，前端可区分目标联动里程碑 |
| feat | prd-admin | 目标/里程碑视觉区分：联动里程碑在时间轴/日历/管理条/详情抽屉显示 Target 图标 + 「来自目标」紫色标记；设为里程碑的目标在列表卡与画布节点常显紫色 Flag 标记 |
| feat | prd-api | AI 项目简报：POST /api/pm/projects/:id/briefings/generate SSE 生成（硬数据服务端统计 + LLM 结构化内容 + 模板渲染自包含 HTML），简报列表/详情/删除端点，pm_briefings 集合，注册 pm-agent.briefing::chat |
| feat | prd-admin | 报表 tab 新增「项目简报」区块：生成（SSE 阶段/思考/逐字全程可视化 + 模型名展示）、历史列表、iframe 预览、下载 HTML 单文件 |
| feat | prd-api | 简报分享与托管：POST /briefings/:id/share 开关分享（可撤销 token），GET /briefings/shared/:token 匿名直出 HTML，POST /briefings/:id/save-to-hosting 一键存网页托管；审计过滤器登记简报动作 |
| feat | prd-admin | 简报预览弹窗新增「开启分享/复制链接/撤销分享」「保存到网页托管」操作，列表显示分享中/已托管标记 |
| fix | prd-api | 简报匿名分享被 AdminPermissionMiddleware 拦成 401：/api/pm/briefings/shared/ 加入扫描器 PublicRoutes 白名单（token 即凭证） |
| feat | prd-api | 简报 5 套风格主题（经典商务/暗夜科技/暖纸杂志/极简黑白/活力渐变）：生成时可选，落库渲染数据快照，POST /briefings/:id/restyle 切换风格即时重渲染不重调 LLM；styles 清单端点 SSOT |
| feat | prd-admin | 简报生成弹窗新增风格选择卡；预览弹窗新增全屏切换、切换风格面板；保存到托管成功后按钮变「打开托管站点」+ 列表「已托管」可点击直达，反馈不再依赖弹窗 |
| feat | prd-api | 简报重命名端点 PUT /api/pm/briefings/:id（owner/leader/创建者，120 字上限），审计登记 |
| feat | prd-admin | 「资料」tab 新增「简报」子 tab 管理主场：搜索/风格筛选/行内重命名/批量删除/超 10 条按月分组，?sub= 深链直达；报表 tab 简报区块瘦身为最近 3 条轻入口 + 「管理全部」跳转 |
| polish | prd-api | 简报 HTML 去掉页脚「由 PRD Agent 生成 · 模型」注释（模型名系统内弹窗仍可见） |
| feat | prd-api | 简报报告周期：生成接受 from/to（中国时区自然日），叙事数据按周期取（周期内达成里程碑/周期内周报），总体指标保持截至当前真值；标题与页头带报告周期，periodFrom/To 落库 |
| feat | prd-api | 简报调整：POST /briefings/:id/refine（SSE），复用落库硬数据快照 + 原内容 + 自然语言指令重写并原地覆盖（不重调统计、不留旧版本）；生成端点支持可选补充要求 note |
| feat | prd-admin | 生成弹窗新增报告周期选择（本周/上周/本月/上月/全周期/自定义）与「补充要求」输入；预览弹窗新增「调整内容」：自然语言描述 → SSE 流式重写 → 原地刷新 |
| fix | prd-api | 简报调整偶发「LLM 流式失败: No cookie auth credentials found」：PM 智能体所有 LLM 流式调用在零产出失败时自动重试（至多 3 次，每次重新走模型解析切换池内健康平台） |
| refactor | prd-admin | 项目知识库移除「成员作品」子视图与二级标题，只保留知识文档直出 |
| feat | prd-api | 网页托管新增 GET /api/web-pages/:id/content：服务端代理读取站点入口 HTML（owner/团队成员可读，2MB 上限，包装资产站拒绝），供知识库导入绕开浏览器跨域 |
| feat | prd-admin | 项目知识库新增「从网页托管导入」：选择我的/团队共享站点，HTML 内容一键导入为知识文档（可预览） |
| revert | prd-admin | 按用户要求下线简报「调整内容」入口（预览弹窗按钮/面板/流式重写 UI 移除；后端 refine 端点暂留无入口，记入债务台账） |
| feat | prd-admin | 知识库 HTML 文档真渲染：fileTypeRegistry 新增 html 类型（Globe 图标 + html 预览），FilePreview 对 HTML 正文用 sandbox iframe srcDoc 渲染页面而非源码（编辑态仍可改源码） |
| feat | prd-admin | 知识库双击文件名即可重命名（复用既有重命名弹窗，文件夹双击仍为展开/收起） |
| polish | prd-admin | 「从网页托管导入」并入文档列表统一「添加」菜单（与新建文档/上传文件/新建文件夹同级），移除右上角独立按钮，内容区上移；HTML 文档不再被 <!DOCTYPE html> 源码首行污染「正文标题」 |
| fix | prd-api | 知识库上传/编辑被拦 403「无权限」：document-store 的 stores/entries 业务路由从 AdminPermissionMiddleware 豁免（登录 + 业务层 CanRead/CanWrite 鉴权保留）；控制器权限位改为权限服务回查兜底（豁免后中间件不再注入 claims，避免识途/产品知识库管理员判定失效） |
| fix | prd-admin | 任务开始/截止日期保存后少一天（看似保存不了）：日期改为纯日期字符串提交（与里程碑同口径），不再经本地时区转 UTC ISO |
| fix | prd-admin | 普通用户搜不到人：成员/干系人/会议参会人三处面板弃用管理员 /api/users 预取，统一走 UserSearchSelect 的 directory 搜索（仅需登录）；组件新增 onSelectUser 回传用户对象供记录姓名快照 |
