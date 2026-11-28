# 版本差异：V1 → V3

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 5：`A-37` 课程路线：五课是一条线上的五站，已学实心、当前站强调色，轨道填到当前站；点站切课；`A-38` 动手练习：三个练习三选一，默认选中本课配套的那个并标「本课配套」；主按钮文案随选中练习的状态变化（开始 / 接着做 / 再做一遍）；`A-39` 等待期主视觉是产物：评审中日志行与发现即时出现、代码编号同步出现，不用静止的加载圈；进度与预计时间做配角；`A-40` 判断有可见反馈：选择后按钮同色描边，该条右上角写「已采纳 / 已驳回」；改判时随之更新；`A-41` 排版刻度：正文字号只用 12 / 14 / 16 / 20 / 28，代码 13；每屏最多 6 种字号；字重只用 400 与 600；强调色只给当前状态与主按钮
- 删除 0：无
- 改写 16：`A-05`（rule、expected）；`A-11`（rule、expected）；`A-12`（rule、expected）；`A-13`（rule）；`A-17`（expected）；`A-21`（rule、expected）；`A-22`（rule、expected）；`A-23`（rule）；`A-25`（rule、expected）；`A-26`（rule）；`A-27`（rule、expected）；`A-28`（rule、expected）；`A-31`（rule、expected）；`A-32`（rule、expected）；`A-33`（rule、expected）；`A-34`（rule、expected）

## 二、画面

- 新增 0：无
- 删除 0：无
- 改动 0：无

## 三、文件

- 新增 7：源码 6（src/added/pages/learning-course/CourseMetro.tsx、src/added/pages/learning-course/Desk.tsx、src/added/pages/learning-course/FindingTicket.tsx、src/added/pages/learning-course/PracticeTicket.tsx、src/added/pages/learning-course/RunConsole.tsx、src/added/pages/learning-course/primitives.tsx）；工具 1（tools/type-audit.mjs）
- 删除 4：源码 4（src/added/pages/learning-course/AgentRunPanel.tsx、src/added/pages/learning-course/FindingCard.tsx、src/added/pages/learning-course/LessonRail.tsx、src/added/pages/learning-course/MediaSwitch.tsx）
- 改动 25：自检 2（checks/handoff-local.json、checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 11（src/added/pages/learning-course/ArticleLesson.tsx、src/added/pages/learning-course/CourseShelf.tsx、src/added/pages/learning-course/LearningCoursePage.tsx、src/added/pages/learning-course/LearningPracticePage.tsx、src/added/pages/learning-course/PdfLesson.tsx、src/added/pages/learning-course/PracticeWorkbench.tsx…）；工具 2（tools/self-check.mjs、tools/walkthrough.json）；文档 7（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/演示数据.json、设计文档/目标与验收.md…）

源码差异在 `source.diff`：21 个文件。

## 四、自检

- V1：38/38
- V3：43/43

## 五、稿件属性

- prototypeVersion：1 → 3
