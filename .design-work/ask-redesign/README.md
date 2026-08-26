# 「向我提问」重做 · 设计画布源文件

画布地址：https://claude.ai/code/artifact/bf3b7f06-ac55-4a92-872b-1c70606109a3

这里只放**源文件**：每个 `.dc.html` 是画布上的一块画板，`canvas.json` 是它们的排版与分页。
种出来的那个 2.5 MB HTML 不进仓库（见 `.gitignore`）——它随时能重新种出来，而且每次字节都不同。

## 改了之后怎么重新种

```bash
node "<design 技能目录>/seed-canvas.mjs" \
  --template "<design 技能目录>/payload.template.html" \
  --out ask-me-redesign.html --title "向我提问 · 重做" \
  --artboard Main.dc.html --artboard Sidebar.dc.html --artboard Collapsed.dc.html \
  --artboard Selection.dc.html --artboard EditFlow.dc.html --artboard Pipeline.dc.html \
  --artboard Mobile.dc.html --artboard DirectionA.dc.html --artboard DirectionC.dc.html \
  --artboard DirectionD.dc.html --canvas canvas.json
```

然后把 `ask-me-redesign.html` 发布回**同一个** artifact 地址，链接才不会变。

## 单独看一块画板

`preview-artboard.mjs` 把一个 `.dc.html` 摊平成普通 HTML 直接渲染，并报出内容高度有没有超出画框——
画框是手算的，超了会在画布上被裁掉而不报错，这条是唯一能提前发现的判据。

```bash
node preview-artboard.mjs Main.dc.html out.png 1440 1900
```

`_base.css` 是各画板共用的样式底子，`_head.sh` 把它拼成 `.dc.html` 的固定头部——
新增画板照抄现有那几个的写法即可，别手抄 `<x-dc>` / `<helmet>` 那几行。

## 画板一览

方案是「融合」：一个入口、三个停靠位。收起在右下角，点开在中下起手，问出去之后收成右侧栏。

### 第一页 · 主线三态

| 文件 | 是什么 |
|---|---|
| `Main.dc.html` | 主线：收起（右下胶囊）→ 中下起手（半透明长条 + 三枚悬浮提示）→ 右侧对话 |
| `Sidebar.dc.html` | 右侧栏细节：对话中（答案 + 引用回跳）、历史（这一页问过的每一轮） |
| `Collapsed.dc.html` | 三档折叠：侧栏收成竖条 / 只折输入框 / 整个收回胶囊，每档都留数字 |

### 第二页 · 划词、改写、词条来路、移动端

| 文件 | 是什么 |
|---|---|
| `Selection.dc.html` | 划词悬浮：访客「就这段问」；站点主人多一枚「改这段」。含 iframe 选区的硬前提 |
| `EditFlow.dc.html` | 「改这段」的四条代价与建议（建议留到二期，理由是三条产品决策未拍板） |
| `Pipeline.dc.html` | 快捷词条的来路：上传时从正文自动读出，上传者无感知 |
| `Mobile.dc.html` | 移动端三态；第三态退化成高 sheet，折叠只保留两档 |

### 第三页 · 来路

`DirectionA` / `DirectionC` / `DirectionD` 是上一轮没被选中的三个方向，留着当记录。

## 三处已拍板的取舍

- **起手态是一条长条，不是一个盒子。** 半圆两端、半透明、背后模糊，三枚提示浮在它上面，第 4/5 条收在「+2」里。
  正文在它背后透着看得见——它是浮在页面上的一件东西，不是盖住页面的一块板。玻璃件（长条 / 提示 / 那行元信息 /
  划词预填）必须**各自带底色**：浅色字裸放在托管页正文上会直接隐形，这是画的时候真撞到过的。
- **右侧栏是覆盖不是推挤。** 推挤会改变托管页自己的排版，PPT 与宽表格站当场破相；代价是盖住右边 400px，用三档折叠兜。
- **折叠必须留痕。** 竖条上的数字、胶囊上的角标——没有它用户会以为对话没了，重问一遍白烧额度。

配色与字号取自 `prd-admin/src/styles/tokens.css`，不是另配的一套。
