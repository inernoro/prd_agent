---
name: tutorial-daily-maintain
description: 页面教程的每日定时维护 Agent。扫描 git 当日/本周增量,把"改了哪些页面"映射到受影响的页面教程(*-page-guide),检测 data-tour-id 锚点漂移,起草「本周有更新」更新提醒(tier=advanced, *-update-YYYYwNN),必要时建议升 page-guide Version,并把一份教程健康/验收报告发布到独立的「页面教程验收知识库」出分享链。首版只产草稿 + 漂移告警给人确认,不自动改 seed。触发词:"维护教程"、"教程日常维护"、"教程更新提醒"、"tutorial maintain"、"/tutorial-daily-maintain"、"本周教程有更新"。
---

# 页面教程每日维护

把「功能更新了 → 教程没跟上 / 更新没提醒用户」从靠人记变成每天一次的定时巡检。

> 与相邻技能的边界:
> - `createzzdemo`(`/createzzdemo`):从 0 **创建**一条新教程小书。
> - 本技能:对**已存在**的教程做**日常维护**(漂移检测 + 更新提醒 + 验收归档)。
> - `daily-report-summary`(`/daily`):面向人的「今日大事」日报。本技能面向**教程系统自身**的健康。
> - `create-visual-test-to-kb`(`/验收`):一次性人工取证验收。本技能是其**定时化 + 教程专用**的轻量版。

数据 SSOT:
- 教程目录 = `prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs` 的 `BuildDefaultTips`(每条 `*-page-guide`)。
- 进度/分类口径 = `GET /api/daily-tips/progress`(onboarding/task/update + learned)。
- 锚点 = 页面上的 `data-tour-id`。规则见 `.claude/rules/onboarding-tips.md`。

---

## 触发

- 定时:建议每日一次(用 `send_later` / CI cron / 平台定时任务挂本技能)。
- 手动:"维护教程"、"本周教程有更新"、"/tutorial-daily-maintain"。

---

## 工作流(4 步)

### 第 1 步:算增量(改了哪些页面)

```bash
# 当日(或上次维护以来)改动的前端页面文件
SINCE="${1:-1 day ago}"
git log --since="$SINCE" --name-only --pretty=format: -- 'prd-admin/src/pages/**' 'prd-admin/src/layouts/**' \
  | sort -u | grep -E '\.tsx?$'
```

把改动文件按「路由 → sourceId」映射成"受影响教程"清单。映射表来自 `onboarding-tips.md` 的页表 + `BuildDefaultTips` 里每条 seed 的 `actionUrl`。例:`pages/web-pages/*` 改动 → `webpages-page-guide`。

### 第 2 步:锚点漂移检测(改页面 → 教程是否还能跑)

对每个受影响教程,做 `onboarding-tips §2` 的「锚点对账」:

```bash
# 该 seed 的所有 Selector(从 BuildDefaultTips 抽 data-tour-id=xxx)
# 该页面现有的 data-tour-id 集合
grep -oE 'data-tour-id="[^"]*"' prd-admin/src/pages/<page>/**/*.tsx | sort -u
```

判定:
- seed 里引用的某个 `[data-tour-id=X]` 在页面已**不存在** → **P0 漂移**(教程会卡 10s 超时)。
- 页面新增了核心功能但没有对应步骤 → **P1 缺步**。
- 锚点指向 modal/dropdown 等非常驻元素 → **P2 易卡**。

漂移项**只产出告警清单**(写进报告 + 可选开 issue),**不自动改 seed**——改 seed 必须人确认,避免误判。

### 第 3 步:起草「本周有更新」提醒(tier=advanced)

对「功能确有更新、值得提醒老用户」的页面,起草一条**更新教程**(与新手教程分离,不重弹整套新手):

- `sourceId`: `<page>-update-<YYYY>w<WW>`(如 `webpages-update-2026w23`),保证每周一条、可追溯。
- `tier`: `"advanced"`(学会写真实 Version;下次该页再更新升 Version → 再次提醒)。
- `kind`: `"card"`;`startAt`=本周一,`endAt`=本周日 + 3 天缓冲(发布窗口=本周,过期自动消失)。
- `targetRoles`: 按受众(如只给 DEV/PM)。
- `autoAction.steps`: 2-3 步,**只讲"变了什么"**,锚点用页面常驻元素;别重复新手教程的全流程。

POST 入库(管理员令牌):

```bash
curl -X POST "$BASE/api/admin/daily-tips" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @/tmp/update-tip.json
```

> 它会落在「学习中心」的「本周更新」分组,以及对应页面 pill 的选择面板里,带「更新」chip。新手教程(basic)不受影响、不重弹(诉求 5)。

### 第 4 步:发布教程健康报告到独立知识库 + 出分享链

把本次巡检结论(受影响教程、漂移 P0-P2 清单、本周新增更新提醒、各 onboarding 教程的 learned 覆盖率)写成一篇 Markdown,发布到独立的「页面教程验收知识库」,复用 `daily-report-summary` 的 find-or-create + publish 范式:

```bash
python3 .claude/skills/daily-report-summary/reference/publish.py \
  --base "$BASE" --impersonate "$ADMIN_USER" \
  --library "页面教程验收知识库" \
  --title "教程巡检-$(date +%F)" \
  --report-md /tmp/tutorial-health-$(date +%F).md
```

报告命名带状态前缀(`[正常]` / `[有漂移]` / `[已修]`),输出分享短链供团队订阅。库 appKey 建议 `tutorial-acceptance`,与日报库隔离。

---

## 输出格式(交付给人)

```
教程巡检 YYYY-MM-DD
- 受影响教程:webpages-page-guide, document-store-page-guide
- 锚点漂移:
  - [P0] webpages-page-guide 第 7 步 [data-tour-id=webpages-upload-primary] 在页面已不存在 → 需改 seed
  - [P1] document-store 新增「批量导出」无对应步骤
- 本周更新提醒(草稿,待确认入库):webpages-update-2026w23(2 步)
- 掌握度覆盖:onboarding 14 套,平均 learned 占比 38%
- 报告:https://<kb-share-link>
- 待人确认:上面 1 条 P0 漂移需改 BuildDefaultTips(不自动改)
```

---

## 红线

- **不自动改 `BuildDefaultTips`**:漂移 / 升 Version 一律产草稿 + 告警,人确认后再改(避免误判把好教程改坏)。
- **新手与更新分离**:更新提醒一律 `tier=advanced` + `*-update-*` sourceId,绝不动 `*-page-guide`(basic),否则老用户被重弹整套新手(诉求 5 明令禁止)。
- **禁 emoji**(CLAUDE.md §0):报告 / tip 文案 / commit 全部不带 emoji。
- **锚点必须常驻**:起草更新提醒的步骤只锚页面常驻元素(onboarding-tips §2)。
- 报告归档前过 `create-visual-test-to-kb` 的准入校验口径(目标/档位/证据完整性),不达标不归档。

---

## 相关

- `.claude/rules/onboarding-tips.md` — 页表 + 三类 tier + 锚点对账强制钩子
- `.claude/skills/createzzdemo/SKILL.md` — 创建新教程
- `.claude/skills/daily-report-summary/reference/publish.py` — KB find-or-create + publish 范式(复用)
- `DailyTipsController.BuildDefaultTips` — 教程目录 SSOT;`GET /api/daily-tips/progress` — 进度/分类口径
