| feat | prd-admin | 海鲜市场上传弹窗精简：核心 3 字段置顶、封面/图标/预览/标签折叠进进阶；标题/详情 hint 压缩到 1 行 |
| feat | prd-admin | 上传支持单文件（.md / .markdown / .txt），前端用 JSZip 实时包装成 SKILL.md zip 走原通道，零后端改动 |
| feat | prd-api | 新增 POST /api/marketplace/skills/draft-description SSE 端点，拖入文件后流式起草 30 字详情，避免空白等待 |
| feat | prd-admin | 详情输入框新增 AI 起草徽标 + 流式预填；用户开始输入立刻让步并中断 SSE |
| fix | prd-api | AppCallerRegistry 新增 marketplace-skill 注册项，修复 AI 起草 APP_CALLER_INVALID |
| fix | prd-api | SSE JSON 编码用 UnsafeRelaxedJsonEscaping，中文不再被转成 \uXXXX |
| fix | prd-admin | SSE 区分 event:error，错误不再被拼进详情框，改走 error 状态 |
| fix | prd-admin | 技能详情弹窗改用 surface-popover（panel-solid 0.92 不透明），不再透出底层市场卡片 |
| fix | prd-api | CI 守卫 default-deny：删 IsKnownPrefix 白名单，所有 caller-code 字面量必须在 Registry，杜绝新前缀（marketplace-skill / page-agent 等）静默漏检 |
| fix | prd-api | 补登注册 page-agent.generate::chat（CapsuleExecutor 3 处旧裸字符串），同步替换为常量引用 |
| feat | prd-api | 新增 GET /api/marketplace/skills/{id}/zip-content + public/skill-share/{token}/zip-content 同源代理，解决浏览器对 COS/R2 直链 CORS 拒绝 |
| fix | prd-admin | 技能详情弹窗 + 分享页 zip 预览改走同源代理 URL，不再 Failed to fetch；fetch 携带 Bearer token |
| feat | prd-admin | 海鲜市场卡片用 reactbits SpotlightCard（普通）/ PixelCard（官方）双形态；官方卡像素动效色种子来自标题哈希，无封面图 |
| feat | prd-admin | 封面图上传前客户端 resize（1280×720 上限 + webp/0.82），上传上限从 5MB 降至 2MB |
| chore | prd-admin | 新增 reactbits/ 目录 + LICENSE.md（MIT + Commons Clause 归属），eslint 对该目录关 ban-ts-comment / exhaustive-deps，保持上游原样可 diff |
| fix | prd-admin | 官方技能卡 PixelCard 改为挂载后程式 focus 自动触发 appear（不再 hover-only）+ IntersectionObserver 滚回视口再 focus + CSS 关 focus 轮廓 + 底色压暗让像素更显眼 |
| fix | prd-admin | 官方卡 PixelCard 内 mkt-card 被 grid 挤成 0 高度 → glass 被 overflow:hidden 切掉，导致整张卡只剩像素无文字；改用 position:absolute inset:0 直接覆盖在 canvas 上层 |
| fix | prd-admin | 官方卡像素「不悬浮就空白」修复：给 vendored PixelCard 加 autoAppear 开关（挂载即播放 + 忽略 mouseleave/blur 收起），替换之前不可靠的程式 focus hack；偏离上游已在 reactbits/LICENSE.md 标注 |
| feat | prd-admin | 官方技能卡改用自研 SkillGlyph（手绘古典线描）替代 reactbits PixelCard：暖彩线描 + feTurbulence 手绘抖线 + 暖光，三形态（罗盘/植物/星图）按 tag 命中 skillGlyphRegistry 决定、无 tag 回退名字哈希；视口懒渲染防 turbulence 拖慢；移除 vendored PixelCard + officialSkillPalette |
| feat | prd-admin | SkillGlyph 新增「精英」金色八角徽章形态（emblem），tag=精英 触发；skillGlyphRegistry 补全 工具/需求/技能 等 tag 归类 |
| chore | prd-admin | 官方技能打包：单主标签策略 + TAG_OVERRIDE 手工修正（老王=精英、findmapskills=技能+精英 等）+ 排除清单（qa-ledger/cn-brief-summary 等纯输出格式类不进市场） |
| feat | prd-api | 官方技能全量上架：OfficialSkillCatalog 读内嵌 JSON 注入 14 个精选技能（findmapskills 仍特殊处理）；csproj 内嵌目录；List/Fork/GetById/Favorite 全 touchpoint 按 official-{key} 解析；OfficialSkillsController.Download 从目录打完整 zip（含 reference/scripts 全部文本文件）|
| feat | prd-admin | 海鲜市场拆「官方推荐」+「社区上传」两区，官方置顶不挤瀑布流埋没用户上传 |
| chore | prd-api | 官方技能打包改 INCLUDE 精选白名单（15 个可移植技能）+ 完整目录打包（v2 catalog，单文件 96KB 上限），剔除绑死本仓库基础设施的内部技能 |
| fix | prd-api | 官方技能给中文友好备注名（DISPLAY_NAME map），卡片不再裸显英文 key |
| fix | prd-admin | 官方技能 zip 预览改用 skill.zipUrl 直连（同源 AllowAnonymous 完整 zip），修复 official-* 走 authed zip-content 代理查 DB 落空导致的 404 / 直开 401 |
| fix | prd-api | 官方目录 DTO createdAt 用固定发布日期（曾误用 DateTime.UtcNow → findmapskills AI 的 sort=new 轮询每次误报 14 个新技能、最新排序乱序）|
| fix | prd-api | Open API 官方注入加 includeCatalogWhenUnfiltered=false：无搜索词不注入目录技能，避免 AI list/分页/轮询被 15 个官方占满 budget 翻不到社区技能；Web 仍全展示（归「官方推荐」行）|
| feat | prd-admin | 社区 skill 无封面也用 SkillGlyph（哈希形态，不传 tags 故无精英徽章），拉平与官方卡的视觉；社区卡 hover 同样「绽放」 |
| feat | prd-api | /tags 端点合并官方 catalog 的 tag（精英/开放接口等），用户可按「精英」筛出 laowang 等 |
| feat | prd-admin | 海鲜市场改编辑气质：技能图标重做为炭黑手绘抽象线条 + 陶土锚点圆点（8 个专属象形符号 + 哈希抽象兜底），技能图标区背景走暖米灰纸底 #F0EEE6，市场页背景走暖白纸张 #FAF9F5；去辉光/去多彩，悬浮仅陶土锚点轻微放大。仅改背景+技能背景，不动卡片结构/工具栏 |
| feat | prd-admin | 技能图标定稿 v6 游戏技能图标：暖彩手绘线条 + 六边技能槽框（悬浮缓缓旋转）+ 13 个专属象形符号 + 哈希抽象兜底；撤销上一版纸张/炭黑/陶土编辑气质（页面背景、技能图标区背景回退深色），深浅混搭不协调问题消除 |
