# 主页弹窗海报页面拆分规则

把周报 Markdown 拆成 4-6 张轮播卡,给登录用户一眼就能看懂的「海报版周报」。

---

## 海报目标

- **主要受众**:平台所有登录用户(不是只给管理员)
- **阅读时长**:全部看完 ≤ 30 秒
- **目的**:让用户知道"这周平台变了什么、最重要的 1-3 件事、末页跳到完整周报"

---

## 页面结构(推荐 5 页)

| 页号 | 角色 | 标题示例 | 正文长度 | 提示词主题 |
|------|------|----------|----------|------------|
| 0 | 开篇 / 亮点 | 本周亮点 | 60-100 字 | 整体氛围图(抽象几何) |
| 1 | 最重要功能 1 | {功能名} | 80-120 字 | 功能隐喻图 |
| 2 | 最重要功能 2 | {功能名} | 80-120 字 | 功能隐喻图 |
| 3 | 修复 & 优化 | 修复 & 优化 | 60-100 字 | 工具修理 / 性能加速 |
| 4 | 下周预告 + CTA | 下周还会有... | 50-80 字 | 未来感 / 展望 |

页数可根据本周重大脉络数量浮动:亮点少用 4 页,亮点多用 6 页,不允许 ≤ 3 页或 > 7 页。

---

## 每页字段填写规范

### title
- 10-14 个汉字(不含标点),不要堆砌成句子
- 禁止「新增/修复/优化」这类过于技术化的开头,用名词短语
- 示例:
  - ✅ `周报海报上线`
  - ❌ `新增了主页弹窗海报功能,支持轮播和 CTA`

### body
- 80-120 字
- 从**用户角度**描述「能做什么、解决了什么问题」,不要写代码实现
- 可以两段,中间用换行分隔(弹窗用 `whitespace-pre-wrap` 渲染)
- 如涉及新入口,提一句「在 XX 位置」

### imagePrompt
- **英文**,80-160 字
- 风格关键词必须包含:`cinematic`, `isometric` 或 `dreamy` 或 `retro-futurism`,以及 `dark background`, `volumetric lighting`, `glow`
- 不含人脸(减少 AI 畸形)
- 示例:
  ```
  A cinematic dark-themed illustration of a glowing carousel of floating cards
  orbiting a central holographic orb, retro-futurism palette of cyan-violet-magenta,
  volumetric lighting, soft bokeh, isometric perspective, ultra-detailed, no people
  ```

### accentColor
- 十六进制 `#RRGGBB`
- 与页面主题呼应,整张海报 5 种颜色不要重复
- 建议色卡:`#00f0ff` 青 · `#7c3aed` 紫 · `#f43f5e` 玫红 · `#f59e0b` 琥珀 · `#10b981` 翠

---

## 末页 CTA 约定

- `ctaText`:默认 `阅读完整周报`,也可改为 `查看全部更新` / `立即体验新功能`
- `ctaUrl`:优先跳到本周周报页(如 `/report-agent/teams/{teamId}/weeks/{weekKey}`),找不到就跳 `/changelog`

---

## 反面案例

| 错误做法 | 问题 |
|----------|------|
| 把 20 条 PR 标题堆到一页 | 信息过载,用户看不完 |
| 用中文写 imagePrompt | 生图模型理解效果差 |
| 每页都写 300+ 字 | 轮播的意义就是快速扫读 |
| 每页 accentColor 都用紫色 | 视觉单调,失去海报感 |
| 末页只写「完」 | 浪费 CTA 机会 |

---

## 写完之后

调用 `POST /api/weekly-posters` 创建草稿(状态 = draft),然后指导用户:

1. 去「百宝箱 → 周报海报编辑器」选中草稿
2. 每页点右上角紫色「生成图片」按钮(编辑器会直接调 `/api/visual-agent/image-gen/generate`,
   约 10-30 秒返回图片并自动填回)
3. 不满意就原地改 `imagePrompt` 后重新点「生成图片」
4. 4-6 页都生成完 → 点右上角「保存草稿」→「发布到主页」
