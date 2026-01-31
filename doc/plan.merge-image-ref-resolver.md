# 合并计划书：三入口守门员统一

> **状态**: 草案
> **创建日期**: 2026-01-29
> **关联文档**: design.inline-image-chat.md

---

## 一、当前问题分析

### 1.1 三个输入入口现状

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           当前代码路径                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  入口1: RichComposer           入口2: Quick 输入          入口3: 首页带入    │
│  ┌─────────────────┐          ┌─────────────────┐       ┌─────────────────┐ │
│  │ onSendRich()    │          │ onSendQuick()   │       │ useEffect()     │ │
│  │ getStructured() │          │                 │       │ parseInline()   │ │
│  └────────┬────────┘          └────────┬────────┘       └────────┬────────┘ │
│           │                            │                         │          │
│           ↓                            ↓                         │          │
│  ┌─────────────────────────────────────────────┐                 │          │
│  │              sendText()                     │                 │          │
│  │  → buildRequestTextWithRefs() (旧逻辑)      │                 │          │
│  │  → 正则提取 @imgN                           │                 │          │
│  └─────────────────────────────────────────────┘                 │          │
│           │                                                      │          │
│           ↓                                                      ↓          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        runFromText()                                   │  │
│  │                        (最终执行)                                      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ⚠️ 问题：首页带入直接调用 runFromText，绕过了 sendText 和解析逻辑            │
│  ⚠️ 问题：imageRefs 被获取但未使用，又用正则重新提取                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 关键代码位置

| 入口 | 文件:行号 | 当前处理方式 | 问题 |
|------|-----------|--------------|------|
| RichComposer | `AdvancedVisualAgentTab.tsx:3277` | `onSendRich` → `sendText` | imageRefs 被忽略 |
| Quick 输入 | `AdvancedVisualAgentTab.tsx:3340` | `onSendQuick` → `sendText` | 正确经过 sendText |
| 首页带入 | `AdvancedVisualAgentTab.tsx:3118-3144` | 直接 `runFromText` | 绕过了守门员 |

### 1.3 现有新解析器状态

| 文件 | 状态 | 说明 |
|------|------|------|
| `imageRefContract.ts` | ✅ 完成 | 类型定义契约 |
| `imageRefResolver.ts` | ✅ 完成 | 统一解析器 |
| `WorkshopLabTab.tsx` | ✅ 完成 | 试验车间测试 |
| `onSendRich` 并行对比 | ✅ 完成 | 仅 console.log，未切换 |

---

## 二、目标架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           目标代码路径                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  入口1: RichComposer           入口2: Quick 输入          入口3: 首页带入    │
│  ┌─────────────────┐          ┌─────────────────┐       ┌─────────────────┐ │
│  │ onSendRich()    │          │ onSendQuick()   │       │ useEffect()     │ │
│  │ getStructured() │          │                 │       │ parseInline()   │ │
│  │ → chipRefs ─────┼──────────┼─────────────────┼───────┼→ inlineImage    │ │
│  └────────┬────────┘          └────────┬────────┘       └────────┬────────┘ │
│           │                            │                         │          │
│           └────────────────────────────┼─────────────────────────┘          │
│                                        ↓                                    │
│            ┌───────────────────────────────────────────────┐                │
│            │         resolveImageRefs() (新统一守门员)       │                │
│            │                                               │                │
│            │  输入:                                        │                │
│            │  • rawText: 原始文本                          │                │
│            │  • chipRefs: RichComposer 返回的引用          │                │
│            │  • selectedKeys: 左侧选中的图片               │                │
│            │  • inlineImage: 首页带入的图片                │                │
│            │  • canvas: 当前画布所有图片                   │                │
│            │                                               │                │
│            │  输出:                                        │                │
│            │  • ok: 是否通过验证                           │                │
│            │  • cleanText: 清理后的文本                    │                │
│            │  • refs: 解析出的图片引用列表                 │                │
│            │  • warnings/errors: 提示信息                  │                │
│            └───────────────────────────────────────────────┘                │
│                                        ↓                                    │
│            ┌───────────────────────────────────────────────┐                │
│            │              sendTextUnified()                 │                │
│            │              (新统一发送函数)                   │                │
│            └───────────────────────────────────────────────┘                │
│                                        ↓                                    │
│            ┌───────────────────────────────────────────────┐                │
│            │              runFromText()                     │                │
│            │              (最终执行，不变)                   │                │
│            └───────────────────────────────────────────────┘                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、实施步骤

### Step A: 试验车间完整验证 (当前阶段)

**目标**: 在隔离环境中验证新解析器所有场景

| 测试场景 | 试验车间验证 | 状态 |
|----------|--------------|------|
| 单个 chip 引用 | 插入 → 获取 → 验证 refs | ✅ 已有测试 |
| 多个 chip 引用 | 插入多个 → 验证顺序 | ✅ 已有测试 |
| 两阶段选择 | pending → confirm → 验证 | ✅ 已有测试 |
| @imgN 文本引用 | 输入 @img1 → 验证解析 | ⏳ 需补充 |
| chip + @imgN 混合 | 两种来源 → 验证去重 | ⏳ 需补充 |
| selectedKeys 补充 | 无引用时 → 用选中图 | ⏳ 需补充 |
| 旧格式 [IMAGE=...] | 兼容解析 → 清理标记 | ⏳ 需补充 |

**交付物**:
- [ ] WorkshopLabTab.tsx 新增上述测试用例
- [ ] 所有测试用例通过

### Step B: AdvancedVisualAgentTab 切换

**目标**: 将三个入口切换到新解析器

**B.1 修改 sendText 函数**

```typescript
// 当前 (旧)
const sendText = async (rawText: string) => {
  // ...
  const { requestText, primaryRef } = buildRequestTextWithRefs(cleanDisplay);
  // ...
};

// 目标 (新)
const sendText = async (rawText: string, opts?: {
  chipRefs?: ChipRef[];
  inlineImage?: { src: string; name?: string };
}) => {
  // ...
  const result = resolveImageRefs({
    rawText: cleanDisplay,
    chipRefs: opts?.chipRefs ?? [],
    selectedKeys,
    inlineImage: opts?.inlineImage,
    canvas: contractCanvas,
  });

  if (!result.ok) {
    // 显示错误提示
    return;
  }

  const { requestText, primaryRef } = buildRequestText(
    result.cleanText,
    result.refs
  );
  // ...
};
```

**B.2 修改 onSendRich**

```typescript
// 当前
const onSendRich = async () => {
  const { text, imageRefs } = composer.getStructuredContent();
  // imageRefs 被获取但未使用
  await sendText(text);
};

// 目标
const onSendRich = async () => {
  const { text, imageRefs } = composer.getStructuredContent();
  await sendText(text, { chipRefs: imageRefs }); // 传递 chipRefs
};
```

**B.3 修改首页带入逻辑**

```typescript
// 当前
useEffect(() => {
  if (!initialPrompt?.text) return;
  // 直接调用 runFromText
  void runFromText(initialPrompt.text, initialPrompt.text, inlineRef, ...);
}, [...]);

// 目标
useEffect(() => {
  if (!initialPrompt?.text) return;
  // 经过统一守门员
  await sendText(initialPrompt.text, {
    inlineImage: initialPrompt.inlineImage,
  });
}, [...]);
```

**交付物**:
- [ ] sendText 函数签名更新
- [ ] onSendRich 传递 chipRefs
- [ ] onSendQuick 保持不变（无 chipRefs）
- [ ] 首页带入经过 sendText

### Step C: 清理旧代码

**目标**: 删除废弃的旧逻辑

| 待删除代码 | 位置 | 替代方案 |
|------------|------|----------|
| `buildRequestTextWithRefs` | AdvancedVisualAgentTab.tsx:3182 | `resolveImageRefs` + `buildRequestText` |
| `extractReferencedImagesInOrder` | AdvancedVisualAgentTab.tsx:3159 | `imageRefResolver.ts` 内部实现 |
| Step 3 对比日志 | AdvancedVisualAgentTab.tsx:3289-3330 | 删除 |

**交付物**:
- [ ] 删除旧函数
- [ ] 删除对比日志
- [ ] 通过回归测试

---

## 四、风险与回滚

### 4.1 风险点

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 新解析器遗漏边界情况 | 某些场景发送失败 | Step A 完整测试覆盖 |
| 首页带入逻辑改动 | 从其他页面跳转失败 | 保留旧逻辑注释，快速回滚 |
| refs 顺序不一致 | AI 理解偏差 | 并行对比已验证 |

### 4.2 回滚方案

每个 Step 独立提交，可单独 revert：
- Step A: 仅新增测试，删除即可
- Step B: `git revert <commit>` 恢复旧函数
- Step C: `git revert <commit>` 恢复旧代码

---

## 五、验收标准

### 5.1 功能验收

| 场景 | 预期 | 验收人 |
|------|------|--------|
| RichComposer 输入 @img1 发送 | refs 包含对应图片 | 用户 |
| 点击图片 → 点击输入框 → 发送 | refs 包含该图片 | 用户 |
| Quick 输入发送 | 正常工作 | 用户 |
| 从首页带图进入 | 正确解析并生成 | 用户 |
| 选中多图但不引用 | selectedKeys 作为补充 | 用户 |

### 5.2 控制台验收

- [ ] 无 resolveImageRefs 相关错误
- [ ] 无 "引用不存在" 的误报警告
- [ ] Step 3 对比日志已删除

---

## 六、时间估算

| 步骤 | 预估工作量 |
|------|-----------|
| Step A: 试验车间补充测试 | 中 |
| Step B: 切换三入口 | 中 |
| Step C: 清理旧代码 | 小 |
| 用户验收测试 | - |

---

## 附录：代码位置速查

```
prd-admin/src/
├── lib/
│   ├── imageRefContract.ts      # 类型契约 ✅
│   └── imageRefResolver.ts      # 统一解析器 ✅
├── components/RichComposer/
│   ├── index.tsx                # getStructuredContent 返回 imageRefs ✅
│   └── ImageChipNode.tsx        # chip 节点 (ready/pending 状态) ✅
├── pages/
│   ├── lab-workshop/
│   │   └── WorkshopLabTab.tsx   # 试验车间 ✅
│   └── ai-chat/
│       └── AdvancedVisualAgentTab.tsx  # 三入口所在 ⏳
└── ...
```
