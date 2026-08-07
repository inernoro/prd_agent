# 上游能力不等于用户可选模型（Capability is not a Model）

**一句话**：用户在选择器里挑的是「意图」，模型是实现细节；需要特定输入、不吃提示词、没有尺寸概念的能力属于动作，只能被具体按钮点名调用，绝不许摆进「选择模型」列表。
**什么时候撞上**：把一个新上游能力接进网关，并让它出现在任何面向用户的模型/引擎选择器里。

---

## 判定口诀

**这一项，用户选了它之后能像别的模型一样直接用吗？** 不能 → 它是动作，不是模型。

三条具体判据，命中任一即为「动作能力」：

1. **需要特定输入才成立**（必须先有一张图 / 一段音频 / 一个文件），不像生图模型那样给个提示词就能跑；
2. **不消费选择器旁边的那些参数**（提示词、尺寸、比例、张数对它毫无意义）；
3. **产物形态不同类**（出的是一组图层 / 一段转写 / 一份蒙版，而不是选择器承诺的那类产物）。

---

## 硬规则

### 1. 目录必须带能力标签，消费方按意图取

模型目录只说「是什么模型」是不够的，必须同时说「能拿来干什么」。缺了这一层，前端只能
「后端返回什么就摆什么」，任何新接进来的能力都会自动漏进选择器。

- 网关的逻辑模型带 `Capabilities`，应用面 DTO **必须原样透出**，不许在映射时丢掉。
- 判定收敛成**一个函数**：后端 `GatewayCapabilityIds.IsOperationOnly(publicId, capabilities)`，
  前端 `isOperationOnlyPool(pool)`。禁止在 Controller / 组件里各写一遍。
- 判据要**同时认 PublicId 与 Capabilities 两个信号**：不同数据来源填的字段不一样
  （Capabilities 是 snake_case 的 `image_layering`，PublicId 是 kebab-case 的 `image-layering`），
  只认一个，换条路进来就漏。

### 2. 过滤放在一处，所有端点都得过

同一个「能选什么」的问题不许有第二个答案。四个 models 端点全部经过同一个
`ToSelectableModels`，新增端点也必须走它。

**反面模式：给每个场景加一个手工端点。** 本仓库真实踩过——
`models/text2img` 的注释写着「避免合并列表里的 img2img/vision-only 池被选中后让每帧都失败」。
那是在给「目录混着不能选的条目」这个病打补丁，补丁越多越漏。正解是目录本身带够信息，
按意图取。

### 3. 动作能力只允许被按钮点名调用

分层、去背景、放大这类能力的正确入口是**选中对象后的快捷操作栏**（先有对象，再对它做事），
不是「先选一个模型再说」。调用时按稳定的能力标识点名（`image-layering`），
不经过用户的模型选择。

### 4. 用户不该被迫做实现层决策

同一能力有多个上游时，由网关按健康度 / 优先级路由，不要把选择权推给创作页的用户。
确实需要指定时，入口放模型管理后台，不放创作页。

---

## 提交前自查

- [ ] 我新接的能力会出现在哪些用户可见的选择器里？逐个确认过吗？
- [ ] 它满足「给个提示词就能跑」吗？不满足 → 它不该在模型列表里。
- [ ] 目录的能力标签透传到应用面了吗（没在 DTO 映射时被丢掉）？
- [ ] 判定函数只有一份吗？还是我又在 Controller 里写了一遍？
- [ ] 判据同时认 PublicId 与 Capabilities 两种信号吗？
- [ ] 有守卫测试吗？（这条判据写错了照样编译、照样跑、不报错，只有用户打开下拉才发现）

---

## 历史背景

2026-08-07，用户在视觉创作打开模型选择器，看到「图片分层」和 Image 2 / Nano Banana
并排列着，问「居然有一个专有的分层模型，我不知道这样设计的意图在哪里」。

根因链条：分层被 `FalImageLayeringProvisioning` 发布成 `ModelType = "generation"` 的逻辑模型 →
`GetAvailablePoolsAsync` 把所有 generation 池返回给视觉创作 → 前端
`filteredPools = imageGenPools` 零过滤 → 它就成了一个可选「模型」。选中之后底部 chip 变成
「图片分层」，旁边挂着对它毫无意义的 `1K · 1:1`，而它其实需要一张输入图、不吃提示词。

同一个病在此之前已经以另一种形态出现过一次（`models/text2img` 补丁端点），
只是当时按单点问题处理了，没有上升成规则。本规则由此固化。

参考做法：Lovart 的三层交互（Talk 说想要什么 / Tab 点画布选上下文 / Tune 用图层、蒙版、
去背景这类动作动手）里，用户从头到尾**不选模型**——路由是系统的事。

---

## 与其他规则的关系

- `predicate-and-wiring-discipline.md`：本规则是形状 1（判据太窄）与形状 3（判据分裂漂移）
  在「模型目录」上的专门形态；守卫测试的写法照那条。
- `enum-ripple-audit.md`：新增能力标签属于常量注册表扩展，按六层涟漪审。
- `chief-designer-usability.md` 第二原则：剃掉不需要人类做的决策——「用哪个上游」正是其一。
- `no-rootless-tree.md`：能力声明必须有根（运行时可验证的 Capabilities），不是硬编码清单。
- 落地位置：`prd-api/src/PrdAgent.Core/Models/GatewayCapabilityIds.cs`、
  `prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs` 的 `ToSelectableModels`、
  `prd-admin/src/pages/ai-chat/visualAgentModelOptions.ts` 的 `isOperationOnlyPool`；
  守卫 `OperationOnlyCapabilityTests.cs` + `visualAgentModelOptions.test.ts`。
