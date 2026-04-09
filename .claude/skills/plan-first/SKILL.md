---
name: plan-first
description: >
  Use this skill whenever the user says "给出方案", "先给方案", "方案", "给我方案", "方案确认后再动手", "先说思路", "给出你的思路和方案", or any phrase asking Claude to plan before executing. Also trigger when the user asks Claude to "先分析" or "先规划" before taking action. This skill ensures Claude always delivers a concise structured analysis first and explicitly waits for user approval before touching any files, writing any code, or taking any action. IMPORTANT: trigger this skill proactively whenever the user's phrasing implies they want a plan reviewed before execution — even if they don't use the exact trigger words.
---

# Plan-First Workflow

When the user asks for a "方案" or requests that you plan before executing, follow this response pattern exactly.

## Response structure

Deliver your analysis concisely — the whole response should be under 300 words. Use this order:

**意图理解（1-2 句）**
State what you understand the user wants to accomplish. Be specific — don't just paraphrase the request.

**现状与问题**
Briefly describe the current state and identify the gap or problem. Distinguish facts (things you can verify) from inferences (things you're reasoning about). If something is uncertain, flag it plainly.

**思路与方案**
Your proposed approach: what you'll change, how, and why. Keep this concrete — the user needs enough detail to say yes or no, not a vague outline.

**涉及改动（可选）**
If the scope involves specific files, functions, or lines, list them briefly so the user can assess the footprint. Skip this if the change is conceptual or doesn't involve code.

**导航位置（新 Agent / 新页面必填）**
If the plan introduces a new agent, a new page, or a new user-facing entry, you MUST declare where users will find it, using this exact format:

```
【位置】百宝箱（默认）/ 左侧导航"XX" / 首页快捷入口
【路径】登录后首页 → 1) 点击 X → 2) 点击 Y → 3) 到达
```

Per `.claude/rules/navigation-registry.md`, the default location for any new agent is the 百宝箱 (`toolboxStore.ts` BUILTIN_TOOLS). Only add to the left sidebar or homepage when the user explicitly asks. Skip this field only when the change doesn't introduce any new user-facing entry.

End with a clear waiting signal, e.g.: "确认后执行" or "等待您确认后动手。"

## Key principles

**Don't start executing.** Not even "minor" or "obvious" parts. The entire point of this workflow is that the user confirms scope before anything changes. Respect this even if the fix seems trivial.

**Be concise and decisive.** This is a decision-making aid. The user needs to quickly scan and approve — not read a report. Prefer bullet points or short paragraphs over long prose.

**One question if unclear.** If a critical detail is ambiguous, ask exactly one focused question rather than speculating. Don't block the plan on minor unknowns — make a reasonable assumption and note it.

**Separate concerns cleanly.** If the user's request involves multiple independent changes, list them separately so they can approve or reject each one.

## After confirmation

Once the user says "可以", "执行", "确认", "好", or equivalent, proceed immediately with the actual implementation. No need to repeat the plan.
