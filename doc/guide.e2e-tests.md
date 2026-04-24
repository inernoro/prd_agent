# Playwright E2E · 指南

> Phase 6 交付物 —— 金字塔顶层的浏览器 E2E 测试,补齐"单测过 + 冒烟过,但 UI 依然坏"这类缺陷的拦截层。

---

## 作用

前面的金字塔层各管一段：

| 层 | 工具 | 捕获的问题 |
|----|------|-----------|
| L1 单测 | vitest / xUnit | 纯函数逻辑错 |
| L2 集成 | supertest / routes-level | Controller 契约 |
| L3 冒烟 (Phase 2-4) | `scripts/smoke-*.sh` | HTTP API 链路 |
| **L4 浏览器 E2E (这里)** | **Playwright** | **CSS 回归 / JS 崩 / 交互断** |
| L5 真人 UAT | `/uat` 清单 | 主观体验 |

Phase 6 focus: 把 Phase 1 反面案例(白天「+ 新建项目」按钮褪色、分支列表塌成单列、toggle 错位)写成自动化回归,让下次回归秒被 CI 发现。

---

## 目录结构

```
e2e/
├── package.json          # playwright 依赖 + 脚本
├── playwright.config.ts  # 配置(baseURL / 超时 / reporter / browsers)
├── tsconfig.json
├── utils/
│   └── auth.ts           # 登录 fixture
└── specs/
    ├── smoke-ui.spec.ts     # 3 条最轻量的 UI 冒烟(无需登录)
    └── cds-dashboard.spec.ts # 4 条 CDS 回归保护(对应 2026-04-19 样式修复)
```

---

## 快速上手

### 1. 首次安装

```bash
cd e2e
pnpm install
pnpm install-browsers   # = playwright install --with-deps chromium
```

浏览器下载 ~150MB,本地装一次就好。Cache 存在 `~/.cache/ms-playwright/`。

### 2. 本地跑一组

```bash
cd e2e
# 针对 CDS 预览域名
E2E_BASE_URL=https://my-branch.miduo.org pnpm test

# headed (看着跑)
E2E_BASE_URL=https://my-branch.miduo.org pnpm test:headed

# UI 模式 (最佳调试体验)
E2E_BASE_URL=https://my-branch.miduo.org pnpm test:ui
```

### 3. 只跑单个 spec

```bash
E2E_BASE_URL=https://xxx.miduo.org pnpm test specs/smoke-ui.spec.ts
```

### 4. 只跑单个 test

```bash
E2E_BASE_URL=https://xxx.miduo.org pnpm test -g "登录页渲染成功"
```

### 5. 失败复盘

失败时自动生成 HTML 报告 + 截图 + trace:

```bash
pnpm exec playwright show-report
```

CI 失败会把 `playwright-report/` 上传到 workflow artifacts,下载解压用同样命令打开。

---

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `E2E_BASE_URL` | `http://localhost:5500` | 目标根 URL |
| `E2E_USER` | _(未设)_ | 登录用户名,auth-gated spec 用;未设时跳过 |
| `E2E_PASSWORD` | _(未设)_ | 登录密码,同上 |
| `CI` | _(GitHub Actions 自动设置)_ | 非空时启用 forbidOnly + retries=1 |

---

## CI 集成

已配置 `.github/workflows/ci.yml` 新增 `e2e-preview` job,仅在 `workflow_dispatch` 手动触发时跑。

入参:
- `e2e_base_url`: 目标 URL (例 `https://my-branch.miduo.org`)

Secrets (repo Settings → Secrets and variables → Actions):
- `E2E_USER` / `E2E_PASSWORD` (可选,auth-gated spec 用)

失败会自动上传 HTML report + JSON results 到 workflow artifacts。

**为什么不每 PR 自动跑?**
- 需要一个已部署的 CDS 预览环境(和 smoke 一样)
- Playwright 首次装浏览器的成本即便有 cache 也 1-2 分钟
- Phase 6 作为**手动复盘工具**,每次 PR push 自动跑暂不划算

---

## 写新 spec 的模板

```ts
import { test, expect } from '@playwright/test';

test.describe('某功能组', () => {
  test('一条具体路径', async ({ page }) => {
    await page.goto('/some-path');
    // 断言
    await expect(page.getByRole('button', { name: '某按钮' })).toBeVisible();
  });
});
```

需要登录:

```ts
import { test, expect } from '@playwright/test';
import { login, requireCreds } from '../utils/auth.js';

test('登录后 XX 正常', async ({ page }, testInfo) => {
  const { user, password } = requireCreds(testInfo);
  await login(page, user, password);
  // 登录后的动作
});
```

---

## 设计原则

1. **金字塔顶,数量少** — 维护成本是单测的 10 倍,不追求覆盖率,只盯"survive 其他层仍然崩"的路径
2. **针对真实部署** — 不拉本地 vite dev 跑 E2E;我们是 CDS-first,灰度环境就是测试目标
3. **selector 优先 data-testid** — 文本/CSS 类名会变,data-testid 稳定;缺失时给出多 fallback 避免单点脆弱
4. **失败可复盘** — 截图 + trace + video 三件套,CI 失败 30 秒内就能点开看
5. **零侵入目标域** — 测试不写数据库、不留污染;UI 冒烟是只读(smoke-ui.spec.ts);登录路径走独立测试账号

---

## 扩展方向

待 Phase 6 基线稳定后可加:

- `agent-flow.spec.ts`: 完整 PRD Agent 会话路径(登录 → 创建 Group → 发消息 → 看 SSE 流)
- `defect-flow.spec.ts`: 缺陷分享 → AI 分析 → 评审
- `firefox` + `webkit` projects: 跨浏览器回归
- 视觉回归 (`@playwright/test` 内置 toMatchSnapshot): 抓取关键页面截图 diff

---

## 相关文档

- `doc/guide.smoke-tests.md` —— Phase 2-4 HTTP 冒烟
- `.claude/skills/acceptance-checklist/SKILL.md` —— Phase 5 真人 UAT
- `.claude/rules/e2e-verification.md` —— 端到端验收原则
- `doc/plan.cds-github-integration-followups.md` —— Phase 6 在规划里的位置
