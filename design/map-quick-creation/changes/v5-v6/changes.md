# 版本差异：V5 → V6

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 4：`A-43` 风格库按 Lemo-Opuscar 的分类：15 类 99 种，可按类别筛选、按名字或类别搜索；选中风格显示样片海报、样片名与时长、一句话说明和来源署名；`A-44` 输入框里的风格按钮就地弹出选择面板（搜索 + 类别 + 列表），选中后面板关闭，按钮与右栏风格库同步；面板底部可去右栏看大图；`A-45` 「视频 / 网页」在输入框里切换，风格与产出相互独立：切换产出不改风格，切换风格不改产出；`A-46` 风格来源与授权写清：风格说明（STYLE.md，CC BY-NC 4.0）只按编号引用、界面与源码差异不含原文；样片海报署名「Lemo-Opuscar by Lemomo (LemoLab)」并注明 CC BY 4.0
- 删除 0：无
- 改写 4：`A-11`（rule、expected）；`A-13`（rule、expected）；`A-35`（rule、expected）；`A-39`（rule、expected）

## 二、画面

- 新增 1：`style-picker` 输入框里就地换风格（15 类 99 种）
- 删除 0：无
- 改动 0：无

## 三、文件

- 新增 103：源码 101（src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/opuscar/catalog.json、src/opuscar/posters/archive-lighttable.webp、src/opuscar/posters/art-deco.webp、src/opuscar/posters/ascii-crt.webp、src/opuscar/posters/assembly-line-diagram.webp…）；工具 1（tools/import-opuscar.py）；文档 1（设计文档/验收计划.md）
- 删除 0：无
- 改动 21：自检 2（checks/handoff-local.json、checks/result.json）；其他 3（design.json、prototype.json、versions.json）；原型 1（dist/index.html）；源码 8（src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/TemplateFrames.tsx、src/added/pages/quick-creation-agent/WorksList.tsx、src/added/pages/quick-creation-agent/types.ts、src/added/services/real/quickCreation.ts…）；工具 3（tools/export-demo-data.mjs、tools/manifest-src.mjs、tools/walkthrough.json）；文档 4（交付说明.md、思路.md、设计文档/源码差异.diff、设计文档/演示数据.json）

源码有 109 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V5：43/43
- V6：47/47

## 五、稿件属性

- prototypeVersion：5 → 6

源码差异没有附在包里（109 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v5 --to v6`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
