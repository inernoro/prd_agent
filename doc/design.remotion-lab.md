# Remotion 视频实验室

> 用 React 代码创建视频，用自然语言生成动画。

---

## 产品定位

**一句话描述**：在浏览器中实时预览和创作 Remotion 视频动画，支持 AI 生成。

**目标用户**：
- 开发人员：快速原型设计视频效果
- 设计师：探索动画创意，无需编写代码
- 内容创作者：生成短视频素材

**核心价值**：
1. **即时预览**：参数调整实时反映到视频
2. **AI 驱动**：用自然语言描述，自动生成动画代码
3. **学习工具**：通过示例学习 Remotion 框架

---

## 一、功能架构

### 模式划分

```
┌─────────────────────────────────────────────────────────────────┐
│                     Remotion 视频实验室                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────┐    ┌─────────────────────────────┐   │
│   │    预设模板模式      │    │       AI 生成模式           │   │
│   │   (Templates)       │    │      (AI Generator)         │   │
│   ├─────────────────────┤    ├─────────────────────────────┤   │
│   │ • 文字揭示          │    │ • 自然语言输入              │   │
│   │ • Logo 动画         │    │ • LLM 代码生成              │   │
│   │ • 粒子波浪          │    │ • 浏览器内编译              │   │
│   │ • 参数化控制        │    │ • 动态组件渲染              │   │
│   └─────────────────────┘    └─────────────────────────────┘   │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                  Remotion Player                        │   │
│   │            (实时预览 + 播放控制)                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 技术流程

```
                    预设模板模式
                    ────────────
用户选择模板 → 调节参数 → Remotion Player 渲染
                 │
                 ▼
              实时预览


                    AI 生成模式
                    ────────────
用户输入描述
     │
     ▼
┌─────────────────┐
│ LLM Gateway     │  ← System Prompt (Remotion 最佳实践)
│ runModelLabStream│
└────────┬────────┘
         │ SSE 流式响应
         ▼
┌─────────────────┐
│ 代码清理        │  ← 移除 markdown 标记
│ extractCode()   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Babel Standalone│  ← 浏览器内编译 JSX/TSX
│ transform()     │
└────────┬────────┘
         │ React 组件
         ▼
┌─────────────────┐
│ 依赖注入        │  ← React, Remotion APIs
│ new Function()  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Remotion Player │  ← 动态渲染
└─────────────────┘
```

---

## 二、预设模板

### 模板列表

| 模板名称 | 效果描述 | 可配置参数 |
|----------|----------|------------|
| **文字揭示** | 逐词弹出动画 | 文字内容、颜色、背景色、字号 |
| **Logo 动画** | 旋转光环 + 文字淡入 | Logo 文字、主色、副色、背景色 |
| **粒子波浪** | 流动的粒子效果 | 粒子颜色、背景色、粒子数量、波浪速度 |
| **Matrix 代码雨** | 黑客帝国风格代码雨 | 字符颜色、背景色、列数、速度 |
| **故障文字** | Glitch 故障风格特效 | 文字内容、文字颜色、背景色、故障强度 |
| **打字机** | 终端风格逐字打印 | 文字内容、文字颜色、背景色、打字速度 |
| **柱状图** | 动态数据图表动画 | 标题、柱子颜色、背景色、文字颜色 |

### 模板规范

每个模板需遵循以下结构：

```typescript
// 1. 配置导出
export const templateDefaults = {
  text: 'Hello World',
  color: '#ffffff',
  backgroundColor: '#0f172a',
};

// 2. Props 类型
export interface TemplateProps {
  text?: string;
  color?: string;
  backgroundColor?: string;
}

// 3. 组件导出
export function Template({
  text = templateDefaults.text,
  ...
}: TemplateProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 动画逻辑
  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {/* 内容 */}
    </AbsoluteFill>
  );
}
```

---

## 三、AI 生成模式

### 设计理念

**"描述效果，生成代码"**

用户无需了解 Remotion API，只需用自然语言描述想要的视觉效果，AI 自动生成可运行的 React 组件代码。

### System Prompt 设计

AI 生成的代码需遵循以下约束：

1. **无外部依赖**：只能使用 React + Remotion 核心 API
2. **Constants-first**：可配置参数放在文件顶部
3. **默认导出**：组件必须是 `export default function`
4. **内联样式**：不使用 CSS 文件

### 支持的 Remotion API

| API | 用途 |
|-----|------|
| `useCurrentFrame()` | 获取当前帧号 |
| `useVideoConfig()` | 获取视频配置 (fps, width, height, durationInFrames) |
| `interpolate()` | 线性插值动画 |
| `spring()` | 弹簧物理动画 |
| `Sequence` | 时序控制 |
| `AbsoluteFill` | 绝对定位容器 |

### 示例 Prompts

| 示例 | 预期效果 |
|------|----------|
| "创建一个 Matrix 风格的绿色代码雨效果" | 字符从上往下飘落 |
| "创建一个 Glitch 故障风格的文字效果" | 抖动 + 颜色偏移 |
| "创建一个呼吸灯效果的圆形光环" | 脉冲 + 颜色渐变 |
| "创建一个文字逐个字母弹跳出现的动画" | 弹簧物理效果 |
| "创建一个从中心向外爆炸的彩色粒子效果" | 粒子扩散 |
| "创建一个圆形进度条动画，从 0% 到 100%" | SVG 圆弧 + 数字 |

### 错误处理

| 错误类型 | 处理方式 |
|----------|----------|
| Babel 编译失败 | 显示错误信息，提供"重试编译"按钮 |
| 组件运行时错误 | 显示占位符，不崩溃页面 |
| LLM 超时 | 显示超时提示，允许重新生成 |
| 不支持的依赖 | 提示用户修改描述 |

---

## 四、技术实现

### 文件结构

```
prd-admin/src/pages/lab-remotion/
├── RemotionLabTab.tsx              # 主页面（模式切换）
├── components/
│   ├── AiGeneratorPanel.tsx        # AI 生成面板
│   └── CodeEditor.tsx              # Monaco 代码编辑器
├── templates/
│   ├── index.ts                    # 模板导出
│   ├── TextReveal.tsx              # 文字揭示
│   ├── LogoAnimation.tsx           # Logo 动画
│   ├── ParticleWave.tsx            # 粒子波浪
│   ├── MatrixRain.tsx              # Matrix 代码雨
│   ├── GlitchText.tsx              # 故障文字
│   ├── Typewriter.tsx              # 打字机效果
│   └── BarChart.tsx                # 柱状图动画
└── lib/
    ├── babel-standalone.d.ts       # 类型声明
    ├── dynamicCompiler.ts          # 动态编译器
    └── remotionPrompt.ts           # LLM System Prompt
```

### 依赖项

| 包名 | 版本 | 用途 |
|------|------|------|
| `remotion` | ^4.0 | 核心框架 |
| `@remotion/player` | ^4.0 | 浏览器预览播放器 |
| `@babel/standalone` | ^7.29 | 浏览器内 JSX 编译 |
| `@monaco-editor/react` | ^4.7 | 代码编辑器 |

### 视频配置

```typescript
const VIDEO_CONFIG = {
  fps: 30,              // 帧率
  durationInFrames: 90, // 总帧数 (3秒)
  width: 1280,          // 宽度
  height: 720,          // 高度
};
```

---

## 五、访问路径

| 路由 | 页面 | 权限 |
|------|------|------|
| `/lab?tab=remotion` | 视频实验室 | `lab.read` |

---

## 六、已知局限

| 局限 | 说明 | 未来可能方案 |
|------|------|--------------|
| 无外部依赖 | 不支持 Three.js、Lottie 等 | 预置常用库到作用域 |
| 仅限预览 | 不支持导出 MP4 | 后端集成 FFmpeg |
| LLM 质量不稳定 | 有时生成错误代码 | 优化 System Prompt |
| ~~无代码编辑器~~ | ~~无法手动修改生成代码~~ | ✅ 已集成 Monaco Editor |

---

## 七、待办清单

### 已完成 ✅

- [x] 集成 Remotion Player
- [x] 创建预设模板（文字揭示、Logo 动画、粒子波浪）
- [x] 实现参数化控制面板
- [x] 集成 Babel standalone 动态编译
- [x] 创建 AI 生成面板
- [x] 实现 Remotion System Prompt
- [x] 添加示例 Prompts
- [x] 错误处理和重试机制
- [x] 添加 Matrix 代码雨模板
- [x] 添加 Glitch 故障文字模板
- [x] 添加打字机效果模板
- [x] 添加柱状图动画模板
- [x] 集成 Monaco Editor 代码编辑器
- [x] 代码高亮显示
- [x] 代码复制功能
- [x] 可编辑代码并重新运行

### 当前冲刺 🚀 (v2.0 布局重构)

> 目标：重构 AI 生成模式布局，提升用户体验和代码质量

#### P0 - 布局重构

- [ ] **重构 AI 生成模式布局**
  - [ ] 左侧面板：输入区 + 示例 prompts（紧凑）
  - [ ] 右侧面板：代码/预览 Tab 切换
  - [ ] 参考 Remotion Studio 布局风格

- [ ] **代码编辑器优化**
  - [ ] 代码编辑器占据右侧完整区域
  - [ ] 预览和代码可切换显示
  - [ ] 添加"运行"按钮直接编译预览

#### P1 - AI 生成质量

- [ ] **修复 AI 生成非 Remotion 代码问题**
  - [ ] 强化 System Prompt 约束
  - [ ] 添加代码格式校验（必须包含 useCurrentFrame）
  - [ ] 生成失败时提供修复建议

- [ ] **代码校验层**
  - [ ] 编译前检查：是否为 React 函数组件
  - [ ] 运行前检查：是否使用了 Remotion API
  - [ ] 错误时自动重试或提示用户

#### P2 - 体验优化

- [ ] **流式代码显示**
  - [ ] AI 生成时实时显示代码
  - [ ] 完成后自动编译预览

- [ ] **历史记录**
  - [ ] 保存最近 10 条生成记录
  - [ ] 支持从历史恢复

---

### 未来增强 📋

- [ ] **更多模板**
  - [ ] 环形进度条
  - [ ] 倒计时器
  - [ ] 文字翻转效果
  - [ ] 图片轮播

- [ ] **导出功能** (需后端支持)
  - [ ] 导出 MP4 视频
  - [ ] 导出 GIF 动图
  - [ ] 导出代码模板

- [ ] **高级特性**
  - [ ] 时间轴编辑
  - [ ] 多场景切换
  - [ ] 音频同步
  - [ ] 自定义视频尺寸和帧率

---

## 七-B、布局设计 (v2.0)

### 目标布局

参考 Remotion Studio 和对话模式，重新设计 AI 生成模式的布局：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  [预设模板]  [AI 生成 Beta]                                              │
├─────────────────────┬───────────────────────────────────────────────────┤
│                     │  [代码]  [预览]  ← Tab 切换                        │
│  AI 动画生成         │ ─────────────────────────────────────────────────│
│  ┌─────────────────┐│                                                   │
│  │ 输入描述...      ││  ┌─────────────────────────────────────────────┐ │
│  │                 ││  │                                             │ │
│  └─────────────────┘│  │   // 代码编辑器 (Monaco)                     │ │
│                     │  │   // 或 Remotion Player 预览                 │ │
│  [✨ 生成动画]       │  │                                             │ │
│                     │  │                                             │ │
│  试试这些效果:       │  │                                             │ │
│  ┌───┐ ┌───┐ ┌───┐ │  │                                             │ │
│  │代码││故障││呼吸│ │  │                                             │ │
│  │雨 ││文字││光环│ │  └─────────────────────────────────────────────┘ │
│  └───┘ └───┘ └───┘ │                                                   │
│  ┌───┐ ┌───┐ ┌───┐ │  ┌─────────────────────────────────────────────┐ │
│  │弹跳││粒子││进度│ │  │  ◀ ▶ ● ──────────────── 30fps · 90帧 · 3s  │ │
│  │文字││爆炸││条 │ │  └─────────────────────────────────────────────┘ │
│  └───┘ └───┘ └───┘ │                                                   │
│                     │  [复制代码]  [▶ 运行]                            │
│  ⚠ 编译错误:        │                                                   │
│  Cannot read...     │                                                   │
│  [重试编译]         │                                                   │
│                     │                                                   │
└─────────────────────┴───────────────────────────────────────────────────┘
     左侧 (320px)                      右侧 (flex-1)
```

### 布局要点

| 区域 | 内容 | 说明 |
|------|------|------|
| 左上 | 输入框 + 生成按钮 | 紧凑设计，输入框可多行 |
| 左中 | 示例 prompts | 3x2 网格，点击填充输入框 |
| 左下 | 错误提示 | 编译/运行错误显示在此 |
| 右上 | Tab 切换器 | `[代码]` `[预览]` 两个 Tab |
| 右中 | 主内容区 | 代码模式：Monaco Editor<br>预览模式：Remotion Player |
| 右下 | 操作按钮 | 复制代码、运行按钮 |

### 交互流程

```
用户输入描述
     │
     ▼
点击"生成动画"
     │
     ▼
LLM 流式返回代码 ──────────┐
     │                     │
     ▼                     ▼
自动切换到"代码" Tab    实时显示生成中的代码
     │
     ▼
生成完成
     │
     ▼
自动编译 + 切换到"预览" Tab
     │
     ├── 成功 → 显示动画预览
     │
     └── 失败 → 保持"代码" Tab + 显示错误
```

### 代码校验规则

在编译前添加校验层，确保生成的是 Remotion 代码：

```typescript
function validateRemotionCode(code: string): { valid: boolean; error?: string } {
  // 1. 必须包含 remotion 导入
  if (!code.includes('from \'remotion\'') && !code.includes('from "remotion"')) {
    return { valid: false, error: '代码必须导入 remotion 模块' };
  }

  // 2. 必须包含 useCurrentFrame 或 useVideoConfig
  if (!code.includes('useCurrentFrame') && !code.includes('useVideoConfig')) {
    return { valid: false, error: '代码必须使用 useCurrentFrame 或 useVideoConfig' };
  }

  // 3. 必须是函数组件（export default function）
  if (!code.includes('export default function')) {
    return { valid: false, error: '代码必须导出默认函数组件' };
  }

  return { valid: true };
}
```

---

## 八、用户故事

### 故事 1：使用预设模板快速创建 Matrix 代码雨效果

**角色**：内容创作者小王
**场景**：需要为短视频片头制作一个黑客帝国风格的代码雨效果

#### 操作步骤

```
步骤 1: 进入视频实验室
────────────────────────
路径: 侧边栏 → 实验室 → 视频实验室 Tab

┌─────────────────────────────────────────────────────────┐
│  实验室                                                 │
├─────────┬─────────┬─────────┬─────────────────────────┤
│ 试验车间 │ 大模型  │ 桌面    │ 视频实验室 ← 点击这里    │
└─────────┴─────────┴─────────┴─────────────────────────┘
```

```
步骤 2: 选择预设模板模式
────────────────────────
确认顶部模式切换器显示"预设模板"（默认）

┌─────────────────────────────────────────────────────────┐
│  [预设模板]  [AI 生成]                                   │
│      ↑                                                   │
│    当前选中                                              │
└─────────────────────────────────────────────────────────┘
```

```
步骤 3: 选择 Matrix 代码雨模板
──────────────────────────────
在左侧模板列表中点击"Matrix 代码雨"

┌────────────────────┬────────────────────────────────────┐
│ 选择模板           │                                    │
│ ┌────────────────┐ │                                    │
│ │ 文字揭示       │ │        ┌─────────────────────┐     │
│ │ Logo 动画      │ │        │                     │     │
│ │ 粒子波浪       │ │        │   ア カ サ          │     │
│ │ ▶ Matrix 代码雨│ │        │     ナ   マ         │     │
│ │ 故障文字       │ │        │   ワ   ヤ   ハ      │     │
│ │ 打字机         │ │        │                     │     │
│ │ 柱状图         │ │        │   [Remotion Player] │     │
│ └────────────────┘ │        └─────────────────────┘     │
│                    │                                    │
│ 参数配置           │                                    │
│ ┌────────────────┐ │                                    │
│ │ 字符颜色: #00ff00│ │                                  │
│ │ 背景色: #000000 │ │                                   │
│ │ 列数: 30        │ │                                   │
│ │ 速度: 1.5       │ │                                   │
│ └────────────────┘ │                                    │
└────────────────────┴────────────────────────────────────┘
```

```
步骤 4: 调整参数
────────────────
修改参数值，右侧预览实时更新

参数调整示例：
  字符颜色: #00ff00 → #00ffff (改为青色)
  列数: 30 → 50 (更密集)
  速度: 1.5 → 2.0 (更快)

预览自动刷新，无需点击任何按钮
```

```
步骤 5: 播放预览
────────────────
点击 Player 底部的播放按钮观看完整动画

┌─────────────────────────────────────────┐
│                                         │
│         [动画内容区域]                   │
│                                         │
├─────────────────────────────────────────┤
│  ▶ ──────●────────── 00:01 / 00:03     │
│     播放进度条                          │
└─────────────────────────────────────────┘
```

#### 预期结果

- 看到日文片假名字符从屏幕顶部向下飘落
- 字符呈现指定的颜色（默认绿色）
- 动画循环播放 3 秒

---

### 故事 2：使用 AI 生成模式创建自定义动画

**角色**：设计师小李
**场景**：想要一个独特的呼吸灯效果，但不想写代码

#### 操作步骤

```
步骤 1: 切换到 AI 生成模式
─────────────────────────
点击顶部的"AI 生成"按钮

┌─────────────────────────────────────────────────────────┐
│  [预设模板]  [AI 生成] ← 点击切换                        │
└─────────────────────────────────────────────────────────┘
```

```
步骤 2: 选择示例或输入描述
─────────────────────────
方式 A: 点击示例卡片快速开始
方式 B: 在输入框中输入自定义描述

┌─────────────────────────────────────────────────────────┐
│ 示例:                                                   │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│ │ Matrix 代码雨 │ │ Glitch 故障 │ │ 呼吸灯效果   │     │
│ └──────────────┘ └──────────────┘ └──────────────┘     │
│                                                         │
│ 或输入自定义描述:                                        │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 创建一个霓虹灯风格的文字闪烁效果，文字是"NEON"      │ │
│ └─────────────────────────────────────────────────────┘ │
│                                      [生成动画]         │
└─────────────────────────────────────────────────────────┘
```

```
步骤 3: 等待 AI 生成
────────────────────
点击"生成动画"后，等待 LLM 流式返回代码

┌─────────────────────────────────────────────────────────┐
│ 生成中...                                               │
│                                                         │
│ export default function NeonText() {                    │
│   const frame = useCurrentFrame();                      │
│   const opacity = Math.sin(frame * 0.1) * 0.5 + 0.5;   │
│   ...                                                   │
│   █ ← 光标闪烁，代码逐行出现                            │
└─────────────────────────────────────────────────────────┘
```

```
步骤 4: 查看预览
────────────────
代码生成完成后，自动编译并在右侧显示预览

┌────────────────────────────┬────────────────────────────┐
│ 代码编辑器 (Monaco)        │ 预览                       │
│ ┌────────────────────────┐ │ ┌────────────────────────┐ │
│ │ // 可编辑代码          │ │ │                        │ │
│ │ export default function│ │ │      ✨ NEON ✨        │ │
│ │   ...                  │ │ │                        │ │
│ │ }                      │ │ │   [Remotion Player]   │ │
│ │                        │ │ │                        │ │
│ │ [复制] [运行]          │ │ └────────────────────────┘ │
│ └────────────────────────┘ │                            │
└────────────────────────────┴────────────────────────────┘
```

```
步骤 5: 手动调整代码（可选）
──────────────────────────
在 Monaco 编辑器中修改代码，点击"运行"按钮查看效果

修改示例：
  // 原代码
  const textColor = '#ff00ff';

  // 修改为
  const textColor = '#00ffff';  // 改为青色

点击 ▶ 运行按钮，预览实时更新
```

```
步骤 6: 复制代码
────────────────
点击"复制"按钮将代码复制到剪贴板，用于其他项目

┌────────────────────────────┐
│ ✓ 已复制到剪贴板           │
└────────────────────────────┘
```

#### 预期结果

- AI 生成可运行的 Remotion 代码
- 预览区展示生成的动画效果
- 可以手动修改代码并重新运行
- 可以复制代码用于其他项目

---

### 故事 3：处理 AI 生成错误

**角色**：开发者小张
**场景**：AI 生成的代码有语法错误

#### 操作步骤

```
步骤 1: AI 生成代码出错
──────────────────────
LLM 返回了有语法错误的代码

┌─────────────────────────────────────────────────────────┐
│ ❌ 编译错误                                             │
│                                                         │
│ SyntaxError: Unexpected token (line 15)                │
│                                                         │
│ [重试编译]                                              │
└─────────────────────────────────────────────────────────┘
```

```
步骤 2: 尝试重试编译
───────────────────
点击"重试编译"按钮，系统重新编译代码

如果仍然失败，可以：
  方式 A: 点击"重新生成"让 AI 重新生成
  方式 B: 在编辑器中手动修复错误后点击"运行"
```

```
步骤 3: 手动修复错误
───────────────────
在 Monaco 编辑器中定位并修复错误

┌────────────────────────────────────────┐
│ 15 |   return <div style={{           │ ← 错误行高亮
│ 16 |     background: 'red'            │
│ 17 |   }}>                            │ ← 少了逗号
│                                        │
│ 修复: 添加逗号                         │
│ 16 |     background: 'red',           │
└────────────────────────────────────────┘

点击 ▶ 运行，查看修复结果
```

#### 预期结果

- 错误信息清晰可见
- 可以重试或手动修复
- 修复后动画正常显示

---

## 九、应用迁移指南

> 当实验室功能验证成熟后，如何将其提升为独立应用。

### 迁移时机判断

| 信号 | 说明 |
|------|------|
| 用户反馈正向 | 实验功能得到用户认可，有实际使用需求 |
| 功能稳定 | 核心功能稳定运行，无重大 Bug |
| 需要独立权限 | 需要单独的访问控制或计费 |
| 需要数据持久化 | 需要保存用户作品、历史记录等 |
| 需要专属配置 | 需要独立的水印、限额、模型配置等 |

### 迁移架构对比

```
实验室阶段（当前）                      独立应用阶段（迁移后）
─────────────────                      ─────────────────────

prd-admin/                              prd-admin/
└── pages/                              ├── pages/
    └── lab-remotion/  ← 实验室子目录       │   └── video-agent/  ← 独立页面目录
        ├── RemotionLabTab.tsx              │       ├── index.tsx
        ├── templates/                      │       ├── WorkspacePage.tsx
        ├── components/                     │       ├── templates/
        └── lib/                            │       ├── components/
                                            │       └── lib/
无后端                                  prd-api/
                                        └── src/
                                            ├── PrdAgent.Api/
                                            │   └── Controllers/
                                            │       └── VideoAgentController.cs
                                            └── PrdAgent.Infrastructure/
                                                └── Services/
                                                    └── VideoGenService.cs

无数据库                                MongoDB 集合
                                        ├── video_agent_workspaces
                                        ├── video_agent_projects
                                        └── video_agent_renders
```

### 迁移步骤清单

#### 阶段 1：注册应用身份

```csharp
// 1. 在 CLAUDE.md 中注册 appKey
| 视频创作 Agent | `video-agent` | Remotion 视频创作工作区 |

// 2. 创建 Controller（硬编码 appKey）
[ApiController]
[Route("api/video-agent")]
public class VideoAgentController : ControllerBase
{
    private const string AppKey = "video-agent";  // 硬编码，不由前端传递

    [HttpPost("projects")]
    public async Task<IActionResult> CreateProject(...)
    {
        // 使用 AppKey 调用服务
    }
}
```

#### 阶段 2：设计数据模型

```csharp
// 项目模型
public class VideoProject
{
    public ObjectId Id { get; set; }
    public string UserId { get; set; }
    public string Name { get; set; }
    public string TemplateKey { get; set; }      // 使用的模板
    public JsonDocument Parameters { get; set; } // 模板参数
    public string? CustomCode { get; set; }      // AI 生成的代码
    public VideoConfig Config { get; set; }      // 视频配置
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

// 渲染任务模型
public class VideoRenderJob
{
    public ObjectId Id { get; set; }
    public ObjectId ProjectId { get; set; }
    public string Status { get; set; }  // pending, rendering, completed, failed
    public string? OutputUrl { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime CreatedAt { get; set; }
}
```

#### 阶段 3：迁移前端代码

```
# 1. 创建独立页面目录
mkdir -p prd-admin/src/pages/video-agent

# 2. 复制并重构代码
cp -r prd-admin/src/pages/lab-remotion/* prd-admin/src/pages/video-agent/

# 3. 重命名入口文件
mv video-agent/RemotionLabTab.tsx video-agent/index.tsx

# 4. 更新路由
# router.tsx 中添加:
{ path: '/video-agent', element: <VideoAgentPage /> }
```

#### 阶段 4：添加数据持久化

```typescript
// services/videoAgentService.ts
export const videoAgentService = {
  // 项目管理
  createProject: (data: CreateProjectRequest) =>
    api.post('/api/video-agent/projects', data),

  getProjects: () =>
    api.get('/api/video-agent/projects'),

  updateProject: (id: string, data: UpdateProjectRequest) =>
    api.put(`/api/video-agent/projects/${id}`, data),

  // 渲染管理
  requestRender: (projectId: string, format: 'mp4' | 'gif') =>
    api.post(`/api/video-agent/projects/${projectId}/render`, { format }),

  getRenderStatus: (jobId: string) =>
    api.get(`/api/video-agent/render-jobs/${jobId}`),
};
```

#### 阶段 5：配置权限与水印

```csharp
// 1. 添加权限目录
public static class AdminPermissionCatalog
{
    // 视频代理权限
    public const string VideoAgentRead = "video-agent.read";
    public const string VideoAgentWrite = "video-agent.write";
    public const string VideoAgentRender = "video-agent.render";
}

// 2. 配置水印（如需要）
// 在 watermark_configs 集合中添加 appKey = "video-agent" 的配置
```

#### 阶段 6：注册到 LLM Gateway

```csharp
// AppCallerCode 命名
"video-agent.ai-gen::generation"  // AI 生成动画代码

// 在 llm_app_callers 集合中注册
{
  "appCallerCode": "video-agent.ai-gen::generation",
  "displayName": "视频代理 - AI 生成",
  "modelType": "chat",
  "modelGroupIds": ["default-chat-pool"]
}
```

### 迁移检查清单

| 检查项 | 说明 | 状态 |
|--------|------|------|
| appKey 注册 | CLAUDE.md 中添加应用标识 | ☐ |
| Controller 创建 | 硬编码 appKey 的 API 入口 | ☐ |
| 数据模型定义 | MongoDB 集合与 C# 模型 | ☐ |
| 前端页面迁移 | 独立路由与页面组件 | ☐ |
| 权限配置 | AdminPermissionCatalog 注册 | ☐ |
| LLM Gateway | AppCallerCode 注册 | ☐ |
| 水印配置 | 按需配置 appKey 绑定 | ☐ |
| 侧边栏入口 | 添加独立导航项 | ☐ |
| 文档更新 | 更新 Codebase Skill 段落 | ☐ |

### 参考实现

| 应用 | 参考文件 | 说明 |
|------|----------|------|
| **VisualAgent** | `VisualAgentController.cs` | 图片生成的 Controller 模式 |
| **LiteraryAgent** | `LiteraryAgentController.cs` | 文学创作的 SSE 流式模式 |
| **DefectAgent** | `DefectAgentController.cs` | 缺陷管理的完整 CRUD |

---

## 十、Remotion 集成方法论

> 将视频创作视为软件开发：Remotion 将视频制作从传统的时间线操作，转变为代码驱动的软件工程过程。

### 三大成功集成模式

#### 模式一：独立的视频生成服务 (Video-as-a-Service)

**架构思想**：将 Remotion 封装成独立微服务，通过 API 对外提供视频渲染能力。

```
┌──────────────┐     API 请求     ┌──────────────────┐
│   主应用      │ ──────────────▶ │  Remotion 渲染服务 │
│ (任何技术栈)  │                  │    (Node.js)      │
└──────────────┘                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  AWS Lambda /     │
                                  │  @remotion/lambda │
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  S3 / GCS 存储    │
                                  └──────────────────┘
```

**适用场景**：
- 大规模个性化视频（如 GitHub Unwrapped 年度报告）
- 数据驱动的视频（天气、股票、统计数据自动转视频）
- 自动化内容生成（会议演讲预告、新闻摘要）

**技术选型**：
- 渲染环境：`@remotion/lambda` (AWS Lambda) - 极致扩展性
- API：RESTful 或 GraphQL 接收渲染任务
- 存储：S3、GCS 等云存储

---

#### 模式二：现有产品的功能扩展 (Feature Extension)

**架构思想**：在现有 React 应用中集成 Remotion，作为增值功能。

```
┌─────────────────────────────────────────────────────────────────┐
│                      React Web 应用                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────┐     ┌─────────────────────────────┐   │
│  │  @remotion/player   │     │  现有业务组件                │   │
│  │  (前端预览)         │     │                             │   │
│  └──────────┬──────────┘     └─────────────────────────────┘   │
│             │                                                    │
│             │ 渲染请求                                           │
│             ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  后端渲染服务 (@remotion/renderer 或 委托给 Lambda)      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**适用场景**：
- 内容格式转换（设计、文章、数据报告导出为视频）
- 交互式视频预览（WYSIWYG 视频编辑体验）

**最佳实践**：
- **分离代码**：Remotion 相关代码放在独立目录（如 `src/remotion`）
- **版本固定**：所有 `remotion` 和 `@remotion/*` 包版本号完全一致，去掉 `^` 符号

---

#### 模式三：AI 驱动的 SaaS 平台 (AI-Powered SaaS) ⭐ 当前采用

**架构思想**：用户通过自然语言描述想要的视频，AI 生成 Remotion 代码。

```
┌─────────────────────────────────────────────────────────────────┐
│                      用户界面                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  "创建一个霓虹灯风格的文字闪烁效果"                        │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    LLM Gateway                           │   │
│  │              (GPT-4 / Claude / DeepSeek)                 │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │ 生成代码                          │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 Babel + Dynamic Compiler                 │   │
│  │                   (浏览器内编译)                          │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               @remotion/player 实时预览                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**适用场景**：
- 文本到视频 (Text-to-Video)
- AI 增强编辑（自动字幕、转场、音效）
- 虚拟形象视频

**成功案例**：
- Submagic - AI 短视频编辑
- Revid.ai - 文本到视频
- HeyGen - AI 虚拟形象

---

### 四步实战方法论

#### 第一步：规划与原型 (Plan & Prototype)

| 任务 | 说明 |
|------|------|
| 故事板 | 用静态图片或草图规划每个关键场景 |
| 识别动态数据 | 区分静态/动态元素，定义清晰的 props 接口 |
| 创建沙盒项目 | 使用 `npx create-video@latest` 快速原型测试 |

#### 第二步：组件化开发 (Componentize)

| 层级 | 说明 |
|------|------|
| 原子组件 | 单个标题、图表、Logo 等独立 React 组件 |
| 场景组件 | 多个原子组件组合成一个 Sequence |
| 根组件 | Root.tsx 注册所有 Composition，定义默认 props |

```typescript
// 原子组件示例
function Title({ text, color }: { text: string; color: string }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1]);
  return <h1 style={{ opacity, color }}>{text}</h1>;
}

// 场景组件示例
function IntroScene() {
  return (
    <AbsoluteFill>
      <Title text="Welcome" color="#00ffff" />
      <Particles count={50} />
    </AbsoluteFill>
  );
}
```

#### 第三步：渲染与优化 (Render & Optimize)

| 策略 | 适用场景 | 命令/包 |
|------|----------|---------|
| 本地渲染 | 快速测试，少量视频 | `npx remotion render` |
| 服务器端渲染 | 自动化批量生成 | `@remotion/renderer` |
| 无服务器渲染 | 大规模高并发 | `@remotion/lambda` |

**性能优化要点**：
- 使用 `useMemo` 缓存昂贵计算
- 正确处理媒体文件加载/卸载
- Lambda 配置合适的内存大小

#### 第四步：部署与集成 (Deploy & Integrate)

| 任务 | 说明 |
|------|------|
| API 设计 | 任务提交、进度查询、结果回调 |
| 错误处理 | 健壮的错误处理和重试逻辑 |
| 安全 | API 身份验证，输入数据校验 |
| 监控 | 渲染时间、成功率、成本、资源使用 |

---

## 十一、相关资源

- [Remotion 官方文档](https://www.remotion.dev/docs/)
- [Remotion Player API](https://www.remotion.dev/docs/player)
- [Remotion Templates](https://www.remotion.dev/templates/)
- [Prompt to Motion Graphics](https://github.com/remotion-dev/template-prompt-to-motion-graphics)
- [Remotion Lambda](https://www.remotion.dev/docs/lambda)

---

## 十二、变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-02-02 | v1.0 | 初始版本：预设模板 + AI 生成模式 |
| 2026-02-02 | v1.1 | 新增 4 个模板 (Matrix/Glitch/Typewriter/BarChart) + Monaco Editor 代码编辑器 |
| 2026-02-02 | v1.2 | 添加用户故事章节（预设模板流程、AI 生成流程、错误处理流程） |
| 2026-02-02 | v1.3 | 添加应用迁移指南（从实验室提升为独立应用的完整流程） |
| 2026-02-03 | v1.4 | 新增科技片头模板，优化 System Prompt，移除底部信息卡 |
| 2026-02-03 | v1.5 | 添加 Remotion 集成方法论（三大模式 + 四步实战方法论） |
