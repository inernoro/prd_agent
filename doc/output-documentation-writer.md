# Report Agent (周报管理 Agent) — Diataxis Documentation

> **Module**: `report-agent` | **appKey**: `report-agent` | **Base Route**: `/api/report-agent`
>
> Report Agent transforms weekly reporting from "recall-based writing" to "confirm-and-submit" by automatically collecting work data from code repositories and project management tools, then using AI to draft structured weekly reports.

---

## Table of Contents

- [Part I — Tutorials](#part-i--tutorials)
  - [Tutorial 1: Setting Up Your First Team](#tutorial-1-setting-up-your-first-team)
  - [Tutorial 2: Creating Your First Weekly Report](#tutorial-2-creating-your-first-weekly-report)
- [Part II — How-to Guides](#part-ii--how-to-guides)
  - [How to Configure Data Sources](#how-to-configure-data-sources)
  - [How to Use AI Fill to Generate Report Content](#how-to-use-ai-fill-to-generate-report-content)
  - [How to Generate a Team Summary](#how-to-generate-a-team-summary)
  - [How to Use Daily Check-in](#how-to-use-daily-check-in)
  - [How to Export a Report](#how-to-export-a-report)
  - [How to Compare Plans vs. Actuals](#how-to-compare-plans-vs-actuals)
- [Part III — Reference](#part-iii--reference)
  - [API Endpoints](#api-endpoints)
  - [Data Models (MongoDB Collections)](#data-models-mongodb-collections)
  - [Permissions](#permissions)
  - [State Machine](#state-machine)
  - [Template System](#template-system)
  - [Section Types and Input Types](#section-types-and-input-types)
- [Part IV — Explanation](#part-iv--explanation)
  - [Why a Two-Level Data Source Architecture?](#why-a-two-level-data-source-architecture)
  - [Why Templates Snapshot on Report Creation](#why-templates-snapshot-on-report-creation)
  - [Why "Reviewed" Is a Terminal State](#why-reviewed-is-a-terminal-state)
  - [Why ISO Week Numbering](#why-iso-week-numbering)
  - [The Confirm-and-Submit Philosophy](#the-confirm-and-submit-philosophy)

---

# Part I — Tutorials

These tutorials are designed for new users. Follow them in order to go from zero to a working weekly report workflow.

## Tutorial 1: Setting Up Your First Team

**What you will learn:** How to create a team, add members, assign roles, and seed a report template.

**Prerequisites:**
- You have a user account with the `report-agent.use` and `report-agent.team.manage` permissions.
- At least one other user exists in the system to add as a team member.

### Step 1: Create the team

Navigate to the Report Agent module in the admin panel. Click "Create Team" and fill in the required fields:

| Field | Example Value | Notes |
|-------|---------------|-------|
| Name | "Backend Team" | A short, recognizable name |
| Leader | (select yourself) | The team leader is automatically added as a member |
| Description | "Server-side engineering" | Optional |
| Report Visibility | `all_members` | Members can view each other's reports |

After creation, the system automatically adds the leader as a team member with the `leader` role.

### Step 2: Add team members

From the team detail page, click "Add Member". For each person:

1. Search and select the user.
2. Assign a role: `member`, `leader`, or `deputy`.
3. Optionally set a Job Title (e.g., "Senior Developer"). Job titles can be used to match templates.

### Step 3: Seed report templates

Report Agent ships with three system templates. To initialize them for your team, call the seed endpoint or click "Initialize Templates" in the UI:

- **dev-general** (Research & Development General): Sections for code output, task output, completed work, daily work, next week's plan, and notes.
- **product-general** (Product General): Sections for requirement progress, documentation output, completed work, daily work, and next week's plan.
- **minimal** (Minimal Mode): Only aggregate output stats and a notes section.

You now have a team ready for weekly reporting.

### Step 4: Verify the setup

Navigate to the team dashboard. You should see:
- The team name and member count.
- An empty report list for the current week.
- The template list showing the seeded templates.

---

## Tutorial 2: Creating Your First Weekly Report

**What you will learn:** How to create a weekly report from a template, fill in content, and submit it for review.

**Prerequisites:**
- You completed Tutorial 1 (you are a member of a team with templates).

### Step 1: Create a report for the current week

From the Report Agent main page:

1. Select your team.
2. Select a template (e.g., "dev-general").
3. Click "Create Report".

The system automatically calculates the ISO week number and period (Monday to Sunday). The template sections are snapshot into the report at creation time.

### Step 2: Fill in the report content

Each section appears as an editable block. Depending on the section type:

- **auto-stats** sections: Display read-only statistics from data sources (if configured).
- **auto-list** sections: Use the "AI Fill" button to generate content from collected data, then edit as needed.
- **manual-list** sections: Type your items directly (e.g., next week's plan).
- **free-text** sections: Enter free-form text (e.g., notes).

For this tutorial, manually type a few bullet points under "Completed This Week" and "Next Week's Plan".

### Step 3: Save your draft

Click "Save". The report remains in `draft` status. You can return and edit it at any time.

### Step 4: Submit the report

When you are satisfied with the content, click "Submit". The status changes to `submitted`. Your team leader will be notified.

> **Important:** After submission, you cannot edit the report unless a leader returns it to you.

### Step 5: (Leader) Review the report

If you are the team leader or deputy, navigate to the submitted report and choose one of:

- **Review (Approve):** Marks the report as `reviewed`. This is a terminal state.
- **Return:** Sends the report back to `returned` status with an optional reason. The author can then edit and resubmit.

Congratulations — you have completed the full report lifecycle.

---

# Part II — How-to Guides

Each guide solves a specific problem. They assume you already understand the basics from the tutorials.

## How to Configure Data Sources

Data sources connect your team to external systems (GitHub, GitLab, SVN) so that commit data can be automatically collected for report generation.

**Required permission:** `report-agent.datasource.manage`

### Team-level data sources

1. Navigate to Team Settings > Data Sources.
2. Click "Add Data Source".
3. Fill in the configuration:

| Field | Description |
|-------|-------------|
| Name | Display name (e.g., "Main Repo") |
| Source Type | `git` or `svn` |
| Repo URL | Full repository URL |
| Access Token | Personal access token (stored AES-256 encrypted) |
| Branch Filter | Comma-separated branches to monitor (e.g., `main,develop,release/*`) |
| Poll Interval | Sync frequency in minutes (default: 60) |

4. Click "Test Connection" to verify the token and URL.
5. Click "Save", then "Sync Now" to trigger an initial data pull.

### User mapping

After syncing, map git author identities to system users:

1. In the data source settings, open the User Mapping section.
2. For each git author email/name, select the corresponding system user.

Alternatively, set identity mappings per member via Team > Members > Identity Mappings (supports `github`, `gitlab`, `tapd`, `yuque` platforms).

### Personal data sources

Individual members can also configure their own data sources via "My Sources" to supplement team-level collection.

---

## How to Use AI Fill to Generate Report Content

AI Fill uses the LLM Gateway to transform raw collected data (commits, daily logs, platform activity) into structured report content.

1. Open a report in `draft` or `returned` status.
2. Click the "AI Fill" (AI Generate) button on the report or on individual sections.
3. The system will:
   - Collect data from all configured sources for the report's week period.
   - Build a structured prompt including template section definitions and collected data.
   - Call the LLM via `ILlmGateway` with `AppCallerCode = report-agent.generate::chat`.
   - Parse the JSON response and populate report sections.
4. Review the AI-generated content. All auto-generated items are editable.
5. Save the report.

**Tips:**
- AI Fill works best when data sources are configured and synced.
- Even without external data sources, the system collects platform activity (conversations, AI calls) to generate meaningful summaries.
- The AI follows rules: no "no data this week" fillers, specific numbers over vague descriptions, business language over technical jargon.

---

## How to Generate a Team Summary

Team summaries aggregate all submitted reports from a given week into a single overview document.

**Who can do this:** Team leaders and deputies.

1. Ensure team members have submitted their reports for the target week.
2. Navigate to Team Dashboard > Summary tab.
3. Click "Generate Summary" for the desired week.
4. The system:
   - Gathers all submitted/reviewed reports for that week and team.
   - Sends the combined content to the LLM for summarization.
   - Produces sections such as "Highlights", "Key Metrics", "Risks & Blockers".
5. The summary shows member count and submitted count (e.g., "8/10 members submitted").
6. Export the summary as Markdown via the export button.

---

## How to Use Daily Check-in

Daily check-in (daily logs) captures small work items throughout the week so they are not forgotten at report time.

1. From the Report Agent home page, navigate to "Daily Check-in".
2. Select today's date (or a past date within the current week).
3. Add items with:
   - **Content**: A brief description of what you did.
   - **Category**: One of `development`, `meeting`, `communication`, `documentation`, `testing`, `other`.
   - **Tags**: Optional custom tags (teams can define custom tags like "code review", "requirement review").
   - **Duration**: Optional time spent in minutes.
4. Save. Items appear as one record per user per day.
5. When AI Fill runs, daily log entries are included as a data source for the "Daily Work" section.

---

## How to Export a Report

1. Open any report (your own, or one you have permission to view).
2. Click the "Export" button.
3. Choose Markdown format.
4. The system generates a formatted Markdown document and triggers a download.

For team summaries, the same export option is available on the summary detail page at `GET /api/report-agent/teams/{teamId}/summary/export/markdown`.

---

## How to Compare Plans vs. Actuals

Plan comparison shows what you planned last week (the "Next Week's Plan" section from the previous report) alongside what you actually completed this week.

1. Open the current week's report.
2. Click "Plan Comparison" or navigate to the comparison view.
3. The system retrieves the previous week's report for the same user and team, extracts the plan section, and displays it alongside the current week's completed items.

This feature helps identify gaps between planned and actual work.

---

# Part III — Reference

## API Endpoints

All endpoints are under the base route `POST/GET/PUT/DELETE /api/report-agent/...` and require the `Authorize` attribute. The controller enforces `AdminPermissionCatalog.ReportAgentUse` as the minimum permission.

### Team Management (7 endpoints)

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/teams` | List teams the current user belongs to (admins with `view.all` see all) | `use` |
| `GET` | `/teams/{id}` | Get team detail with member list | `use` |
| `POST` | `/teams` | Create a team (auto-adds leader as member) | `team.manage` |
| `PUT` | `/teams/{id}` | Update team settings | `team.manage` |
| `DELETE` | `/teams/{id}` | Delete team (fails if reports exist) | `team.manage` |
| `POST` | `/teams/{id}/members` | Add a member to the team | `team.manage` |
| `DELETE` | `/teams/{id}/members/{userId}` | Remove a member | `team.manage` |
| `PUT` | `/teams/{id}/members/{userId}` | Update member role/job title | `team.manage` |
| `PUT` | `/teams/{id}/members/{userId}/identity-mappings` | Set member's platform identity mappings | `team.manage` |
| `POST` | `/teams/{teamId}/members/{userId}/vacation` | Set member vacation for a week | `team.manage` or leader/deputy |
| `DELETE` | `/teams/{teamId}/members/{userId}/vacation` | Remove vacation status | `team.manage` or leader/deputy |

### Workflow (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/teams/{id}/workflow` | Get team's data collection workflow |
| `POST` | `/teams/{id}/workflow/run` | Trigger a workflow execution |

### Users (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users` | List all users (for member picker) |

### Template Management (5 endpoints)

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/templates` | List templates (filterable by teamId) | `use` |
| `GET` | `/templates/{id}` | Get template detail | `use` |
| `POST` | `/templates` | Create a custom template | `template.manage` |
| `PUT` | `/templates/{id}` | Update template | `template.manage` |
| `DELETE` | `/templates/{id}` | Delete template (system templates protected) | `template.manage` |
| `POST` | `/templates/seed` | Seed system templates | `template.manage` |

### Weekly Report CRUD & Lifecycle (9 endpoints)

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/reports` | List reports (filters: teamId, userId, weekYear, weekNumber, status) | `use` |
| `GET` | `/reports/{id}` | Get report detail | `use` (visibility rules apply) |
| `POST` | `/reports` | Create a new report (template snapshot at creation) | `use` + team member |
| `PUT` | `/reports/{id}` | Update report content (only in draft/returned/overdue) | `use` + report owner |
| `DELETE` | `/reports/{id}` | Delete report (only drafts by owner) | `use` + report owner |
| `POST` | `/reports/{id}/submit` | Submit report (draft/returned/overdue -> submitted) | `use` + report owner |
| `POST` | `/reports/{id}/review` | Mark as reviewed (submitted -> reviewed) | leader/deputy |
| `POST` | `/reports/{id}/return` | Return report with reason (submitted -> returned) | leader/deputy |
| `POST` | `/reports/{id}/generate` | AI generate report content | `use` + report owner |

### Dashboard (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/teams/{id}/dashboard` | Team dashboard with member status matrix, stats |

### Daily Check-in (4 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/daily-logs` | Create/update daily log (upsert by userId+date) |
| `GET` | `/daily-logs` | List daily logs for current user in a date range |
| `GET` | `/daily-logs/{date}` | Get daily log for a specific date |
| `DELETE` | `/daily-logs/{date}` | Delete daily log for a specific date |

### Personal Data Sources (5 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/my/sources` | List current user's personal data sources |
| `POST` | `/my/sources` | Create a personal data source |
| `PUT` | `/my/sources/{id}` | Update a personal data source |
| `DELETE` | `/my/sources/{id}` | Delete a personal data source |
| `POST` | `/my/sources/{id}/test` | Test personal source connection |
| `POST` | `/my/sources/{id}/sync` | Manually sync personal source |
| `GET` | `/my/stats` | Get personal collected stats for current week |

### Team Data Sources (6 endpoints)

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/data-sources` | List team data sources | `datasource.manage` |
| `POST` | `/data-sources` | Create team data source | `datasource.manage` |
| `PUT` | `/data-sources/{id}` | Update team data source | `datasource.manage` |
| `DELETE` | `/data-sources/{id}` | Delete team data source | `datasource.manage` |
| `POST` | `/data-sources/{id}/test` | Test connection | `datasource.manage` |
| `POST` | `/data-sources/{id}/sync` | Manual sync | `datasource.manage` |
| `GET` | `/data-sources/{id}/commits` | List synced commits | `datasource.manage` |

### Comments (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reports/{id}/comments` | List comments on a report |
| `POST` | `/reports/{id}/comments` | Add a comment (supports section-level, replies) |
| `DELETE` | `/reports/{reportId}/comments/{commentId}` | Delete a comment (author only) |

### Plan Comparison (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reports/{id}/plan-comparison` | Compare previous week's plan vs. current actuals |

### Team Summary (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/teams/{id}/summary/generate` | AI generate team weekly summary | leader/deputy |
| `GET` | `/teams/{id}/summary` | Get team summary for a specific week |

### Trends (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/trends/personal` | Personal 12-week report trend data |
| `GET` | `/trends/team/{teamId}` | Team 12-week trend data |

### Export (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reports/{id}/export/markdown` | Export a report as Markdown |
| `GET` | `/teams/{teamId}/summary/export/markdown` | Export team summary as Markdown |

### Activity (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/activity` | Get platform activity data for report generation |

---

## Data Models (MongoDB Collections)

Report Agent uses 9 MongoDB collections:

| Collection | Model Class | Description |
|------------|-------------|-------------|
| `report_teams` | `ReportTeam` | Team definitions (name, leader, visibility, auto-submit schedule, custom daily log tags) |
| `report_team_members` | `ReportTeamMember` | Team membership (userId, role, jobTitle, identity mappings per platform) |
| `report_templates` | `ReportTemplate` | Report templates with sections (supports system and custom templates) |
| `report_weekly_reports` | `WeeklyReport` | Individual weekly reports (status, sections with content items, stats snapshot) |
| `report_daily_logs` | `ReportDailyLog` | Per-user per-day check-in logs (items with category, tags, duration) |
| `report_data_sources` | `ReportDataSource` | Git/SVN repository connections (encrypted tokens, user mapping, poll config) |
| `report_commits` | `ReportCommit` | Cached commit data synced from data sources (author, hash, additions, deletions) |
| `report_comments` | `ReportComment` | Section-level comments with reply threading on reports |
| `report_team_summaries` | `TeamSummary` | AI-generated team weekly summaries (sections, source report IDs, submission stats) |

### Key Model Relationships

```
ReportTeam (1) ──< (N) ReportTeamMember
ReportTeam (1) ──< (N) ReportDataSource
ReportTeam (1) ──< (N) WeeklyReport
ReportTeam (1) ──< (N) TeamSummary
ReportTemplate (1) ──snapshot──< (N) WeeklyReport.Sections
ReportDataSource (1) ──< (N) ReportCommit
WeeklyReport (1) ──< (N) ReportComment
User (1) ──< (N) ReportDailyLog
```

---

## Permissions

### System-level Permissions (5)

Managed via `AdminPermissionCatalog` and enforced by middleware.

| Permission Key | Display Name | Description |
|----------------|-------------|-------------|
| `report-agent.use` | Weekly Report Agent | Base access to the module (required for all endpoints) |
| `report-agent.template.manage` | Template Management | Create, edit, delete report templates |
| `report-agent.team.manage` | Team Management | Create/edit teams, manage members |
| `report-agent.view.all` | View All | See all teams and all reports (admin/manager use) |
| `report-agent.datasource.manage` | Data Source Management | Configure Git/SVN repository connections |

### Team-level Roles (3)

Defined in `ReportTeamRole`. Enforced in controller logic per endpoint.

| Role | Key | Capabilities |
|------|-----|-------------|
| Leader | `leader` | Review/return reports, generate team summaries, manage vacations, full dashboard access |
| Deputy | `deputy` | Same as leader (co-leader for delegation) |
| Member | `member` | Create/edit/submit own reports, view reports per visibility settings, daily check-in |

### Visibility Modes

| Mode | Key | Behavior |
|------|-----|----------|
| All Members | `all_members` | Every team member can view everyone's reports |
| Leaders Only | `leaders_only` | Only leaders and deputies can view member reports |

---

## State Machine

The weekly report lifecycle follows a state machine with the following transitions:

```
                  ┌──────────────────────────────┐
                  │                                │
                  v                                │
  [draft] ──submit──> [submitted] ──review──> [reviewed]  (terminal)
    ^                      │
    │                      │
    │               return (with reason)
    │                      │
    │                      v
    └──── edit ─── [returned] ──submit──> [submitted]
                       ^
                       │
  [overdue] ──edit/submit──┘
```

**Status values** (`WeeklyReportStatus`):

| Status | Key | Description |
|--------|-----|-------------|
| Not Started | `not-started` | Placeholder, report not yet created |
| Draft | `draft` | Initial state on creation; editable by owner |
| Submitted | `submitted` | Awaiting leader review; read-only for owner |
| Reviewed | `reviewed` | Approved by leader/deputy; **terminal state** |
| Returned | `returned` | Sent back for revision; editable by owner |
| Overdue | `overdue` | Past deadline without submission; can still edit and submit |
| Vacation | `vacation` | Member is on vacation for this week; no report expected |
| Viewed | `viewed` | v2.0 simplified flow: leader has viewed the report |

**Editable states:** `draft`, `returned`, `overdue`.

**Transitions:**
- `draft` / `returned` / `overdue` -> `submitted`: Owner calls `POST /reports/{id}/submit`
- `submitted` -> `reviewed`: Leader/deputy calls `POST /reports/{id}/review`
- `submitted` -> `returned`: Leader/deputy calls `POST /reports/{id}/return` with reason

---

## Template System

### System Templates (3)

| Template Key | Name | Target Audience | Sections |
|--------------|------|-----------------|----------|
| `dev-general` | Research & Development General | Engineers | Code Output (auto-stats), Task Output (auto-stats), Completed (auto-list), Daily Work (auto-list), Next Week Plan (manual-list), Notes (free-text) |
| `product-general` | Product General | Product Managers | Requirement Progress (auto-stats), Doc Output (auto-stats), Completed (auto-list), Daily Work (auto-list), Next Week Plan (manual-list) |
| `minimal` | Minimal Mode | Any role | Aggregate Output (auto-stats), Notes (free-text) |

### Custom Templates

Teams can create custom templates bound to a specific team and/or job title. Custom templates can define any combination of sections with the section types and input types listed below.

---

## Section Types and Input Types

### Section Types (`ReportSectionType`) — v2.0

| Type | Key | Behavior |
|------|-----|----------|
| Auto Stats | `auto-stats` | Read-only statistics cards from data sources |
| Auto List | `auto-list` | AI-generated bullet items (editable after generation) |
| Manual List | `manual-list` | User-entered items only |
| Free Text | `free-text` | Free-form text paragraph |

### Input Types (`ReportInputType`)

| Type | Key | Usage |
|------|-----|-------|
| Bullet List | `bullet-list` | Ordered list of items |
| Rich Text | `rich-text` | Free-form rich text |
| Key-Value | `key-value` | Label-value pairs (for stats display) |
| Progress Table | `progress-table` | Tabular progress tracking |

### Daily Log Categories (`DailyLogCategory`)

| Category | Key |
|----------|-----|
| Development | `development` |
| Meeting | `meeting` |
| Communication | `communication` |
| Documentation | `documentation` |
| Testing | `testing` |
| Other | `other` |

---

# Part IV — Explanation

## Why a Two-Level Data Source Architecture?

Report Agent employs two levels of data source configuration:

1. **Team-level data sources** (`report_data_sources`): Configured by administrators with `datasource.manage` permission. These represent shared repositories that the entire team works on. Commits are synced centrally and mapped to team members via `UserMapping`.

2. **Personal data sources** (`/my/sources`): Configured by individual members for repositories or accounts that are not centrally managed. This handles cases where a developer contributes to a side project, an open-source library, or a repository outside the team's purview.

**Why not just one level?**

- **Central control vs. individual flexibility.** Team leads need to ensure the main repositories are tracked. But developers may also want to include contributions from personal or cross-team repos without requiring admin intervention.
- **Identity mapping complexity.** Team-level sources use a shared `UserMapping` dictionary. Personal sources inherently belong to one user, eliminating the mapping step.
- **Permission separation.** Data source management is a privileged operation (encrypted tokens, repository access). Personal sources limit the blast radius to one user's own tokens.

When AI Fill runs, it merges data from both levels, giving a comprehensive picture of each member's work.

---

## Why Templates Snapshot on Report Creation

When a report is created (`POST /reports`), the template's sections are **deep-copied** into the report's `Sections` array as `WeeklyReportSection.TemplateSection`. From that point forward, the report is independent of the template.

This design choice exists for three reasons:

1. **Immutability of historical records.** A weekly report is a point-in-time document. If a template is later modified (sections added, renamed, or reordered), existing reports should not retroactively change. A report submitted in Week 12 should still read exactly as it did when it was submitted, regardless of template changes in Week 13.

2. **Safe template evolution.** Teams often iterate on their reporting structure. Snapshotting means the template can be freely updated without worrying about corrupting past data. There is no need for template versioning or migration logic.

3. **Consistency in review and comparison.** Plan comparison (`/reports/{id}/plan-comparison`) relies on matching section structures between consecutive weeks. If templates could change the structure of past reports, this comparison would break.

The trade-off is slightly increased storage (section definitions are duplicated per report), but for a weekly cadence this is negligible.

---

## Why "Reviewed" Is a Terminal State

Once a leader marks a report as `reviewed`, it cannot transition to any other state. This is intentional:

1. **Audit trail integrity.** The reviewed status represents a formal acknowledgment by a leader that they have read and accepted the report. Allowing further edits after review would undermine this acknowledgment. If the content could change post-review, the leader's approval would no longer reflect what they actually reviewed.

2. **Downstream dependencies.** Team summaries (`TeamSummary`) are generated from submitted/reviewed reports. If a reviewed report could be edited and re-submitted, previously generated summaries would become inconsistent with the underlying data.

3. **Behavioral incentive.** Making review terminal encourages authors to be thorough before submission and leaders to communicate feedback via the return mechanism rather than informal side-channels. The `return` -> `edit` -> `resubmit` cycle is the intended feedback loop.

4. **Simplicity.** A linear, forward-only state machine is easier to reason about for both users and code. There are no ambiguous states like "reviewed but modified" to handle.

If corrections are truly needed after review, the recommended approach is to create a supplementary note via comments (`POST /reports/{id}/comments`), which preserves the audit trail.

---

## Why ISO Week Numbering

Report Agent uses ISO 8601 week numbering (`ISOWeek.GetYear` / `ISOWeek.GetWeekOfYear`) rather than locale-dependent week calculations. This ensures:

- **Consistency.** All users see the same week number regardless of their locale or calendar settings.
- **Cross-year correctness.** ISO weeks handle the December/January boundary correctly. Week 1 of a year is the week containing the first Thursday, so December 29-31 may belong to Week 1 of the next year. The `WeekYear` field (which may differ from the calendar year) prevents data misattribution.
- **Monday-start alignment.** ISO weeks always start on Monday, which aligns with the typical work week. `PeriodStart` is always a Monday, `PeriodEnd` is always a Sunday.
- **Duplicate prevention.** The unique index on `(UserId, TeamId, WeekYear, WeekNumber)` uses ISO week values, preventing a user from creating two reports for the same week.

---

## The Confirm-and-Submit Philosophy

Traditional weekly reporting suffers from a core problem: at the end of the week, people struggle to recall what they did. This leads to vague summaries, forgotten accomplishments, and wasted time.

Report Agent inverts this by following a "confirm-and-submit" model:

1. **Continuous data collection.** Throughout the week, data flows in automatically from Git commits, project management tools, and daily check-ins. The system knows what you did before you sit down to write.

2. **AI drafting.** The `ReportGenerationService` takes raw data and produces a structured draft. It uses business language, highlights outcomes over process, and respects the template structure.

3. **Human review and refinement.** The user reviews the AI-generated draft, makes corrections, adds context that cannot be captured from data sources, and submits.

This shifts the cognitive load from "recall and compose" to "review and confirm", producing more accurate reports in less time.

The AI generation follows strict rules (defined in the system prompt):
- Aggregate scattered commits into meaningful feature descriptions.
- Use business language, not commit messages.
- Include specific numbers, not vague qualifiers.
- Never output "no data" placeholders; merge sparse sections into related ones.
- Output must be valid JSON matching the template structure.

---

## Backend Services

For developers extending Report Agent, the key service classes are:

| Service | File | Responsibility |
|---------|------|----------------|
| `ReportGenerationService` | `Services/ReportAgent/ReportGenerationService.cs` | AI report generation (data collection -> prompt -> LLM -> parse -> save) |
| `TeamSummaryService` | `Services/ReportAgent/TeamSummaryService.cs` | AI team summary generation from submitted reports |
| `ReportNotificationService` | `Services/ReportAgent/ReportNotificationService.cs` | Notifications for submit/review/return events |
| `MapActivityCollector` | `Services/ReportAgent/MapActivityCollector.cs` | Platform activity data collection |
| `GitHubConnector` | `Services/ReportAgent/GitHubConnector.cs` | GitHub API integration |
| `SvnConnector` | `Services/ReportAgent/SvnConnector.cs` | SVN integration |
| `PersonalSourceService` | `Services/ReportAgent/PersonalSourceService.cs` | Personal data source management |
| `PersonalSourceConnectors` | `Services/ReportAgent/PersonalSourceConnectors.cs` | Connector implementations for personal sources |
| `GitSyncWorker` | `Services/ReportAgent/GitSyncWorker.cs` | Background worker for periodic git sync |
| `ReportAutoGenerateWorker` | `Services/ReportAgent/ReportAutoGenerateWorker.cs` | Background worker for auto report generation |
| `ArtifactStatsParser` | `Services/ReportAgent/ArtifactStatsParser.cs` | Parse workflow artifacts into stats |
| `WorkflowExecutionService` | `Services/ReportAgent/WorkflowExecutionService.cs` | Workflow execution for data collection |

All LLM calls go through `ILlmGateway` with `AppCallerCode` prefixed by `report-agent`.
