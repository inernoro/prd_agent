| fix | cds | 修复 CDS 系统设置/项目设置长页(如「更新与重启」)滚动条默认隐藏、看起来滑不动:壳改为 h-screen 固定 + 内容区(.cds-main)自身 overflow-y:auto 滚动,滚动条变常驻可见非 overlay(scrollbar-gutter:stable + 全局 ::-webkit-scrollbar 样式),顶栏/左导航钉住 |
| fix | cds | 设置页左侧导航 sticky 偏移随滚动容器变化由 lg:top-[72px] 改 lg:top-0(顶栏已移出滚动区) |
