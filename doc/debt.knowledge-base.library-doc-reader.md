# debt.knowledge-base.library-doc-reader

| 字段 | 内容 |
|---|---|
| 模块 | 殿堂阅读器（公开知识库浏览） |
| 状态 | open · 已评估不合 |
| 关联 | `prd-admin/src/pages/library/LibraryDocReader.tsx`（720 行）、`prd-admin/src/pages/library/LibraryStoreDetailPage.tsx`（140 行）、`prd-admin/src/components/doc-browser/DocBrowser.tsx` |
| 创建 | 2026-05-28 |

---

## 背景

2026-05-28 在做"统一文档阅读器"收口时，把 `DocumentStorePage`、`LibraryShareViewPage`、`WeeklyReportsTab` 三处都收敛到了 `DocBrowser` 共享组件（删了 1425 行重复实现）。**殿堂阅读器 `LibraryDocReader.tsx` 是有意保留没动**，本文件记录留债原因与未来融合条件，避免下次 session 又重新评估一次。

---

## 为什么这次没融合

`LibraryDocReader` 是公开知识库（殿堂）的专用阅读器，**视觉刻意做了差异化**：

- 米黄底色 `#FFFBF0`（vs DocBrowser 的深色玻璃）
- 圆体字 `'Nunito', 'Fredoka', sans-serif`
- 厚边框白卡片 + 暖色调（vs DocBrowser 的玻璃灰）
- 图标走 `#F59E0B` 琥珀色（vs DocBrowser 的蓝/灰）

这是**殿堂品牌的视觉差异化**——让用户进到「对所有人公开」的殿堂时，立刻感知到"这是公共陈列馆"而不是"工作台"。强制套 DocBrowser 的深色玻璃风会破坏这种区分。

数据契约是**完全可融合的**（左侧 `DocumentEntry[]`，右侧 markdown content，跟 DocBrowser 完全同构），仅卡在视觉皮肤。

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| LDR-1 | **DocBrowser 缺皮肤系统**：当前 `appearance` prop 只有 `inset` / `cards` 两种，都是深色玻璃基线。融合 LibraryDocReader 需要新增 `appearance: 'warm-public'`（或更通用的 theme/skin 体系），把"米黄底 + 暖色调 + 圆体字"封装为 token 集合。改造面：DocBrowser 内所有硬编码颜色（`border-token-subtle`、`bg-token-nested` 等）需走 token 转写，否则切皮就漏。预估 ~1 天。 | P3 | 殿堂被业务要求改造（如加新功能、改交互），或团队决定彻底统一视觉收口 | open |
| LDR-2 | **LibraryStoreDetailPage 是 LibraryDocReader 的直接调用方**：140 行薄壳，融合 LDR-1 后会跟着改 70 行左右（移除自己的数据 fetch + format 转换，直接传给 DocBrowser）。LDR-1 没动它就别动。 | P3 | LDR-1 落地后 | blocked-on-LDR-1 |
| LDR-3 | **后续 DocBrowser 优化拿不到殿堂**：现在私人知识库 / 分享 / 周报三处共享 DocBrowser，任一优化三处同步获益；**殿堂第四处不在内**。如：分享页加了 `?entry=` URL 高亮，殿堂没有；周报加了双卡片布局，殿堂没有。每次 DocBrowser 升级都要同步评估殿堂要不要也加。 | P2（持续累积） | DocBrowser 加大改动时 | open |
| LDR-4 | **殿堂的"克莱风"无 design 文档背书**：当前视觉差异化是隐式约定，没写在任何 design.* 里。如果有新设计师加入团队，可能误把殿堂统一回深色。建议补 `doc/design.library-visual-language.md` 写清"为什么殿堂用暖色 = 公共陈列馆隐喻"。 | P3 | 视觉迭代或新设计师 onboarding | open |

---

## 重新评估的条件

下面任一条件满足时，才值得重新评估"要不要融合"：

1. 殿堂被要求加 DocBrowser 已有但 LibraryDocReader 没有的能力（如全文搜索、文件夹树、字幕生成等）
2. DocBrowser 完成皮肤系统改造（独立项目），融合成本降到 ~半天
3. 用户反馈"殿堂阅读体验和我自己的知识库不一致让我困惑"
4. 团队决定彻底放弃"殿堂 vs 工作台"视觉区分，统一品牌

**当前不满足任一条件 → 维持现状，不动**。

---

## 反面参考

✗ "顺手把殿堂也融合了" — 720 行视觉细节，半天改不完；改完会破坏品牌差异化，要回滚成本更高
✗ "给 DocBrowser 加 theme prop 同时改三处" — 改造面太大，不该跟"周报融合"打包做

正确路径见 `frontend-architecture.md` 复用原则 + `no-rootless-tree.md` 借用法则。
