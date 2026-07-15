---
globs: ["prd-admin/src/**/*.tsx", "prd-desktop/src/**/*.tsx", "cds/web/src/**/*.tsx"]
---

# 确定性渲染：可视化必须与输入顺序无关（Deterministic / Order-Independent Rendering）

> 任何「从一个集合渲染出图」的可视化（3D 星系、力导向图、ReactFlow、自定义 canvas 树、任何**按数组下标定位**的布局），
> 其输出**必须只由内容决定，与集合的返回/插入顺序无关**。同样的内容，不管条目以什么顺序到达，必须渲染成同一张图。
> 触发：编辑任何做「集合 → 坐标/位置」布局的前端代码。

---

## 历史背景（本规则的由来，2026-06-28，实测坐实）

用户两个知识库（老库 M2 / 重新订阅的 MAP）在**同一份代码**下，一个布局均匀、一个「头重脚轻」。
绕了很多轮（先怀疑是分类算法回归，改了标题分层 / 主导方式 / appname 优先多版，都没解决），
最后**用 key（`X-AI-Impersonate` + `X-AI-Access-Key`）把两库真实数据拉下来对比**才定案：

- 两库 **337/338 篇文档完全相同**，顶层分布几乎一致（平台143 / 应用139 / 跨切面32 / 周报19）；
- 唯一实质差异是**条目返回顺序不同**（抽样 12% 逆序；M2 按创建序 `debt.cds.*` 打头，MAP 按重导入序 `spec.*` 打头）；
- 而星系布局 `layoutGalaxy` 用 `distributeDirections` / `spreadInCone` **按数组下标**分配球面位置 →
  顺序一变，`root.children[0]` 占球顶的那个分类就换了、每个枢纽子节点的扇面朝向全变 → 整图重排。

结论：**不是数据内容不同，是数据顺序不同 + 布局对顺序敏感**。这类 bug 极隐蔽（同代码、同内容、不同图），
本规则把它显式化，避免后人再绕一整天。

---

## 强制规则

### 1. 布局前对每一层子节点做确定性排序

按下标定位（Fibonacci 球、锥形铺开、网格、径向树等）时，取子节点**必须先排序**，禁止直接用插入顺序：

```ts
// 排序键：主次可按需，但必须是「纯内容函数」+ 稳定兜底（名字/id），不得依赖到达顺序。
const orderKids = (nodes: Node[]): Node[] =>
  [...nodes].sort((a, b) => b.docCount - a.docCount || a.name.localeCompare(b.name, 'zh'));

// ❌ 错误：位置随返回顺序变
kids.forEach((k, i) => place(k, dirs[i]));

// ✅ 正确：先确定性排序，位置只由内容决定
orderKids(kids).forEach((k, i) => place(k, dirs[i]));
```

判定口诀：**把同一份数据打乱顺序再渲染一次，两次结果必须逐像素一致。** 不一致就是违规。

### 2. 禁止把「到达顺序 / 时间戳 / Map 迭代顺序」当隐式布局键

- 不得依赖后端返回顺序、`Object.keys` / `Map` 迭代顺序、`Date` 等非内容因素决定位置或配色。
- 需要「稳定但任意」的分配时，用**内容派生的确定性键**（name / id 的 hash），不要用序号。

### 3. 位置分配用了 `forEach((x, i) => …dirs[i])` 就要自查

任何 `array.forEach((item, i) => positions[i])` / `array.map((item, i) => …)` 且 `i` 参与坐标/角度/半径计算的地方，
都要问：这个 `array` 的顺序稳定吗？不稳定就先排序。

---

## 诊断纪律（找这类 bug 的正确顺序）

本 bug 之所以绕很久，是因为一开始就去改代码。固化教训：

1. **「同代码不同结果」第一反应查数据 / 顺序 / 环境，不是改代码。** 改代码前先用受控数据复现。
2. **拿真实数据，别猜。** 有 key 就用 key 取真实数据对比（本仓库：`X-AI-Access-Key` + `X-AI-Impersonate: {用户名}`
   可访问用户私有资源，端点如 `/api/document-store/stores/:id/entries?all=true`）。禁止用「库是私有的抓不到」当借口——
   `X-AI-Impersonate` 就是为此存在（见 `api-debug` 技能）。
3. **可视化问题先确认「位置由什么决定」**：位置 = f(树) 还是 f(树 + 顺序)？后者就是顺序敏感 bug。

---

## 交付前自审

- [ ] 我这段布局用到 `forEach((x,i)=>…i…)` 的下标定位了吗？用到了 → 前面有确定性排序吗？
- [ ] 同一份数据打乱顺序渲染两次，结果一致吗？
- [ ] 有没有依赖返回顺序 / Map 迭代顺序 / 时间戳当布局或配色键？
- [ ] 排查「同代码不同结果」时，我是先拿真实数据复现，还是直接改代码猜？

任一不达标，先修再交。

---

## 相关

- `prd-admin/src/pages/document-store/DocumentGalaxyView.tsx` —— `layoutGalaxy` 的 `orderKids`（本规则首个落地）
- `doc/debt.knowledge-base.galaxy-layout.md` —— 本次排查的完整台账（真实两库数据对比 + 控制台自测脚本）
- `.claude/skills/api-debug/SKILL.md` —— 用 key + `X-AI-Impersonate` 取真实数据的方法
- `gesture-unification.md` —— 画布交互统一（同属 2D/3D 可视化规范族）
