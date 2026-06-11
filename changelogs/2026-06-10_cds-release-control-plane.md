feat(cds): add SSH release control plane MVP

- Add ReleaseTarget, ReleasePlan, ReleaseRun and ReleaseArtifact state models.
- Add `/api/releases/*` APIs for SSH targets, preflight checks, release logs, release runs and rollback.
- Add release center UI and branch-card release entry for running preview branches.
