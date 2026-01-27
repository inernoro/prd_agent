# 内联图片聊天分析功能改进设计

> **文档状态**: 进行中
> **创建日期**: 2026-01-27
> **最后更新**: 2026-01-27
> **负责人**: AI Assistant + 用户协作

---

## 一、背景与目标

### 1.1 用户需求

用户观察到竞品图片编辑平台具有以下高级功能：

1. **点击识别 (Click-to-Segment)**: 使用 Cmd+鼠标点击可识别图片中被点击的对象
2. **内联图片嵌入**: 在聊天输入框中，图片/div 可以嵌入到文字中间，像文字的一部分

### 1.2 当前痛点

| 痛点 | 描述 |
|------|------|
| 参考图位置固定 | 参考图是独立 `<p>` 标签，在输入框上方，无法与文字交织 |
| 关联性不明确 | 用户分不清图片和文字的先后顺序、引用关系 |
| imageRefs 被浪费 | `getStructuredContent()` 返回的 imageRefs 没有被使用，改用正则重新提取 |
| 三链路割裂 | 左侧添加、右下角输入、首页带入三个入口各自处理，体验不统一 |

### 1.3 改进目标

1. **统一三个输入链路的数据模型**
2. **正确使用 RichComposer 提供的 imageRefs**
3. **提供实时验证，防止引用失效的图片**
4. **不破坏现有的溢出保护和 UI 优化**

---

## 二、现状分析

### 2.1 三个输入链路

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         当前架构                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   链路1: 左侧画布              链路2: 右下角输入           链路3: 首页带入  │
│   ┌──────────────┐            ┌──────────────┐           ┌──────────────┐│
│   │ onUploadImages│           │ RichComposer │           │ initialPrompt││
│   │ setCanvas()   │           │ @img chip    │           │ [IMAGE=...]  ││
│   │ selectedKeys  │           │ imageRefs    │           │ parseInline  ││
│   └──────┬───────┘            └──────┬───────┘           └──────┬───────┘│
│          │                           │                          │        │
│          └───────────────────────────┼──────────────────────────┘        │
│                                      ↓                                   │
│                        ┌─────────────────────────┐                       │
│                        │  buildRequestTextWithRefs │                      │
│                        │  (用正则重新解析)          │                      │
│                        └─────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键代码位置

| 文件 | 行号 | 用途 |
|------|------|------|
| `prd-admin/src/components/RichComposer/index.tsx` | 全文 252 行 | 富文本编辑器主体 |
| `prd-admin/src/components/RichComposer/ImageChipNode.tsx` | 全文 238 行 | 图片 chip 节点 |
| `prd-admin/src/components/RichComposer/ImageMentionPlugin.tsx` | 全文 340 行 | @img 下拉菜单 |
| `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx` | 3190-3206 | onSendRich 函数 |
| `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx` | 3074-3125 | buildRequestTextWithRefs |
| `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx` | 3030-3057 | initialPrompt 处理 |
| `prd-admin/src/lib/visualAgentPromptUtils.ts` | 全文 200 行 | parseInlinePrompt 等 |

### 2.3 当前问题代码

```typescript
// AdvancedVisualAgentTab.tsx:3194
// ❌ 只取了 text，完全忽略了 imageRefs
const { text } = composer.getStructuredContent();

// 然后在 buildRequestTextWithRefs 中用正则重新提取
const refsByText = extractReferencedImagesInOrder(rawText);
// ↑ 这是在重复工作！ImageChipNode 已经有完整的元数据
```

### 2.4 已有的溢出保护（不可破坏）

```
ImageChipNode 的保护措施:
┌─────────────────────────────────────────────────────────────────┐
│  chip 结构:                                                     │
│  ┌──────┬──────┬───────────────┐                                │
│  │序号  │ 缩略图│ 标签          │                                │
│  │14px  │ 14px │ max 80px      │                                │
│  │固定  │ 固定 │ JS截断+ellipsis│                                │
│  └──────┴──────┴───────────────┘                                │
│                                                                 │
│  保护1: displayLabel = label.slice(0, 6) + '...'  (JS 截断)     │
│  保护2: maxWidth: 80, textOverflow: ellipsis      (CSS 截断)    │
│  保护3: flexShrink: 0                             (不被压缩)    │
│  保护4: 容器 overflowY: 'auto', maxHeight: 120    (滚动)        │
└─────────────────────────────────────────────────────────────────┘
```

**重要约定**: 任何修改都不得破坏上述保护措施。

---

## 三、改进计划

### 3.1 核心思想：契约优先 + 单一数据源

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         目标架构                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   链路1        链路2        链路3                                        │
│     │            │            │                                         │
│     └────────────┼────────────┘                                         │
│                  ↓                                                      │
│   ┌──────────────────────────────────────┐                              │
│   │  ImageRefResolver (统一门卫)          │  ← 单一入口                  │
│   │                                      │                              │
│   │  职责:                               │                              │
│   │  1. 验证 refId 是否在 canvas 范围内  │                              │
│   │  2. 合并多来源的引用（去重、排序）    │                              │
│   │  3. 处理旧格式兼容                   │                              │
│   │  4. 返回标准化的结果                 │                              │
│   └──────────────────────────────────────┘                              │
│                  ↓                                                      │
│   ┌──────────────────────────────────────┐                              │
│   │  sendText() / runFromText()          │                              │
│   └──────────────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 新增文件清单

| 文件 | 用途 | 状态 |
|------|------|------|
| `prd-admin/src/lib/imageRefContract.ts` | 类型定义（契约） | 待创建 |
| `prd-admin/src/lib/imageRefResolver.ts` | 统一解析器 | 待创建 |
| `prd-admin/src/lib/imageRefResolver.test.ts` | 单元测试 | 待创建 |
| `prd-admin/src/pages/_dev/RichComposerLab.tsx` | 试验场页面 | 待创建 |

---

## 四、实施步骤与进度

### Step 1: 创建试验场（不碰现有代码）
- **状态**: ⏳ 待开始
- **风险**: 零
- **回滚**: 删除文件
- **内容**:
  - 创建 `/_dev/rich-composer-lab` 页面
  - 独立运行 RichComposer
  - 模拟各种边界情况
  - 实时显示 `getStructuredContent()` 输出

### Step 2: 创建契约和解析器（不碰 UI）
- **状态**: ⏳ 待开始
- **风险**: 零
- **回滚**: 删除文件
- **内容**:
  - 新增 `imageRefContract.ts`
  - 新增 `imageRefResolver.ts`
  - 新增测试文件

### Step 3: 并行运行新旧逻辑
- **状态**: ⏳ 待开始
- **风险**: 零
- **回滚**: 删除代码
- **内容**:
  - 在 `onSendRich` 中并行调用 `resolveImageRefs`
  - 仅 `console.log` 对比结果，不实际切换
  - 收集对比数据

### Step 4: 确认结果一致后切换
- **状态**: ⏳ 待开始
- **风险**: 低
- **回滚**: 恢复旧代码
- **内容**:
  - 切换到新解析器
  - 保留旧代码注释

### Step 5: 添加 UI 实时验证
- **状态**: ⏳ 待开始
- **风险**: 低
- **回滚**: 删除组件
- **内容**:
  - 失效 chip 红色边框提示
  - 发送前警告

### Step 6: 清理旧代码
- **状态**: ⏳ 待开始
- **风险**: 中
- **回滚**: git revert
- **内容**:
  - 删除 `buildRequestTextWithRefs`
  - 删除 `extractReferencedImagesInOrder`

---

## 五、难点与风险

### 5.1 已识别的难点

| 难点 | 描述 | 应对策略 |
|------|------|----------|
| chip 超出输入框宽度 | 图片标签+名称长度可能超出容器 | **已有保护**，不做改动 |
| 旧 [IMAGE] 格式兼容 | 首页带入可能使用旧格式 | 在 resolver 中统一处理 |
| 三链路体验统一 | 左侧/右下/首页三入口各自处理 | 强制所有入口经过统一 resolver |
| refId 悬空引用 | 用户删除图片后 chip 仍引用 | 实时验证 + UI 警告 |

### 5.2 绝对不能做的事

1. **不得修改 ImageChipNode 的现有样式**（溢出保护）
2. **不得删除 JS 层面的标签截断逻辑**（`displayLabel = label.slice(0, 6) + '...'`）
3. **不得在未验证的情况下直接切换逻辑**
4. **不得破坏现有的三个链路功能**

### 5.3 风险缓解

- **试验场隔离**: 所有新功能先在 `/_dev/` 页面验证
- **并行对比**: 新旧逻辑同时运行，console.log 对比
- **渐进切换**: 每一步都可独立回滚
- **测试覆盖**: 必须通过所有边界测试

---

## 六、验收标准

### 6.1 功能验收

| 测试用例 | 预期结果 | 状态 |
|----------|----------|------|
| 链路1: 选中单张图片发送 | refs 包含该图片 | ⏳ |
| 链路1: 选中多张图片发送 | refs 按 selectedKeys 顺序 | ⏳ |
| 链路2: 输入 @img1 发送 | refs 包含 refId=1 的图片 | ⏳ |
| 链路2: 输入多个 @img 发送 | refs 按文本中出现顺序 | ⏳ |
| 链路3: 从首页带 [IMAGE=...] 进来 | 正确解析并清理旧格式 | ⏳ |
| 边界: chip 引用已删除的图片 | 产生警告，refs 中不包含 | ⏳ |
| 边界: 空白消息 | 返回 ok=false，errors 包含提示 | ⏳ |
| 边界: 重复引用 | 自动去重 | ⏳ |

### 6.2 UI 验收

| 测试用例 | 预期结果 | 状态 |
|----------|----------|------|
| 超长标签 (50 个字) | 正常截断，不溢出 | ⏳ |
| 多个 chip 连续 | 自动换行，不超出容器 | ⏳ |
| chip + 长文字混合 | 排版正常 | ⏳ |
| 窄容器 (200px) | 不破坏布局 | ⏳ |
| 引用不存在的 @img99 | 显示警告样式 | ⏳ |

### 6.3 兼容性验收

| 测试用例 | 预期结果 | 状态 |
|----------|----------|------|
| 旧格式 `[IMAGE=url\|name]` | 正确解析 | ⏳ |
| 新格式 `[IMAGE src=... name=...]` | 正确解析 | ⏳ |
| 现有功能不受影响 | 所有现有流程正常 | ⏳ |

---

## 七、约定与规则

### 7.1 代码约定

```typescript
// 1. 所有图片引用必须经过 ImageRefResolver
// ✅ 正确
const result = resolveImageRefs({ rawText, chipRefs, selectedKeys, canvas });
if (result.ok) await send(result);

// ❌ 错误：绕过 resolver
const refs = extractReferencedImagesInOrder(text);
```

```typescript
// 2. 优先级顺序
// chipRefs > 文本中的 @imgN > selectedKeys > inlineImage
```

```typescript
// 3. 类型定义必须使用契约文件
import type { ResolvedImageRef, ImageRefResolveResult } from '@/lib/imageRefContract';
```

### 7.2 测试约定

- 每个新功能必须有对应的单元测试
- 边界情况必须覆盖
- 测试文件命名: `*.test.ts`

### 7.3 文档约定

- 任何改动必须更新本文档的进度
- 新增文件必须在"新增文件清单"中登记
- 验收标准完成后标记 ✅

---

## 八、技术选型

### 8.1 已确认使用

| 技术 | 用途 | 理由 |
|------|------|------|
| Lexical | 富文本编辑器 | 已在使用 |
| DecoratorNode | ImageChipNode | 已实现 |
| 原生 ResizeObserver | 容器尺寸监听 | 项目中已有使用 |
| 纯 CSS max-width | chip 宽度限制 | 已有，不做改动 |

### 8.2 暂不实现（未来考虑）

| 功能 | 理由 |
|------|------|
| Click-to-Segment (SAM) | 需要 GPU 服务，工作量大，优先级 P3 |
| 拖拽图片到输入框 | 当前优先解决数据流问题 |
| 多图权重控制 | 超出当前范围 |

---

## 九、参考资料

### 9.1 竞品分析

| 功能 | Midjourney | Leonardo | 我们当前 | 改进后 |
|------|------------|----------|----------|--------|
| 内联图片引用 | ✅ | ✅ | ⚠️ @img chip | ✅ 完善数据流 |
| 多图混合 | ✅ | ✅ | ⚠️ 支持但体验差 | ✅ 清晰顺序 |
| 区域选择 | ✅ | ✅ | ❌ | ❌ (未来) |

### 9.2 相关文档

- `agent.literary-agent.md` - 文学创作 Agent 设计
- `rule.app-feature-definition.md` - 应用功能定义规范
- `2.srs.md` - 系统需求规格说明书

---

## 十、变更记录

| 日期 | 变更内容 | 作者 |
|------|----------|------|
| 2026-01-27 | 创建文档 | AI Assistant |

---

## 附录：契约类型定义（预览）

```typescript
// imageRefContract.ts

/**
 * 统一的图片引用描述
 */
export interface ResolvedImageRef {
  canvasKey: string;
  refId: number;
  src: string;
  label: string;
  source: 'chip' | 'selected' | 'inline' | 'text';
}

/**
 * 解析结果
 */
export interface ImageRefResolveResult {
  ok: boolean;
  cleanText: string;
  refs: ResolvedImageRef[];
  warnings: string[];
  errors: string[];
}

/**
 * 统一入口的输入参数
 */
export interface ImageRefResolveInput {
  rawText: string;
  chipRefs?: Array<{ canvasKey: string; refId: number }>;
  selectedKeys?: string[];
  inlineImage?: { src: string; name?: string };
  canvas: CanvasImageItem[];
}
```
