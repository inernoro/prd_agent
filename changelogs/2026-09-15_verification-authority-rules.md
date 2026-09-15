| rule | platform | cds-first-verification 重写：参照系从「本地 vs CDS」换成「每种改动的验证有唯一权威位置」，列出编译/测试/运行各自在哪被证明 |
| rule | platform | 写明 Branch Image 绿只覆盖 API 项目（不编译 PrdAgent.Tests），以及 ci.yml 在 feature 分支不自动跑 dotnet test 及其补救动作 |
| docs | platform | AGENTS.md 规则 2 与 5.2 校验表按同一判据改写（零净增行，记忆契约 197 行不变）；principles / agent-universe / cds diagnose 三处衍生叙述对齐 |
| docs | platform | debt.platform 新增「后端测试项目的接线方式」一节，记 Compile Include 机制的欠账与三个偿还方向 |
| fix | platform | 修 Codex review 两条：Branch Image 与 CI 都是 push 后才有结论（原表述与「校验全绿才准 push」自相矛盾）；CI 那档 xUnit 带 Category!=Integration&Manual 过滤，不是全量，不许写成「全量通过」 |
