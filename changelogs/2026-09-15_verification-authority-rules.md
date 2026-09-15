| rule | platform | cds-first-verification 重写：参照系从「本地 vs CDS」换成「每种改动的验证有唯一权威位置」，列出编译/测试/运行各自在哪被证明 |
| rule | platform | 写明 Branch Image 绿只覆盖 API 项目（不编译 PrdAgent.Tests），以及 ci.yml 在 feature 分支不自动跑 dotnet test 及其补救动作 |
| docs | platform | AGENTS.md 规则 2 与 5.2 校验表按同一判据改写（零净增行，记忆契约 197 行不变）；principles / agent-universe / cds diagnose 三处衍生叙述对齐 |
| docs | platform | debt.platform 新增「后端测试项目的接线方式」一节，记 Compile Include 机制的欠账与三个偿还方向 |
| fix | platform | 修 Codex review 两条：Branch Image 与 CI 都是 push 后才有结论（原表述与「校验全绿才准 push」自相矛盾）；CI 那档 xUnit 带 Category!=Integration&Manual 过滤，不是全量，不许写成「全量通过」 |
| fix | platform | 修 Codex 第二轮两条：AGENTS.md §8 的「本地 + CDS 双验证」同步为权威位置表的判据；sync-cursor-rules.sh 里硬编码的 description 跟着规则一起更新，否则 Cursor 侧看不到扩大后的触发场景 |
| fix | platform | 修 Codex 第三轮两条：权威位置表补齐 prd-desktop（含 Rust 四道）/ cds / llmgw / prd-video / Dockerfile / 脚本各自的判据（其中 prd-video、Dockerfile、脚本没有任何 CI job，只能本地跑）；lint 单列一行并写明只有本地能证明——Admin Dashboard Build 只跑 tsc / vitest / vite build，不含 ESLint |
