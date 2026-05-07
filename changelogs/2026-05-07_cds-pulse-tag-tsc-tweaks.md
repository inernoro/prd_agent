| fix | cds | 卡片闪烁高亮从 1.6s 拉长到 5s，关键帧重排让"看清"的时段（峰值 + 双脉动）维持 8-78%，避免一瞬间就闪没 |
| fix | cds | 标签删除前增加 confirm 弹窗，防止 hover ×误点 |
| perf | cds | self-update 后端/前端 tsc 各加一层 .tsc-input-sha 子树锚点 fast-path：相关子树未变就跳过 tsc，命中时省 5-30s |
