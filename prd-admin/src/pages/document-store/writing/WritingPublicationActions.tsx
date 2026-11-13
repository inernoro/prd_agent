import { Link } from 'react-router-dom';
import { BookOpen, GraduationCap } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';

/** Explicit store context keeps token-only share readers separate from original-store access. */
export function WritingPublicationActions({ storeId, entryId, hasPublication, publicStore = false, className }: {
  storeId?: string; entryId?: string; hasPublication?: boolean; publicStore?: boolean; className?: string;
}) {
  const authenticated = useAuthStore(state => state.isAuthenticated);
  const canRead = useAuthStore(state => state.isRoot || state.permissions.includes('super') || state.permissions.includes('document-store.read'));
  if (!storeId || !entryId || !hasPublication || (authenticated ? !canRead : !publicStore)) return null;
  const base = `/document-store/${encodeURIComponent(storeId)}/write/${encodeURIComponent(entryId)}`;
  const target = (view: string) => authenticated ? `${base}/${view}` : `/login?returnUrl=${encodeURIComponent(`${base}/${view}`)}`;
  return <>
    <Link className={className} to={target('read')}><BookOpen size={13} aria-hidden="true" />{authenticated ? '分层阅读' : '登录后分层阅读'}</Link>
    <Link className={className} to={target('learn')}><GraduationCap size={13} aria-hidden="true" />{authenticated ? '开始学习' : '登录后开始学习'}</Link>
  </>;
}
