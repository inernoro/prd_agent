---
type: debt
appname: knowledge-base
module: galaxy-layout
status: active
updated: 2026-06-28
---

# 文档星系「不均匀 / 头重脚轻」根因台账

## 一句话结论（实测坐实，非猜测）

**两个知识库内容几乎完全相同，唯一实质差异是「条目返回顺序」不同；而星系布局按数组下标定位、对顺序敏感，
所以同样的内容因顺序不同渲染成了不同的图（一个匀、一个头重脚轻）。根因是「布局对输入顺序敏感」，不是数据内容、更不是分类算法。**

对应规则已固化：`.claude/rules/deterministic-rendering.md`（可视化必须与输入顺序无关）。

## 现象

- 同一分支、同一份代码，老库 M2（`3b025…`）布局均匀，重新订阅的 MAP（`bd18b…`）头重脚轻。
- 排查一开始误以为是分类算法回归，改了标题分层 / 主导方式 / appname 优先多版都没解决——因为根因不在分类。

## 实测数据对比（用 key 拉真实数据，`X-AI-Access-Key` + `X-AI-Impersonate`）

| 维度 | M2（均匀） | MAP（头重脚轻） |
|---|---|---|
| 文档数 | 339 | 338 |
| 有 sourceUrl | 338 | 338 |
| title 点分文件名 | 338 | 337 |
| 顶层分布 | 平台143 / 应用139 / 跨切面32 / 周报19 / 悬空3 / 顶层3 | 平台143 / 应用139 / 跨切面32 / 周报19 / 顶层3 / 悬空2 |
| 共同文档 | \multicolumn 两库 337 篇完全相同 | |
| 条目顺序 | 按创建序（`debt.cds.*` 打头） | 按重导入序（`spec.*` 打头），抽样 12% 逆序 |

结论：内容与分类几乎一致，**只有顺序不同**。

## 根因机制

星系 `layoutGalaxy`（`DocumentGalaxyView.tsx`）用 `distributeDirections` / `spreadInCone` **按数组下标**分配球面位置：

- `root.children[0]` 占球顶，`[1]` 次之……谁先被创建谁占顶。M2 首篇 `debt.cds.*` → 平台基础设施先建占顶；MAP 首篇 `spec.*` → 应用 Agent 先建占顶。两大瓣纬度互换。
- 每个枢纽子节点 `spreadInCone` 也按数组顺序铺扇面。顺序一变，cds 那 100 篇的扇面朝向、子模块排布全变 → 整图重排。

所以位置 = f(树 + 顺序)，而非 f(树)。这就是「同代码、同内容、不同顺序 → 不同图」。

## 修复（本 PR）

`layoutGalaxy` 在分配位置前，对每一层子节点做**确定性排序** `orderKids`（docCount 降序 + 名字稳定兜底），
使位置只由内容决定、与条目返回顺序无关。同样内容的库无论条目怎么返回，都渲染成同一张图。

## 如何自助验证（登录态浏览器控制台）

token 在 `localStorage['prd-admin-auth']`。对两个 store 各跑一次，比顶层分布 + 悬空数即可确认内容是否一致：

```js
(async (storeId) => {
  const tok = JSON.parse(localStorage.getItem('prd-admin-auth')||'{}')?.state?.token;
  const r = await fetch(`/api/document-store/stores/${storeId}/entries?page=1&pageSize=600&all=true`,
    { headers: { Authorization: `Bearer ${tok}` } });
  const items = (await r.json())?.data?.items || [];
  const DT=['spec','design','plan','rule','guide','report','debt'];
  const APP=new Set("visual-agent literary-agent defect-agent report-agent video-agent review-agent pr-review workflow-agent product-agent speech-agent shortcuts-agent front-end-agent channel-agent ccas-agent page-agent prd-agent agent-universe emergence marketplace open-platform knowledge-base web-hosting daily-tips team-activity ai-toolbox arena md-to-ppt submission-gallery executive-dashboard admin desktop infra-sandbox-agent acceptance".split(' '));
  const PLAT=new Set(['cds','platform']),CROSS=new Set(['frontend','skill','doc']),TOP=new Set(['prd','srs','project-vision']);
  const cat=a=>APP.has(a)?'应用 Agent':PLAT.has(a)?'平台基础设施':CROSS.has(a)?'跨切面保留域':TOP.has(a)?'顶层产品':'悬空';
  const parse=n=>{n=(n||'').replace(/\.(md|markdown|mdx)$/i,'');const s=n.split('.');return s.length>=2&&DT.includes(s[0].toLowerCase())?[s[0],s[1]]:null;};
  const top={};let orphan=0;
  for(const e of items){const b=(e.sourceUrl||'').split('?')[0].split('/').pop();const u=parse(b)?b:e.title;const p=parse(u);if(!p){orphan++;top['悬空']=(top['悬空']||0)+1;continue;}top[cat(p[1])]=(top[cat(p[1])]||0)+1;}
  console.log('store',storeId,'共',items.length);console.table(top);console.log('悬空:',orphan);
})('在这里粘贴 storeId');
```

## 经验教训（复盘）

1. **「同代码不同结果」第一反应查数据 / 顺序 / 环境，不是改代码。** 本轮最大的弯路就是先入为主改分类。
2. **拿真实数据，别猜。** 有 key 就用 `X-AI-Access-Key` + `X-AI-Impersonate:{用户名}` 取真实数据对比；「库是私有的抓不到」不成立——impersonate 就是为此存在（见 `api-debug` 技能）。
3. **可视化问题先确认「位置由什么决定」**：位置 = f(树) 还是 f(树 + 顺序)？后者即顺序敏感 bug → 布局前确定性排序。
4. canonical 五大类分类是**规则表**（`canonicalCategories.ts`，对齐 `rule.doc.naming` + `app-identity`），不是自定义随手编；它是星系「5 个均衡枢纽」美观的结构来源，新增 Agent 需登记该表，否则落「悬空」。

## 相关

- `.claude/rules/deterministic-rendering.md` —— 本台账升华成的强制规则
- `prd-admin/src/pages/document-store/DocumentGalaxyView.tsx` —— `layoutGalaxy` 的 `orderKids`
- `prd-admin/src/lib/docGalaxy/canonicalCategories.ts` —— 五大类分类规则表
- `doc/debt.knowledge-base.galaxy-vs-universe.md` —— 星系/宇宙图边界
