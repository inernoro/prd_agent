/**
 * Authentication domain types for the CDS v4 multi-project refactor.
 *
 * These are the P2 shell types. In P2 they are backed by an in-memory
 * store (see cds/src/infra/auth-store/memory-store.ts). In P3 the store
 * is swapped out for a MongoDB-backed implementation without changing
 * any consumers — the Store interface is the stable contract.
 *
 * See doc/design.cds.multi-project.md section 七 and
 * doc/spec.cds.project-model.md sections 3 (users), 4 (sessions),
 * 5 (workspaces), 6 (workspace_members).
 */

/**
 * Which credential dimension a user authenticates through. GitHub OAuth users
 * carry `github` (the historical default); locally-provisioned username +
 * password users carry `local`. Both live in the same store and produce the
 * same session shape — the only difference is how they prove identity.
 *
 * Optional for backward compatibility: existing OAuth users persisted before
 * this field existed read as `undefined`, which callers treat as `github`.
 */
export type CdsAuthProvider = 'github' | 'local';

/** A CDS user. Sourced from GitHub OAuth, or provisioned as a local account. */
export interface CdsUser {
  /** UUID v4 string (CDS-internal ID, decoupled from GitHub's numeric ID). */
  id: string;
  /**
   * GitHub numeric ID — stable primary key from GitHub's side. Local accounts
   * have no GitHub identity; they use 0 as a sentinel (never looked up by it).
   */
  githubId: number;
  /**
   * GitHub login (username). May change; use githubId for lookups. For local
   * accounts this mirrors `username` so existing display code keeps working.
   */
  githubLogin: string;
  /**
   * Which credential dimension this account uses. Undefined on legacy OAuth
   * records → treat as 'github'.
   */
  authProvider?: CdsAuthProvider;
  /**
   * Local login handle, unique among local accounts. Undefined for OAuth-only
   * users. Lowercased on write for case-insensitive lookup.
   */
  username?: string;
  /** scrypt-derived password hash (hex). Server-side only — never returned. */
  passwordHash?: string;
  /** Per-user random salt (hex) paired with passwordHash. Server-side only. */
  passwordSalt?: string;
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

/**
 * Input shape for provisioning a local username + password account. The
 * auth-service hashes the password before handing the store a persisted
 * record — the store never sees plaintext.
 */
export interface CreateLocalUserInput {
  /** Unique local login handle. Lowercased on persist. */
  username: string;
  /** Hex scrypt hash (already computed by auth-service). */
  passwordHash: string;
  /** Hex salt paired with passwordHash. */
  passwordSalt: string;
  /** Display name; falls back to username when omitted. */
  name?: string;
  /** Optional email. */
  email?: string | null;
  /** When true the new account is flagged as the system owner. */
  isSystemOwner?: boolean;
}

/**
 * A user record safe to send to the client — strips password material and
 * other server-only fields. Used by GET /api/auth/users and /api/auth/activity.
 */
export interface PublicCdsUser {
  id: string;
  username: string | null;
  githubLogin: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  authProvider: CdsAuthProvider;
  isSystemOwner: boolean;
  status: CdsUser['status'];
  lastLoginAt: string | null;
  createdAt: string;
}

/** Project a CdsUser to its client-safe shape (drops passwordHash/Salt). */
export function toPublicUser(user: CdsUser): PublicCdsUser {
  return {
    id: user.id,
    username: user.username ?? null,
    githubLogin: user.githubLogin,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    authProvider: user.authProvider ?? 'github',
    isSystemOwner: user.isSystemOwner,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * A single user-activity / trace record. Recorded at a handful of high-value
 * touchpoints (login, logout, password change, user creation, deploy/stop,
 * publish, report create/delete) so the system owner can audit who did what.
 */
export interface UserActivityRecord {
  /** UUID v4 string. */
  id: string;
  /** The acting user's CDS id. */
  userId: string;
  /** Snapshot of the acting user's login/username at the time of the action. */
  userLogin: string;
  /** Machine-stable action key, e.g. 'login', 'branch.deploy'. */
  action: string;
  /** Optional kind of the target entity, e.g. 'branch', 'project', 'user'. */
  targetType?: string | null;
  /** Optional id of the target entity. */
  targetId?: string | null;
  /** Human-readable Chinese summary for the activity viewer. */
  summary: string;
  /** Remote IP snapshot, if available. */
  ip?: string | null;
  /** ISO timestamp when the action happened. */
  at: string;
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
