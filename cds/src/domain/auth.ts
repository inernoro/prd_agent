/**
 * Authentication domain types for the CDS v4 multi-project refactor.
 *
 * These are the P2 shell types. In P2 they are backed by an in-memory
 * store (see cds/src/infra/auth-store/memory-store.ts). In P3 the store
 * is swapped out for a MongoDB-backed implementation without changing
 * any consumers — the Store interface is the stable contract.
 *
 * See doc/design.cds-multi-project.md section 七 and
 * doc/spec.cds-project-model.md sections 3 (users), 4 (sessions),
 * 5 (workspaces), 6 (workspace_members).
 */

/** A CDS user, sourced from GitHub OAuth. */
export interface CdsUser {
  /** UUID v4 string (CDS-internal ID, decoupled from GitHub's numeric ID). */
  id: string;
  /** GitHub numeric ID — stable primary key from GitHub's side. */
  githubId: number;
  /** GitHub login (username). May change; use githubId for lookups. */
  githubLogin: string;
  /** Primary email from GitHub, may be null if user hides it. */
  email: string | null;
  /** Display name (GitHub profile name), fallback to githubLogin. */
  name: string;
  /** GitHub avatar URL. */
  avatarUrl: string | null;
  /**
   * Snapshot of GitHub organisations the user belonged to at most recent
   * login/refresh. Used for access control against CDS_ALLOWED_ORGS.
   */
  orgs: string[];
  /** ISO timestamp when `orgs` was last refreshed. */
  orgsCheckedAt: string;
  /**
   * Whether this user is the "system owner" — the first OAuth'd user who
   * triggered the bootstrap flow. They automatically receive a personal
   * workspace and the legacy project is transferred to them.
   */
  isSystemOwner: boolean;
  /** User account status. */
  status: 'active' | 'disabled';
  /** ISO timestamp of most recent successful login. */
  lastLoginAt: string | null;
  /** ISO timestamp of first registration. */
  createdAt: string;
  /** ISO timestamp of most recent record mutation. */
  updatedAt: string;
}

/** An active login session, keyed by opaque token. */
export interface CdsSession {
  /** Opaque 64-char URL-safe token (crypto.randomBytes(48).toString('base64url')). */
  token: string;
  /** The owning user's CDS id (see CdsUser.id). */
  userId: string;
  /** ISO timestamp when the session was created. */
  createdAt: string;
  /** ISO timestamp when the session expires (TTL in P2, mongo TTL index in P3). */
  expiresAt: string;
  /** Last time this session made a request. */
  lastSeenAt: string;
  /** Last time orgs were refreshed against GitHub for this session. */
  orgsCheckedAt: string;
  /** Optional User-Agent snapshot for audit. */
  userAgent: string | null;
  /** Optional remote IP snapshot for audit. */
  ipAddress: string | null;
}

/**
 * A project-grouping container owned by one user (personal) or a GitHub
 * organisation (team). Workspaces hold projects. In P2 we only create
 * personal workspaces during first-login bootstrap; team support lands
 * in P5.
 */
export interface CdsWorkspace {
  /** UUID v4 string. */
  id: string;
  /** URL-friendly unique identifier. */
  slug: string;
  /** Display name. */
  name: string;
  kind: 'personal' | 'team';
  /** The user id of the workspace owner. */
  ownerId: string;
  /** GitHub org login when kind === 'team'. */
  githubOrgLogin: string | null;
  /** GitHub org numeric id when kind === 'team'. */
  githubOrgId: number | null;
  /** Optional description. */
  description: string | null;
  /** Cached project count for the list view. */
  projectCount: number;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
}

/**
 * Input shape for creating a new user during first-login bootstrap.
 * Consumers pass this to AuthStore.upsertUser() rather than building a
 * full CdsUser by hand.
 */
export interface UpsertUserInput {
  githubId: number;
  githubLogin: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  orgs: string[];
}

// ── P5: Team Workspace types ──────────────────────────────────────────────────

/**
 * A member record linking a CDS user to a workspace.
 * Owners are always listed here (syncSource='manual', role='owner').
 * GitHub-Org-sync'd members have syncSource='github-org'.
 */
export interface CdsWorkspaceMember {
  /** UUID v4 string. */
  id: string;
  workspaceId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  /** How this membership was established. */
  syncSource: 'manual' | 'github-org';
  /** ISO timestamp when the member was added. */
  addedAt: string;
  /** The user id who added this member (null for system-bootstrapped owner). */
  addedByUserId: string | null;
  /** ISO timestamp of most recent role update. */
  updatedAt: string;
}

/**
 * An invitation for a GitHub user to join a team workspace.
 * Keyed by an opaque token that the invitee presents to accept.
 */
export interface CdsWorkspaceInvite {
  /** UUID v4 string. */
  id: string;
  workspaceId: string;
  /** Target GitHub login — verified against the accepting user's GitHub account. */
  githubLogin: string;
  /** Opaque invite token (URL-safe base64). */
  token: string;
  role: 'admin' | 'member';
  invitedByUserId: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp when the invite expires. */
  expiresAt: string;
  /** ISO timestamp set when the invite is accepted; null = pending. */
  acceptedAt: string | null;
}
