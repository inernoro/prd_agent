# 版本差异：V2 → V3

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 0：无
- 删除 0：无
- 改写 0：无

## 二、画面

- 新增 0：无
- 删除 0：无
- 改动 0：无

## 三、文件

- 新增 0：无
- 删除 0：无
- 改动 10：其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 2（src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/env.ts）；工具 2（tools/handoff-local.mjs、tools/manifest-src.mjs）；文档 3（交付说明.md、思路.md、设计文档/源码差异.diff）

源码有 2 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V2：43/43
- V3：43/43

## 五、稿件属性

- prototypeVersion：2 → 3

源码差异没有附在包里（2 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v2 --to v3`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
