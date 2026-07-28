# 角色手册

> `/sdd-init` 用本文件生成自检报告里的「缺什么」和「下一步做什么」两段。
> 每个角色给三样：该装的技能、装完第一句该说什么、典型工作流。

下载缺失技能的通用命令（`<BASE>` 换成分发平台域名，`<KEY>` 换成技能名）：

```bash
curl -sSLo /tmp/<KEY>.zip "<BASE>/api/official-skills/<KEY>/download" \
  && unzip -o /tmp/<KEY>.zip -d ~/.claude/skills/
```

---

## 产品经理（pm）

### 该装的技能

| 技能 | 触发词 | 什么时候用 |
|---|---|---|
| `sdd-init` | `/sdd-init` | 项目初始化，装工作方法骨架 |
| `skill-validation` | `/validate` | 需求提出时先验一遍质量和价值 |
| `plan-first` | `/plan-first` | 要动手之前先出方案 |
| `product-document-generator` | 「写产品文档」 | 把想法写成结构化 PRD |
| `doc-writer` | `/doc` | 套七类文档模板 |
| `risk-matrix` | `/risk` | 方案评审时评六维度风险 |
| `flow-trace` | `/trace` | 想搞清一个功能到底怎么跑的（大白话版） |
| `acceptance-checklist` | `/uat` | 生成逐步打勾的验收清单 |
| `task-handoff-checklist` | `/handoff` | 交接给开发/测试前对齐 |
| `laowang` | `/laowang` | 卡住了、理不清头绪时拆解 |

### 装完第一句说什么

推荐按这个顺序开局，每一步都是一句话：

1. `/sdd-init` —— 先把骨架装上（如果还没跑过）
2. 「我想做一个 <一句话需求>，帮我 `/validate` 一下」—— 先验需求质量，别急着写文档
3. 验过了再说「按这个需求 `/doc` 起一份 spec」

**不要**一上来就让 AI 写完整 PRD。需求没验过就写文档，写出来的是精美的错误。

### 典型工作流

```
想法  →  /validate 验需求  →  /doc 起 spec  →  /risk 评风险  →  交给开发
                                                              ↓
                            /handoff 交接  ←  /uat 验收清单  ←  开发完成
```

### 常见误区

- **把「文档写完」当成「需求想清楚」**：文档是想清楚的副产品，不是替代品
- **验收清单等到最后才写**：写 spec 的时候就该知道怎么算做到了，`/uat` 应该在开发开始前就能生成
- **只说要什么，不说不要什么**：spec 里的「非目标」一节比「目标」更能防止范围蔓延

---

## 开发（dev）

### 该装的技能

| 技能 | 触发词 | 什么时候用 |
|---|---|---|
| `sdd-init` | `/sdd-init` | 项目初始化 |
| `plan-first` | `/plan-first` | 多文件改动前先出方案 |
| `human-verify` | `/verify` | 自己改完从四个角度反查 |
| `code-hygiene` | `/hygiene` | 迁移/重构后清死代码和兼容垫片 |
| `conflict-resolution` | `/resolve` | 提 PR 前预合并主分支解冲突 |
| `risk-matrix` | `/risk` | 评估改动的影响面 |
| `task-handoff-checklist` | `/handoff` | 交接 |
| `create-skill-file` | `/create-skill` | 把重复的工作流沉淀成技能 |

### 装完第一句说什么

1. `/sdd-init`
2. 「读一下这个项目，告诉我架构是怎么组织的」—— 让 AI 先建立上下文
3. 开始干活；改完之前先 `/verify`

### 典型工作流

```
接需求  →  /plan-first 出方案  →  实现  →  /verify 自查  →  /resolve 预合并  →  提交
```

---

## 测试 / 验收（qa）

### 该装的技能

| 技能 | 触发词 | 什么时候用 |
|---|---|---|
| `sdd-init` | `/sdd-init` | 项目初始化 |
| `acceptance-test-design` | `/验收设计` | 从行为断言出发设计测试场景 |
| `acceptance-scenario-orchestrator` | `/验收场景` | 复杂验收目标的范围和证据链编排 |
| `acceptance-checklist` | `/uat` | 生成真人逐步打勾的清单 |
| `create-visual-test-to-kb` | `/验收` | 浏览器取证 + 验收报告归档 |
| `human-verify` | `/verify` | 多视角挑刺 |
| `risk-matrix` | `/risk` | 按风险排测试优先级 |

### 装完第一句说什么

1. `/sdd-init`
2. 「这次要验的是 <PR / 功能 / 改动范围>，先 `/验收设计` 一下」
3. 设计出来了再 `/uat` 生成能打勾的清单

### 常见误区

- **断头验收**：流程走了一半、产物还没出来就截图收工。等到产物真的出现才算验完
- **拿接口 200 当验收通过**：必须打开真实界面看结果
- **只测新数据**：旧数据的兼容路径同样要走一遍

---

## 通用：角色没识别出来时

如果探测不到明确角色，按下面兜底：

1. 只装 `sdd-init` + `plan-first` + `doc-writer` 三个的，按「通用」处理
2. 报告里的「下一步」给三条最保险的：
   - `/sdd-init` 装骨架
   - 「帮我读一下这个项目并总结它在做什么」建立上下文
   - 「我接下来要做 X，先 `/plan-first`」
