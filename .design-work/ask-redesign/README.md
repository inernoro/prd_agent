# 「向我提问」重做 · 设计画布源文件

画布地址：https://claude.ai/code/artifact/bf3b7f06-ac55-4a92-872b-1c70606109a3

这里只放**源文件**：每个 `.dc.html` 是画布上的一块画板，`canvas.json` 是它们的排版与分页。
种出来的那个 2.5 MB HTML 不进仓库（见 `.gitignore`）——它随时能重新种出来，而且每次字节都不同。

## 改了之后怎么重新种

```bash
node "<design 技能目录>/seed-canvas.mjs" \
  --template "<design 技能目录>/payload.template.html" \
  --out ask-me-redesign.html --title "向我提问 · 重做" \
  --artboard Main.dc.html --artboard Answer.dc.html \
  --artboard DirectionA.dc.html --artboard DirectionC.dc.html \
  --artboard DirectionD.dc.html --artboard Pipeline.dc.html \
  --artboard Mobile.dc.html --canvas canvas.json
```

然后把 `ask-me-redesign.html` 发布回**同一个** artifact 地址，链接才不会变。

## 单独看一块画板

`preview-artboard.mjs` 把一个 `.dc.html` 摊平成普通 HTML 直接渲染，并报出内容高度有没有超出画框——
画框是手算的，超了会在画布上被裁掉而不报错，这条是唯一能提前发现的判据。

```bash
node preview-artboard.mjs Main.dc.html out.png 1440 1040
```

## 画板一览

| 文件 | 是什么 |
|---|---|
| `Main.dc.html` | 方向 B（领先方案）：底部停靠的收起态 + 展开空态 |
| `Answer.dc.html` | 方向 B 的答案态，引用点回正文并高亮 |
| `DirectionA.dc.html` | 方向 A：居中命令面板 |
| `DirectionC.dc.html` | 方向 C：内联问答区，与评论同在一条滚动流里 |
| `DirectionD.dc.html` | 方向 D：推挤式右栏，正文压窄不遮 |
| `Pipeline.dc.html` | 快捷词条的来路：上传时自动生成，上传者无感知 |
| `Mobile.dc.html` | 方向 B 的移动端形态 |

配色与字号取自 `prd-admin/src/styles/tokens.css`，不是另配的一套。
