| feat | prd-admin | 知识库卡片支持右键菜单（与三点「更多」同源，另含打开/置顶） |
| feat | prd-admin | 今天有更新的知识库卡片右上角显示 NEW 徽标 |
| polish | prd-admin | 知识库卡片右上角降噪：状态（已分享/同步）改为安静小图标常显，置顶/更多动作 hover 才显现（触屏常显） |
| feat | prd-admin | 打开知识库默认选中第一篇文档（无主文档时按当前排序兜底，桌面端），右侧不再空白 |
| feat | prd-admin | 知识库书籍顺序下支持拖拽文档自定义排序（插入位置指示线，写入 SortOrder 服务端持久化） |
| polish | prd-admin | 知识库列表/库内排序、标签、置顶、更多等按钮补齐 hover 反馈；卡片 hover 改为克制的描边提亮（双主题） |
| fix | prd-api | 文档条目纯排序写入不再 bump UpdatedAt/团队动态，拖拽排序不会误点亮 NEW 或打乱「最近更新」 |
| style | prd-admin | 知识库卡片改素色实底面板（去玻璃 blur/棱光/噪点，双主题 token），hover 零位移只提亮描边 |
| feat | prd-admin | 置顶/取消置顶带 FLIP 位移动画 + 落点琥珀描边渐隐 + 平滑跟随滚动，库多时一眼看到卡片挪去了哪 |
| feat | prd-admin | 有置顶时列表分「已置顶 / 其他」两个小节，置顶卡片滑入分区落点明确 |
| polish | prd-admin | 知识库搜索框支持 ESC 一键清空 |
| feat | prd-admin | 知识库文件夹（章节）支持拖拽同级换位（书籍顺序下，插入指示线 + SortOrder 持久化），文件夹行补 hover 反馈 |
| polish | prd-admin | 知识库目录行重排（拖拽/置顶/切排序）带 FLIP 位移动画，行滑到新位置而非瞬移 |
| feat | prd-admin | 团队空间卡片标注归属团队（首个团队名 +N，tooltip 列全量），「全部」聚合视图不再分不清来源 |
| feat | prd-admin | 系统级界面材质：新增「素色 / 液态玻璃」材质开关（设置 → 皮肤设置），一处切换全站 surface/卡片/工具条统一跟随，默认素色 |
| style | prd-admin | 素色材质全局清除 backdrop-filter、压平棱光内高光与超大投影；GlassCard 素色走实底渲染但动画不降级 |
| fix | prd-admin | 修复 5 处素色下会失焦的低透明表面（分享页密码门 / 短链提示卡 / 竞技场工具条 / 首页顶栏 / 工作流聊天抽屉），背景提升为自身可读的实底 |
| feat | prd-api | 主题配置持久化新增 Material 字段（素色/液态玻璃跨设备保持） |
| docs | doc | 新增 debt.frontend.material-system 台账（低风险装饰面复核 / 长尾玻璃迁 token） |
| style | prd-admin | 素色材质现代化重做：表面纯平全不透明、去白色镜面高光与渐变（亚克力感来源）、静息态发丝级投影、hover 全站零位移描边提亮 |
| style | prd-admin | 素色瘦身第二波：极光背景静音为纯底色（去白雾）、工具条 46 变 42px、按钮去内嵌白环/彩色泛光（map-btn 钩子集中调配） |
| feat | prd-admin | 皮肤设置极简为两个决定：外观（深色/浅色）+ 界面材质（素色/液态玻璃）；色深/透明度/光晕/侧边栏玻璃/性能模式归一化为系统预设不再暴露 |
| feat | prd-admin | 外观（深/浅）从移动端专属升级为全局偏好：桌面同样生效，首页移动端切换与设置页共用同一 SSOT |
| style | prd-admin | 素色画布带回静态品牌色氛围（左上靛蓝/右下青色，与强调色同族联动），治「首页偏黑白」 |
| fix | prd-admin | 首页 hero 浅色外观适配：极光提亮层/白雾底光浅色不渲染，问候语/副标题/eyebrow/搜索框/快捷胶囊改走双主题 token |
| fix | prd-admin | 修复材质开关在性能模式/Windows 自动降级/系统「减少动态效果」下完全失灵：材质 100% 跟随用户选择，性能路径只压动画不劫持表面 |
| fix | prd-admin | 头像菜单「液态玻璃」开关接到界面材质 SSOT（旧实现切 performanceMode 已断线导致切换无效），与设置页材质开关联动 |
| style | prd-admin | 液态玻璃去斜面棱：50% 白顶部内描边/侧缘线/底部暗线（塑料感来源）改为发丝级柔光，blur 升一档补材质厚度（GlassCard/nav-bar/raised 同步） |
| fix | prd-admin | 回应 Codex 五条 P2：素色弹窗实底兜底 / 进库首篇按真实树序中序 DFS / 选玻璃清隐藏 performance 存量值 / reduced-motion 不再清 blur（玻璃不碎）/ 侧栏不再读已下线的 sidebarGlass 存量值 |
