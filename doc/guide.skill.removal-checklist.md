# 删技能前置检查清单 · 指南

> **版本**：v1.0 | **日期**：2026-05-30 | **状态**：已落地

> 在本仓库删除 / 重命名 / 合并一个 `.claude/skills/<name>` 之前，**先跑完这张清单**。删技能不是 `rm -rf` + 改 CLAUDE.md 表两步——它的引用面横跨前端代码、后端生成包、CI 脚本、文档矩阵。本清单由 PR #690 的真实教训固化：一次删 7 个技能，被自动评审连揪 **4 轮 6 条 P2**，每轮都翻出一处没探到的引用。

---

## 一、为什么需要这张清单（PR #690 血泪）

2026-05-30 一次「砍冗余技能」操作，初始只做了 `rm 目录 + 删 CLAUDE.md 技能表行`，自测时仅 `grep doc/ .claude/`。结果连续 4 轮被评审打回：

| 轮 | 漏掉的引用面 |
|----|------------|
| 1 | 删的 2 个技能其实是「职责分离」的载荷技能（auto-fix-issues 被 cds/cds-deploy/issues-autofix 路由；issues-visual-create 是 issues-visual-run 的开单端）→ 被迫还原 |
| 2 | `prd-api` 的 `official-skills.generated.json` 仍含该技能，经 marketplace API 对外可装；删的 html/pdf 是 CI 冒烟脚本 `require_file` 的证据文件 |
| 3 | `doc/guide.skill-catalog.md`、`guide.platform.agent-onboarding.md`、`guide.skill.workflow.md` 仍把它当可用技能；`prd-admin/src/lib/skillGlyphRegistry.ts`（前端）有图标条目 |
| 4 | `scripts/bundle-official-skills.mjs` 的 INCLUDE 白名单仍列该技能；`createzzdemo/SKILL.md` 散文级 fallback 「走 bridge 技能」 |

**根因**：删技能的爆炸半径远超直觉，且单 `grep doc/ .claude/` 探不到 `scripts/ prd-api/ prd-admin/src/`。

---

## 二、删技能前必查的引用面（逐项打勾）

删除技能 `<name>`（触发词 `<trigger>`）前，逐个核对：

### A. 这个技能真的该删吗（先于一切）

- [ ] 它是不是被其它技能当**独立协议/职责分离端**引用？grep `<name>` + `<trigger>` 于 `.claude/skills/*/SKILL.md`，看是否有「语义不同别混」「上游/下游是它」这类话——若有，它不是冗余，**别删**
- [ ] 它的能力是否真被另一技能**完整覆盖**？（如 cn-brief-summary ⊂ dev-completion-report Part 1），还是只是「看起来像」？

### B. 注册表 / 索引（SSOT）

- [ ] `CLAUDE.md` 质量保障技能链表格：删行
- [ ] `doc/guide.skill-catalog.md`：删技能总览行（注意重编号）+ 补「已删除/裁剪」说明
- [ ] `doc/guide.skill-workflow.md`：删触发词速查行
- [ ] `doc/guide.agent-onboarding.md`：删/改新手引导里的技能行与示例（改指替代技能）

### C. 后端官方技能包（marketplace 对外）

- [ ] `scripts/bundle-official-skills.mjs` 的 `INCLUDE` 白名单 + `DISPLAY_NAME` 映射：删 key（否则列表脏，且若目录被恢复会重新进包）
- [ ] 重跑 `node scripts/bundle-official-skills.mjs` 重生成 `prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json`
- [ ] 确认 bundle 条目数 -1，被删 key 不在其中（`OfficialSkillsController.Download` 会服务任何 catalog 命中的 key）

### D. 前端代码

- [ ] `prd-admin/src/lib/skillGlyphRegistry.ts`：删该技能的图标条目
- [ ] grep `prd-admin/src` 是否还有别处按 skill key 硬编码（注册表/映射）
- [ ] 改了前端后跑 `pnpm tsc --noEmit`（本地无 node_modules 则靠 CI「Admin Dashboard Build」兜底）

### E. CI / 脚本

- [ ] grep `scripts/` 是否有 `require_file` / 直接路径引用该技能产出的证据文件（html/pdf/json）——删证据文件会让冒烟脚本 FAIL
- [ ] grep `scripts/` 是否有把该技能名写进 include/allowlist 的生成器

### F. 文档矩阵 + 散文 fallback

- [ ] `doc/index.yml` + `doc/guide.list.directory.md`：若技能有独立 doc，删条目（技能本身不在此二者，但相关 design/guide 可能引用）
- [ ] grep 全仓散文级「走 X 技能」「用 X 技能」类 fallback（最易漏，如 `createzzdemo` 引用 `bridge`）
- [ ] 功能 vs 技能辨析：如 `bridge` 技能已删但 **Bridge 功能/HTTP API/规则** 仍在——只清「作为技能」的引用，保留功能引用

---

## 三、一条命令做穷尽扫描

删完后，跑这条确认无残留（把 `<name>`/`<trigger>` 换成实际值）：

```bash
grep -rInE "skills/<name>|<name>|<trigger>|<name> 技能|走 <name>" . \
  --exclude-dir=.git --exclude-dir=node_modules \
  | grep -vE "CHANGELOG\.md|doc/report\.|<本次 changelog 碎片>|已下线|已删除|曾合并"
```

把命中逐条判定为：① 作为技能的悬空引用（必须改）② 同名功能/API/代码（保留）③ 历史记录（保留）。**只有把三类都判完才算扫干净。**

---

## 四、还存在的工程债（本清单未消除，仅记录）

- **耦合本身没降**：技能 key 散落在前端注册表、后端生成包、CI 脚本、多份文档里，没有单一 SSOT 让「删一个技能」自动级联。理想态是技能元数据集中一处、下游全部派生（类似 `navigation-registry.md` 对路由做的）。在此之前，删技能必须手工跑本清单。
- **官方包生成器是半手工白名单**：`bundle-official-skills.mjs` 的 INCLUDE 是手维护 set，与 `.claude/skills/` 实际目录不自动对账。可补一个 CI 校验：INCLUDE 里每个 key 必须存在对应目录。

---

## 相关

- `.claude/rules/navigation-registry.md` — SSOT 级联的正面范例（路由登记 + CI 守卫）
- `.claude/rules/enum-ripple-audit.md` — 同类「改一处要全栈涟漪审计」方法论
- PR #690 — 本清单的来源事件
