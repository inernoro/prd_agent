| feat | prd-admin | 设置 → 导航顺序 新增「全部用户」视图：第一行是所有人的默认导航，其余每人一行，自定义的排前面、沿用默认的排后面，已下线菜单用虚线红框标出，支持按人重置为默认 |
| feat | prd-api | 新增全员导航总览接口与单用户导航重置接口（settings.read / settings.write） |
| refactor | prd-admin | 导航顺序编辑器改用 dnd-kit：自绘拖影、拖动时条目实时让位、分隔横杆可按面积放大并支持键盘排序，替换原生 HTML5 拖拽 |
| chore | prd-admin | 删除 MAP 左侧「模型」菜单及 /mds 页面（含首页快捷入口、全部能力入口、移动端适配注册、死脚本）；mds 权限点与 api/mds 读接口保留 |
| chore | prd-api | 菜单目录移除 mds 条目；平台密钥完整性通知与授权健康检查的处理入口改指向模型网关 / 请求日志，不再指向已删除页面 |
| feat | prd-admin | 全员导航总览新增「清理已下线菜单」：一键从所有人默认导航与全部用户个人导航里拔掉目录中已不存在的菜单 key，不重置任何人的顺序 |
| feat | prd-api | 新增 remove-tokens 接口：按 token 从默认导航配置与全部用户偏好中批量拔除（settings.write） |
| fix | prd-admin | 全员导航总览：旧前缀 id（如 utility:emergence）不再被误判为已下线；默认导航本地回写与加载同口径迁移 |
| fix | prd-admin | 全员导航总览每行按侧栏真实渲染结果来画：用户没排过、被侧栏自动补到末尾的菜单也画出来并用虚线灰框标记 |
| fix | prd-admin | 全员导航总览行列表改为在卡片内滚动，卡片背景不再被内容溢出、边缘横穿行标题 |
| polish | prd-admin | 全员导航总览：自定义行走主色（左侧竖条 + 淡主色底），沿用默认行走中性灰，并加图例 |
| fix | prd-api | 全员导航列表附带全量菜单目录；remove-tokens 拒绝仍在目录里的菜单 key，防止权限不全的管理员误删他人合法菜单 |
| fix | prd-api | 平台密钥完整性告警：存量未关闭记录的处理入口也迁到模型网关 |
| fix | prd-admin | 全员导航总览：用服务端全量目录判「已下线」；只隐藏未排序的用户按默认顺序画、隐藏集与侧栏同口径 |
| fix | prd-admin | 首页预览图设置：无文生图模型时的指路文案改为 LLM Gateway 控制台，不再指向已删除的模型中心 |
| fix | prd-api | 用户偏好新增导航专属时间戳 NavLayoutUpdatedAt，总览排序与展示不再被皮肤等其他偏好改动带偏；GET 偏好暴露 navLayoutSynced |
| fix | prd-admin | 导航 store：服务端主动清空过布局时不再用 sessionStorage 旧布局回填上传，管理员按人重置不会被撤销 |
| security | prd-api | 全员导航总览接口改为需要 settings.write（或 super），不再仅凭 settings.read 放行 |
| fix | prd-admin | 实验台模型选择、视觉创作高级页里指向已删「模型管理」的文案改为 LLM Gateway 控制台 |
| fix | prd-admin | 总览行复演侧栏时，隐藏过滤后落单的分隔横杆收敛掉，与侧栏一致 |
| fix | prd-api | remove-tokens 的两段破坏性写入不跟随请求取消，管理员断线不会留下半截清理 |
| fix | prd-api | CCAS 素材图与向量模型缺失的指路文案改为 LLM Gateway 控制台，不再指向已删除的模型管理页 |
| fix | prd-admin | 请求日志页四个已无动作的模型池徽标改为纯展示元素，不再是可聚焦的空按钮；总览按人重置后从服务端重拉以保持排序 |
