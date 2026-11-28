# 版本差异：V2 → V3

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 1：`A-41` 排版刻度：正文字号只用 12 / 14 / 16 / 20 / 28，代码 13；每屏最多 6 种字号；字重只用 400 与 600；强调色只给当前状态与主按钮
- 删除 0：无
- 改写 19：`A-11`（rule、expected）；`A-12`（rule、expected）；`A-13`（rule）；`A-17`（expected）；`A-21`（rule、expected）；`A-22`（rule、expected）；`A-23`（rule）；`A-25`（rule）；`A-26`（rule）；`A-27`（rule、expected）；`A-28`（rule）；`A-31`（rule、expected）；`A-32`（rule、expected）；`A-33`（rule、expected）；`A-34`（rule、expected）；`A-37`（rule、expected）；`A-38`（rule）；`A-39`（rule、expected）；`A-40`（rule、expected）

## 二、画面

- 新增 0：无
- 删除 0：无
- 改动 0：无

## 三、文件

- 新增 1：工具 1（tools/type-audit.mjs）
- 删除 0：无
- 改动 26：自检 1（checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 14（src/added/pages/learning-course/ArticleLesson.tsx、src/added/pages/learning-course/CourseMetro.tsx、src/added/pages/learning-course/CourseShelf.tsx、src/added/pages/learning-course/Desk.tsx、src/added/pages/learning-course/FindingTicket.tsx、src/added/pages/learning-course/LearningCoursePage.tsx…）；工具 2（tools/self-check.mjs、tools/walkthrough.json）；文档 6（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/目标与验收.md、设计文档/验收计划.md）

源码有 14 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V2：42/42
- V3：43/43

## 五、稿件属性

- prototypeVersion：2 → 3

源码差异没有附在包里（14 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v2 --to v3`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
