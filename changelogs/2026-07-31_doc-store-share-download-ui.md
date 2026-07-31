| fix | prd-admin | 知识库分享弹窗改为范围优先：顶栏分享可一键切「整个知识库 / 只分享当前这篇」，一句话讲清可见范围，修复「想分享单篇却公开整库」 |
| fix | prd-admin | 修复分享弹窗重复生成链接时列表多出一行同 id 重复卡片（后端复用链接，前端改为按 id 覆盖） |
| feat | prd-admin | 单篇分享范围下，若整库分享链接仍生效则当面告警并给出撤销入口，避免以为「只分享了一篇」 |
| feat | prd-admin | 知识库下载改为可选范围与格式：默认「当前文章」直接落一个文件，也可整库打包 ZIP；格式支持 Markdown / 纯文本 / 原始文件 |
| fix | prd-admin | Markdown 代码块与行内代码改走双主题 token，浅色纸面下不再出现黑底白字的暗块；高亮主题跟随明暗切换 |
| polish | prd-admin | 统一文档阅读区工具栏尺寸规矩：按钮 28px、纯图标 28x28、状态药丸 22px，消除同一行按钮忽大忽小 |
| fix | prd-admin | 分享默认范围改为「只分享当前这篇」，整库公开不再是默认；面板改成清单式版式（状态一句话 + 链接高亮 + 设置行 + 底部撤销） |
| security | prd-api | 知识库分享不再默认分配数字短链 /s/{seq}：对外主链恒为不可枚举的 /s/lib/{token}，数字短链改为用户主动点才生成（新增 POST share-links/{id}/short-link） |
| feat | prd-admin | 分享面板新增二维码，手机扫一扫直接打开分享页 |
| polish | prd-admin | 桌面端分享改为从「分享」按钮就地悬浮弹出（AnchoredMenu），不再居中弹窗遮挡正文；手机端仍走弹窗 |
| polish | prd-admin | 主题切换按钮新增 inline 形态（36px 药丸），修复分享阅读页顶栏与「返回知识库」一高一矮 |
| polish | prd-admin | 知识库左栏顶部收敛为「搜索 + 筛选」一行：排序 / 标题显示 / 更新时间 / 标签全部收进一屏平铺的筛选面板，已选标签仍在外可见 |
| fix | prd-admin | 列表「更新时间」默认不再显示（时间挤占标题可见宽度），可在筛选面板打开；验收库仍默认显示 |
| fix | prd-admin | 修复文档行首悬浮时出现黑方块：批量勾选框不再用近黑遮罩盖住文件图标，改为与图标互斥同槽显示，token 底色同步改为常规表面 |
| polish | prd-admin | 筛选面板内「排序」与「标题显示」段控尺寸统一（取小号），并去掉与分组标题重复的「排序」二字 |
| polish | prd-admin | 阅读区工具栏收敛：转录 / 生成字幕 / 智能体 / 证据板 / 历史版本 / 订阅信息 收进「更多」菜单，外面只留评论 / 收起 / 全屏 / 编辑 |
| fix | prd-admin | 修复大库里读着「后端搜索命中」的文档时分享范围静默回落整库：DocBrowser 回传带 searchResults 兜底的选中条目，页面用它做「当前这篇」的锚点 |
| fix | prd-admin | 分享与下载弹窗改为 createPortal 到 body + 高度走 inline style，避免被祖先 overflow/transform 裁切（frontend-modal.md 三硬约束） |
| fix | prd-admin | 下载「纯文本」格式真正去标记（Markdown 语法 / HTML 标签），不再只换后缀 |
