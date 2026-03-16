# Report Agent (周报管理) User Guide

Welcome to Report Agent, the weekly report management system. This guide covers everything you need to start writing, submitting, and reviewing weekly reports for your team.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Team Management](#team-management)
3. [Daily Check-in (每日打点)](#daily-check-in)
4. [Writing Your Weekly Report](#writing-your-weekly-report)
5. [AI-Powered Report Generation](#ai-powered-report-generation)
6. [Reviewing Reports (For Leaders)](#reviewing-reports)
7. [Team Dashboard](#team-dashboard)
8. [Data Sources](#data-sources)
9. [Templates](#templates)
10. [Trends and Statistics](#trends-and-statistics)
11. [Comments](#comments)
12. [Export](#export)
13. [Permissions Reference](#permissions-reference)
14. [FAQ](#faq)

---

## Quick Start

Follow these steps to submit your first weekly report:

1. Open the Report Agent page from the left sidebar
2. Select your team (or ask your team leader to add you to a team)
3. Click "Create Report" for the current week
4. Fill in each section of the report
5. Click "Submit"

Your team leader will review the report and either mark it as reviewed or return it with feedback.

---

## Team Management

Teams are the core organizational unit. Each team has a leader, optional deputy leaders, and members.

### Roles

| Role | Description |
|------|-------------|
| **Leader** | Creates the team, manages members, reviews reports, views team dashboard |
| **Deputy** | Same review and dashboard privileges as the leader |
| **Member** | Writes and submits weekly reports |

### Creating a Team

*Requires `team.manage` permission.*

1. Go to the **Teams** tab
2. Click **Create Team**
3. Fill in the team name, description, and select a leader
4. Configure optional settings:
   - **Report Visibility** -- Choose between "All Members" (team members can see each other's reports) or "Leaders Only" (only leader/deputy can view member reports)
   - **Auto-Submit Schedule** -- Set a day and time (e.g., Friday 18:00) for automatic submission of draft reports
   - **Custom Daily Log Tags** -- Define team-specific tags for the daily check-in system
5. Click **Save**

### Adding Members

1. Open the team detail page
2. Click **Add Member**
3. Search for a user, assign their role (member / leader / deputy), and optionally set a job title
4. Click **Confirm**

### Identity Mappings

Each member can map their identity across external platforms (GitHub, GitLab, TAPD, Yuque). This allows the system to automatically attribute commits and activities to the correct person.

1. Open the team detail page
2. Click the edit icon next to a member
3. Under **Identity Mappings**, enter the member's username or email for each platform
4. Click **Save**

---

## Daily Check-in

The daily check-in system lets you record what you worked on each day. These entries are later used by AI to auto-generate parts of your weekly report.

### How to Log Your Daily Work

1. Go to the **Daily Log** panel (accessible from the report page)
2. Select today's date (one log per day)
3. Add items with the following fields:
   - **Content** -- A short description of what you did
   - **Category** -- Choose from 6 built-in categories:
     - Development
     - Meeting
     - Communication
     - Documentation
     - Testing
     - Other
   - **Tags** -- Optional custom tags (defined at the team level)
   - **Duration** -- Optional time spent in minutes
4. Click **Save**

You can edit or delete a day's log at any time before the weekly report is submitted.

**Tip:** Log your work at the end of each day. This makes weekly report generation much more accurate and saves you time on Friday.

---

## Writing Your Weekly Report

### Creating a Report

1. Go to the **My Reports** section
2. Click **Create Report**
3. Select your team and the template to use
4. The system auto-selects the current ISO week (Monday to Sunday). You can also create reports for past weeks if needed.

### Filling In Sections

Each report is divided into sections defined by the template. Sections use one of four input types:

| Input Type | Description | Example Use |
|------------|-------------|-------------|
| **Bullet List** | A list of text items | "This Week's Accomplishments", "Next Week's Plan" |
| **Rich Text** | Free-form text paragraph | "Notes", "Remarks" |
| **Key-Value** | Label-value pairs for statistics | "Code Output" (Commits: 15, PRs Merged: 3) |
| **Progress Table** | Structured progress tracking | Task completion status |

Some sections are marked as **required** -- you must fill these in before submitting.

### Section Types (v2.0)

Templates may also define how section content is sourced:

- **Auto Stats** -- Read-only statistics pulled from connected data sources (commits, PRs, docs)
- **Auto List** -- AI-generated bullet points based on collected data (you can edit them)
- **Manual List** -- You must fill these in by hand
- **Free Text** -- Open text area for anything else

### Report Lifecycle

Reports move through these states:

```
Draft --> Submitted --> Reviewed
                   \-> Returned --> Draft (edit and resubmit)
```

| Status | Meaning |
|--------|---------|
| **Not Started** | No report created yet for this week |
| **Draft** | Report created but not yet submitted |
| **Submitted** | Sent to the team leader for review |
| **Reviewed** | Leader has approved the report |
| **Returned** | Leader returned the report with feedback -- edit and resubmit |
| **Viewed** | Leader has seen the report (simplified v2.0 flow) |
| **Vacation** | Member is on vacation for this week |

### Saving and Submitting

- Click **Save** at any time to save your draft without submitting
- Click **Submit** when your report is ready for review
- After submission, you cannot edit the report unless it is returned

---

## AI-Powered Report Generation

If your team has data sources configured and you have been logging daily check-ins, you can use AI to generate report content automatically.

1. Open your draft report
2. Click **AI Generate**
3. The system collects data from your connected sources (GitHub commits, daily logs, etc.) and fills in the auto-generated sections
4. Review and edit the generated content as needed
5. Submit when satisfied

The AI will populate:
- **Auto Stats sections** with numerical data (commit counts, PR merges, etc.)
- **Auto List sections** with summarized bullet points of your work

Manual sections are left for you to fill in by hand.

---

## Reviewing Reports

*For team leaders and deputy leaders.*

### Reviewing a Single Report

1. Open the **Team Dashboard**
2. Click on a member's submitted report
3. Read through each section
4. Choose one of:
   - **Review (Approve)** -- Marks the report as reviewed
   - **Return** -- Sends the report back to the member with a reason for revision

### Plan Comparison

When reviewing a report, you can use the **Plan Comparison** feature to compare last week's "Next Week's Plan" with this week's "This Week's Accomplishments." This helps assess whether planned work was completed.

1. Open a submitted report
2. Click **Plan Comparison**
3. The system shows a side-by-side view of last week's plan vs. this week's actual output

### Team Summary

Generate an AI-powered summary of the entire team's weekly output:

1. Go to the **Team Dashboard**
2. Select the week
3. Click **Generate Team Summary**
4. The AI reads all submitted reports and produces a consolidated summary
5. Export the summary to Markdown if needed

---

## Team Dashboard

*Available to leaders, deputies, and users with `view.all` permission.*

The Team Dashboard provides an overview of the team's reporting status for any given week:

- **Submission Stats** -- Total members, submitted, reviewed, draft, not started
- **Member List** -- Each member's report status, submission time, and quick link to their report
- **Week Selector** -- Navigate between weeks to view historical data

---

## Data Sources

Data sources connect external platforms to the Report Agent, enabling automatic data collection for AI-generated reports.

### Supported Source Types

- **Git** -- GitHub, GitLab repositories
- **SVN** -- Subversion repositories

### Setting Up a Data Source (Team Level)

*Requires `datasource.manage` permission.*

1. Go to the **Data Sources** section under team settings
2. Click **Add Data Source**
3. Fill in:
   - **Name** -- A display name (e.g., "Main Backend Repo")
   - **Source Type** -- Git or SVN
   - **Repository URL** -- The clone URL of the repository
   - **Access Token** -- A personal access token with read permissions (stored encrypted)
   - **Branch Filter** -- Optional, e.g., `main,develop,release/*`
   - **Poll Interval** -- How often to sync, in minutes (default: 60)
   - **User Mapping** -- Map git author emails to system user IDs
4. Click **Save**
5. Click **Test Connection** to verify the setup
6. Click **Sync** to pull initial data

### Personal Data Sources

Individual members can also configure their own data sources under **My Sources**. These are private and used only for their own report generation.

### Viewing Commits

After syncing, you can view collected commits for a data source by clicking **View Commits**. This shows the commit history attributed to team members based on the user mapping.

---

## Templates

Templates define the structure of weekly reports. Each template contains ordered sections with specific input types.

### System Templates

Three built-in templates are available:

| Template | Best For | Sections |
|----------|----------|----------|
| **Dev General** (default) | Software engineers | Code Output, Task Output, This Week's Work, Daily Work, Next Week's Plan, Notes |
| **Product General** | Product managers | Requirement Progress, Documentation Output, This Week's Work, Daily Work, Next Week's Plan |
| **Minimal** | Anyone | Weekly Output (stats), Notes |

### Creating a Custom Template

*Requires `template.manage` permission.*

1. Go to the **Templates** tab
2. Click **Create Template**
3. Enter a name and description
4. Add sections, configuring for each:
   - Title and description (fill-in hint for the user)
   - Input type (Bullet List / Rich Text / Key-Value / Progress Table)
   - Section type (Auto Stats / Auto List / Manual List / Free Text)
   - Whether it is required
   - Max items limit (optional)
   - Linked data sources (optional, for auto-generated sections)
5. Optionally bind the template to a specific team or job title
6. Click **Save**

### Seeding System Templates

If system templates are missing (e.g., on a fresh installation), an admin can click **Seed Templates** to create the three built-in templates.

---

## Trends and Statistics

### Personal Trends

View your own 12-week trend data:

1. Go to **My Stats** or the **Trends** panel
2. See weekly metrics over the past 12 weeks, including report completion and data source activity

### Team Trends

*For leaders and deputies.*

1. Open the **Team Stats** panel
2. Select your team
3. View aggregated 12-week trends for submission rates, review turnaround, and team output

---

## Comments

The comment system supports section-level discussions on reports.

### Adding a Comment

1. Open a report
2. Navigate to a specific section
3. Click the comment icon next to the section title
4. Type your comment and click **Post**

### Replying to Comments

- Click **Reply** on any existing comment to create a threaded response
- Comments are tied to the section they were created on (tracked by section index)

### Deleting a Comment

- You can delete your own comments by clicking the delete icon

---

## Export

### Export Report to Markdown

1. Open a report
2. Click **Export** or **Export to Markdown**
3. A Markdown file is generated containing all sections and their content

### Export Team Summary to Markdown

1. Go to the **Team Dashboard**
2. Open the team summary for a specific week
3. Click **Export to Markdown**

---

## Vacation Management

Leaders and deputies can mark team members as on vacation for specific weeks:

1. Open the **Team Dashboard**
2. Click on a member who will be absent
3. Select **Mark as Vacation** and specify the week range
4. The member's report status will show as "Vacation" for those weeks

To remove a vacation marker, click **Remove Vacation** on the member's entry.

---

## Permissions Reference

| Permission | Code | Who Needs It |
|------------|------|-------------|
| **Basic Usage** | `report-agent.use` | All users who need to access Report Agent |
| **Template Management** | `report-agent.template.manage` | Admins who create/edit report templates |
| **Team Management** | `report-agent.team.manage` | Admins who create teams and manage membership |
| **Data Source Management** | `report-agent.datasource.manage` | Admins who configure Git/SVN repository connections |
| **View All** | `report-agent.view.all` | Admins who need to see all teams' reports regardless of membership |

Most regular users only need `report-agent.use`. Team leaders gain review privileges through their role within the team, not through separate permissions.

---

## FAQ

**Q: I cannot see any teams on the Report Agent page.**
A: You need to be added to a team by a team leader or admin. Contact your team leader to be added as a member.

**Q: Can I edit a report after submitting it?**
A: No. Once submitted, a report is locked. If changes are needed, ask your team leader to return the report, which moves it back to draft status for editing.

**Q: What happens if I miss the weekly deadline?**
A: If your team has auto-submit enabled, any draft report will be automatically submitted at the configured time (e.g., Friday 18:00). If no report exists, your status shows as "Not Started."

**Q: How does AI generation work if I have no data sources?**
A: AI generation uses whatever data is available. If you have no external data sources connected, it relies on your daily check-in logs. If you have neither, the AI will have limited data to work with, and you should fill in the report manually.

**Q: Can I belong to multiple teams?**
A: Yes. You can be a member of multiple teams and submit separate weekly reports for each.

**Q: Who can see my weekly report?**
A: This depends on the team's visibility setting. If set to "All Members," all team members can view each other's reports. If set to "Leaders Only," only the leader and deputies can see your report. Users with the `view.all` permission can always see all reports.

**Q: What is the difference between "Reviewed" and "Viewed"?**
A: "Reviewed" means the leader actively approved the report. "Viewed" (v2.0 simplified flow) means the leader has opened and seen the report. Teams can choose which flow to use.

**Q: How do I set up identity mappings?**
A: Go to your team's detail page. Your leader can edit your member profile to add mappings for GitHub, GitLab, TAPD, and Yuque usernames. This links your external platform activity to your system account.
