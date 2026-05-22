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
