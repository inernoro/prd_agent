---
type: debt
appname: knowledge-base
module: galaxy-layout
status: active
updated: 2026-06-28
---

# 文档星系布局「不均匀 / 头重脚轻」根因台账

## 一句话结论

**星系布局是「树形结构」的确定性函数，而树形结构完全由文档数据（title / sourceUrl / parentId）决定。
所以「同一份代码、不同知识库，一个均匀一个头重脚轻」是正常现象——根因在数据，不在代码。**

排查这类问题必须**先隔离数据与代码**，再动代码。本台账记录 2026-06-28 一次绕了多轮才意识到是数据的过程，供后人避坑。

## 现象

- 同一分支（galaxy-original-baseline，代码完全一致）下：
  - 旧库 M2（storeId `3b025…`，339 篇）→ 布局**均匀**
  - 重新订阅的 MAP（storeId `bd18b…`）→ 布局**头重脚轻**
- 用户最初描述为「最近更新导致星系不均匀 / 像大蘑菇 / 节点很丑」。

## 真根因（数据驱动）

1. 布局位置来自对树的 Fibonacci 球面分布（`DocumentGalaxyView` 的 `distributeDirections` + `radiusForDepth`），
   **纯由树结构决定**，无随机、无时间因子。
2. 树由 `buildDocGalaxy` 从 entries 构建：点分名(title/sourceUrl) → 分类→appname→子模块；
   非点分则走 parentId 文件夹；都不命中落「未分类」。
3. 因此**数据不同 → 树不同 → 布局不同**。两个 store 是**两条独立数据**（不同 id、不同订阅来源、
   一个 public 一个 private），doc 集合与字段填充并不一致。

### 实测（M2 / `3b025…`，公开库，用 buildDocGalaxy 真跑）

| 维度 | 值 |
|---|---|
| 总数 | 339，其中 338 篇 title 本身就是点分文件名（如 `debt.cds.selfupdate-prebuilt.md`） |
| parentId / 文件夹 | 0 / 0 |
| 顶层分类分布 | 平台基础设施 143、应用 Agent 139、跨切面保留域 32、周报 19、未分类 3、顶层产品 3 |
| 悬空 | 1–3 |
| 最大 appname 枢纽 | cds 99 |

两大主瓣（平台基础设施 143 ≈ 应用 Agent 139）基本对称 → 视觉「均匀」。
若另一库的文档集中到单一枢纽或大量落「未分类」，就会「头重脚轻」。

## 如何验证（自助，登录态浏览器控制台）

token 存在 `localStorage['prd-admin-auth']` 的 zustand persist JSON 里。粘贴以下片段，
对两个 store 各跑一次，比较顶层枢纽分布与悬空数即可定位是否数据差异：

```js
(async (storeId) => {
  const tok = JSON.parse(localStorage.getItem('prd-admin-auth')||'{}')?.state?.token;
  const r = await fetch(`/api/document-store/stores/${storeId}/entries?page=1&pageSize=500&all=true`,
    { headers: { Authorization: `Bearer ${tok}` } });
  const items = (await r.json())?.data?.items || [];
  const DT=['spec','design','plan','rule','guide','report','debt'];
  const APP=new Set("visual-agent literary-agent defect-agent report-agent video-agent review-agent pr-review workflow-agent product-agent speech-agent shortcuts-agent front-end-agent channel-agent ccas-agent page-agent prd-agent agent-universe emergence marketplace open-platform knowledge-base web-hosting daily-tips team-activity ai-toolbox arena md-to-ppt submission-gallery executive-dashboard admin desktop infra-sandbox-agent acceptance".split(' '));
  const PLAT=new Set(['cds','platform']), CROSS=new Set(['frontend','skill','doc']), TOP=new Set(['prd','srs','project-vision']);
  const cat=a=>APP.has(a)?'应用 Agent':PLAT.has(a)?'平台基础设施':CROSS.has(a)?'跨切面保留域':TOP.has(a)?'顶层产品':'未分类';
  const parse=n=>{n=(n||'').replace(/\.(md|markdown|mdx)$/i,'');const s=n.split('.');return s.length>=2&&DT.includes(s[0].toLowerCase())?[s[0],s[1]]:null;};
  const top={},miss={srcMissing:0,nonDotted:0}; let orphan=0;
  for(const e of items){const base=(e.sourceUrl||'').split('?')[0].split('/').pop();const use=parse(base)?base:e.title;
    if(!e.sourceUrl)miss.srcMissing++; const p=parse(use); if(!p){miss.nonDotted++; orphan++; top['未分类']=(top['未分类']||0)+1; continue;}
    const c=cat(p[1]); top[c]=(top[c]||0)+1;}
  console.log('store',storeId,'共',items.length);
  console.table(top); console.log('悬空(未分类):',orphan,' 无sourceUrl:',miss.srcMissing,' 非点分名:',miss.nonDotted);
})('在这里粘贴 storeId');
```

判读：若两库「顶层分布」「悬空数」「无 sourceUrl 数」明显不同，即坐实数据差异；若几乎相同还差很多，才回头查代码/渲染。

## 经验教训（这轮绕路的复盘）

1. **「同代码不同结果」第一反应查数据/环境，不是改代码。** 本轮先入为主认为是算法回归，改了
   分类逻辑（标题分层 → 主导方式 → appname 优先）多轮，用户看到「居然没变化」——因为根因在数据。
2. **可复现优先**：没有用受控数据复现就动代码，等于盲修。应先固定一份数据，确认代码行为，再谈改不改。
3. **布局类问题先确认「位置由什么决定」**：星系位置 = f(树) = f(数据)，确定性无随机，所以同数据必同图。
4. **标签 ≠ 分类**：视觉「糊成一片」很大程度是标签默认从文件名翻成正文标题（5733c516）+ 长标题重叠，
   与分类树是两码事；leaf.name 一度误用 entry.title（已修为取文件名 nameForHierarchy）。
5. **canonical 分类伞是设计债**：`canonicalCategories.ts` 把 appname 硬编码映射成「应用 Agent / 平台基础设施…」
   四大类，文件名里并不存在这层；是否保留需产品决策（appname 优先则去掉，见对照分支）。
6. **散点(蘑菇)的代码诱因**：`f763107b` 标题分隔符分层把非点分描述式标题按 `·` 拆成单点 → 满天散点；
   对点分为主的库（如 MAP）应关闭（已加全库主导方式检测）。

## 相关

- `prd-admin/src/lib/docGalaxy/buildDocGalaxy.ts` —— 树构建 SSOT（纯函数，可单测）
- `prd-admin/src/pages/document-store/DocumentGalaxyView.tsx` —— 3D 布局（位置由树决定）
- `doc/debt.knowledge-base.galaxy-vs-universe.md` —— 星系/宇宙图边界
- 对照分支：`galaxy-appname-first`（appname 优先）/ `galaxy-original-baseline`（752cb6c4 原始）/ `galaxy-before-titlesplit`（标题分层前）
