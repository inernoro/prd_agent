# 2026-04-28 Project Settings React Migration

## Changed

- Added React `/settings/:projectId` project settings page with general settings, project stats, branch stats, and recent activity logs.
- Added project-level GitHub settings with App status, repo binding picker, linked repo controls, auto-deploy toggle, and per-event webhook policy toggles.
- Updated project-level auto-deploy toggles to write GitHub event policy directly, so repo-only projects created from GitHub clone URLs can enable/disable push automation before installation id is known.
- Added project-level GitHub PR preview comment template editing with variable insertion and sample preview.
- Added project-level environment variable management at `/settings/:projectId#env` with add/edit/delete/search, secret masking, reveal, and copy controls.
- Added cache diagnostics in React with cacheMount status, warnings, repair, export, import, and purge confirmation controls.
- Added the project danger zone in React with protected legacy projects and a confirmation dialog before project deletion.
- Reworded CDS startup storage output so Mongo split mode reports `State store` instead of a misleading `State file`.
- Redirected `/settings.html?project=<id>` to `/settings/<id>` and updated project settings links to the semantic path.
- Fixed hash deep-link syncing so `/settings/:projectId#env` and other tabs render the matching tab even when navigating inside the same React page.
- Updated CDS migration runbook and plan docs so future agents have the current commands, validation checklist, and next migration tasks.

## Validation

- `pnpm --prefix cds/web typecheck`
- `pnpm --prefix cds/web build`
- `pnpm --prefix cds build`
- `pnpm --prefix cds exec vitest run tests/services/stack-detector.test.ts tests/routes/projects.test.ts tests/routes/github-webhook.test.ts tests/integration/multi-repo-clone.smoke.test.ts`
- `pnpm --prefix cds exec vitest run tests/routes/server-integration.test.ts tests/routes/projects.test.ts tests/routes/legacy-cleanup.test.ts tests/services/state-projects.test.ts`
- `pnpm --prefix cds exec vitest run tests/routes/server-integration.test.ts tests/routes/projects.test.ts tests/routes/comment-template.test.ts tests/services/comment-template.test.ts`
- `pnpm --prefix cds exec vitest run tests/routes/storage-mode.test.ts tests/routes/server-integration.test.ts`