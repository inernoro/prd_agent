| perf | cds | cds/web `build` script 删掉冗余 `tsc --noEmit &&`,validate 阶段已跑过 tsc,build 时再跑是浪费 10-20s |
| refactor | cds | cds/web 把 `@vitejs/plugin-react`(Babel) 换成 `@vitejs/plugin-react-swc`(Rust),build 时间持平但 dev HMR ~5x 提速 |
