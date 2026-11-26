import { createContext } from 'react';
import type { ApprovalCapabilities } from '@/hooks/approvalPolling';

export type ShellAuthStatus = {
  approvalCapabilities?: ApprovalCapabilities;
  previewAccessNotices?: boolean;
  designReviewNotices?: boolean;
  accountApprovalNotices?: boolean;
  enabled?: boolean;
  canUsePasskeys?: boolean;
  mode?: string;
  activeProvider?: string | null;
  logoutEndpoint?: string | null;
  postLogoutRedirect?: string | null;
  user?: ShellUser | null;
};

export type ShellUser = {
  id?: string | null;
  authProvider?: string | null;
  username?: string | null;
  githubLogin?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  isSystemOwner?: boolean;
  role?: 'owner' | 'admin' | 'member';
};

export const ConsoleAuthContext = createContext<{
  status: ShellAuthStatus | null;
  pending: boolean;
  retry: () => void;
}>({ status: null, pending: true, retry: () => {} });
