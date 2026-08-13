---
name: acceptance-debt-loop
version: 1.0.0
description: Runs the acceptance-debt loop for a feature - inventory every claim that has no red-able predicate, write or update the debt ledger (doc/debt.{appname}.{topic}.md), pick the highest-value unverified item, turn it into a mechanical assertion, prove it can go red, then update the ledger and repeat. Activates when the user says 验收债务, 持续优化, 循环完成, 把没法验收的记下来, 这块到底验没验过, 补判据, or asks whether a delivered feature is actually proven. Also the right skill when a smoke suite passes but you suspect an assertion is passing for the wrong reason. Does NOT run visual acceptance archiving - that belongs to create-visual-test-to-kb; does NOT deploy - that belongs to cds-deploy-pipeline.
---

# 验收债务循环

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/验收债务`、「持续优化」、「循环完成」、「这块到底验没验过」

**一句话**：把「我说做了」和「有判据证明做了」分开记账，然后每轮挑一条把它变成能变红的判据。
**什么时候用**：交付一个功能之后；或者冒烟全绿但你怀疑某条断言其实恒成立。

---

## 为什么需要它

「已验证」与「我认为它是对的」中间隔着一条能变红的判据。两者混进同一条交付消息，
下一个人就会在一个从没被证明过的结论上继续盖楼——包括写这句话的我自己。

本技能不产出功能，只产出**判据**与**账**。它的成功标准只有一个：
台账里「未守」的条数单调下降，且没有一条是靠放宽判据降下去的。

---

## 循环（每轮五步，不许跳步）

### 第 1 步：盘点声明

把本次交付消息、commit message、PR 描述里所有**事实性声明**列出来，逐条问：
**如果这件事是坏的，现在有什么会变红？**

- 有 → 记下判据名（哪个测试、哪条冒烟断言）
- 没有 → 它就是一条验收债务

只盘点事实性声明（「部件被裁成最小矩形」），不盘点意图（「体验更好了」）。

### 第 2 步：判据分档

三档，没有第四档：

| 档位 | 含义 |
|---|---|
| 已守 | 有能变红的自动判据，且做过红绿闭环 |
| 弱守 | 有判据但证明力不足：样本恒成立、只测形状没测行为、跳过时不报原因 |
| 未守 | 没有任何自动判据，只靠人工观察或逻辑推导 |

**弱守最危险**，它长得和已守一模一样。三个典型：
- 挑了一个「无论功能对错都会通过」的样本（覆盖率 100% 的层去验裁剪）
- 断言了源码里某段字面量存在，而不是行为发生
- 前置条件不满足就整套跳过，还是绿的

### 第 3 步：落账

写进 `doc/debt.{appname}.{topic}.md`，六列固定：

`# | 项 | 判据状态 | 为什么证不了 | 要什么才证得了 | 当前兜底`

「为什么证不了」必须是具体障碍（缺第二个上游、上游参数必填、时序无法稳定复现），
不许写「暂时没做」。「当前兜底」写清楚在没有判据的情况下用什么降低风险。

命名遵守 `doc/rule.doc.naming.md`；写完同步 `doc/index.yml` 与 `doc/guide.list.directory.md`。

### 第 4 步：挑一条，把它变成判据

按这个顺序挑，不要按「哪条好做」挑：

1. **弱守**优先于未守——假证据比没证据更糟，它会让人以为已经验过了
2. 用户已经踩过一次的
3. 改动频繁、容易回归的
4. 一次投入能守住一大片的

然后想办法把它机械化。常用手法：
- 行为断言取代形状断言（断言产物尺寸，而不是断言源码里有 `crop`）
- 挑**最能暴露问题**的样本（覆盖率最低那层，而不是随便一层）
- 用比值/面积而不是单边尺寸，更难蒙混
- 证不了整体就证零件：把不可复现的时序抽成纯函数，直接打输入输出

### 第 5 步：红绿闭环 + 回写

把修复临时撤掉 → 确认判据变红 → 恢复 → 确认变绿。
**用例不变红就是它没在测你以为它在测的东西**，回第 4 步重写。

然后把台账那一行改成「已守」并写明判据名。**不要删行**——删了就看不出它曾经欠过。

---

## 停止条件

不是「台账清空」，而是下面任一：

- 剩下的都是「要什么才证得了」明确指向**外部输入**（缺上游、缺样本集、缺账号），
  此时按 `.claude/rules/blocked-state-circuit-breaker.md` 发**一条**升级，不要空转
- 剩下的判据成本明显高于它防的风险，在台账里写明这个判断并标注「刻意不补」

两种情况都要在交付消息里如实说，不许把「没补」说成「不需要」。

---

## 交付消息里怎么写

每次收尾必须能回答这三句：

```
自测走的是哪条路径：<冒烟 / 单测 / 真实端点>
断言了什么：<具体判据，带实测数值>
没法验收的：<台账链接 + 本轮欠账条数变化，如 未守 5 → 4>
```

禁止只写「已完成」「已验证」而不给判据名。

---

## 自查清单

- [ ] 本次交付的每条事实性声明都盘过「坏了什么会变红」？
- [ ] 有没有恒成立的样本混进判据里？（挑的样本能暴露问题吗）
- [ ] 台账更新了？新增的「说了但没判据」都落行了？
- [ ] 本轮至少把一条从未守/弱守推到已守，并做了红绿闭环？
- [ ] 交付消息写清了「自测走哪条 / 断言了什么 / 还欠什么」？

---

## 相关

- `.claude/rules/predicate-and-wiring-discipline.md` —— 判据的八种坏形状，第 2 步分档直接用它
- `.claude/rules/closed-loop-acceptance.md` —— 断头验收的判定
- `.claude/rules/real-visual-acceptance.md` —— 用户可见功能的真视觉验收
- `CLAUDE.md §8.1` —— 自测优先，跑不通就明说
- 首个实例：`doc/debt.visual-agent.layering.md`、`scripts/smoke/visual-layering.mjs`
