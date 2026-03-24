import { useState, useEffect, useMemo } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Download } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';

const GITHUB_REPO = 'inernoro/prd_agent';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CACHE_KEY = 'prd_agent_latest_release';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

type Platform = 'windows' | 'macos' | 'linux' | 'unknown';

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseInfo {
  version: string;
  assets: ReleaseAsset[];
}

interface CachedRelease {
  data: ReleaseInfo;
  timestamp: number;
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

function getCachedRelease(): ReleaseInfo | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedRelease = JSON.parse(raw);
    if (Date.now() - cached.timestamp > CACHE_TTL) {
      sessionStorage.removeItem(CACHE_KEY);
      return null;
    }
    return cached.data;
  } catch {
    return null;
  }
}

function setCachedRelease(data: ReleaseInfo): void {
  try {
    const cached: CachedRelease = { data, timestamp: Date.now() };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch { /* quota exceeded — ignore */ }
}

function findAsset(assets: ReleaseAsset[], pattern: RegExp): ReleaseAsset | undefined {
  return assets.find((a) => pattern.test(a.name));
}

const platformDefs = [
  {
    key: 'windows' as Platform,
    label: 'Windows',
    desc: 'Windows 10+',
    assetPattern: /x64-setup\.exe$/i,
    icon: (
      <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 12V6.75l6-1.32v6.48L3 12zm6.25.13l8.25-.02V5.1L9.25 6.27v5.86zM3 13l6 .09v6.81l-6-1.32V13zm6.25-.02l8.25.02v7.47l-8.25-1.17v-6.32z" />
      </svg>
    ),
  },
  {
    key: 'macos' as Platform,
    label: 'macOS',
    desc: 'macOS 11+ (Apple Silicon)',
    assetPattern: /aarch64\.dmg$/i,
    icon: (
      <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    ),
  },
  {
    key: 'linux' as Platform,
    label: 'Linux',
    desc: 'Ubuntu / Debian (.deb)',
    assetPattern: /amd64\.deb$/i,
    icon: (
      <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.868.065 1.322-.28 1.335-.664.008-.135-.09-.27-.166-.39-.296-.469-.32-.614-.37-.737a.416.416 0 01-.015-.042c-.017-.04-.026-.072-.034-.118-.009-.053-.014-.116-.014-.192 0-.152.023-.357.068-.591.235-.92.37-1.424.177-1.83-.068-.144-.196-.252-.357-.321a2.33 2.33 0 00-.025-.334c-.104-.878-.794-1.467-1.356-1.8-.233-.133-.473-.237-.661-.333l-.018-.032c-.26-.476-.512-.984-.735-1.426-.192-.393-.368-.736-.496-.98-.348-.672-.605-1.136-.832-1.486-.24-.367-.404-.556-.542-.62a.24.24 0 00-.062-.023c.145-.428.396-1.37.36-2.563.021-.137.054-.27.075-.4.02-.131.033-.261.033-.389 0-.381-.075-.748-.21-1.074-.134-.325-.327-.602-.6-.833-.397-.34-.89-.523-1.407-.596a4.476 4.476 0 00-1.27 0z" />
      </svg>
    ),
  },
];

interface DesktopDownloadDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function DesktopDownloadDialog({ open, onOpenChange }: DesktopDownloadDialogProps) {
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    if (!open) return;

    const cached = getCachedRelease();
    if (cached) {
      setRelease(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;
    fetch(GITHUB_API_LATEST)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        if (cancelled) return;
        const version = (data.tag_name as string)?.replace(/^v/, '') ?? '';
        const assets: ReleaseAsset[] = (data.assets ?? []).map((a: { name: string; browser_download_url: string }) => ({
          name: a.name,
          browser_download_url: a.browser_download_url,
        }));
        const info: ReleaseInfo = { version, assets };
        setRelease(info);
        setCachedRelease(info);
      })
      .catch(() => { /* silently fail */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const macIntelAsset = useMemo(
    () => release ? findAsset(release.assets, /x64\.dmg$/i) : undefined,
    [release],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="下载 PRD Agent 桌面版"
      description={release ? `v${release.version} · 原生桌面体验，更快响应速度` : '原生桌面体验，更快响应速度'}
      maxWidth={640}
      content={
        <div className="space-y-5">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            该功能在桌面版中体验更佳，请下载安装 PRD Agent 桌面客户端。
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <MapSpinner size={20} color="var(--text-muted)" />
              <span className="ml-2 text-sm" style={{ color: 'var(--text-muted)' }}>获取最新版本...</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                {platformDefs.map((p) => {
                  const isDetected = p.key === platform;
                  const asset = release ? findAsset(release.assets, p.assetPattern) : undefined;
                  const href = asset?.browser_download_url ?? GITHUB_RELEASES_URL;
                  const isDirectDownload = !!asset;

                  return (
                    <a
                      key={p.key}
                      href={href}
                      {...(isDirectDownload ? { download: asset!.name } : { target: '_blank', rel: 'noopener noreferrer' })}
                      className="relative flex flex-col items-center gap-2 p-4 rounded-xl border transition-all hover:scale-[1.02] active:scale-[0.98] no-underline cursor-pointer"
                      style={{
                        borderColor: isDetected ? 'rgba(99, 102, 241, 0.4)' : 'var(--border-primary)',
                        background: isDetected ? 'rgba(99, 102, 241, 0.08)' : 'var(--bg-input)',
                      }}
                    >
                      {isDetected && (
                        <div
                          className="absolute -top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[9px] font-medium"
                          style={{ background: 'rgba(99, 102, 241, 0.2)', color: 'rgb(129, 140, 248)', border: '1px solid rgba(99, 102, 241, 0.3)' }}
                        >
                          当前系统
                        </div>
                      )}
                      <span style={{ color: isDetected ? 'rgb(129, 140, 248)' : 'var(--text-secondary)' }}>{p.icon}</span>
                      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{p.label}</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{p.desc}</span>
                      <span className="flex items-center gap-1 text-[10px] text-center leading-tight whitespace-nowrap overflow-hidden text-ellipsis max-w-full" style={{ color: 'var(--text-muted)' }}>
                        <Download size={10} className="shrink-0" />
                        <span className="truncate">{asset ? asset.name : '下载安装包'}</span>
                      </span>
                    </a>
                  );
                })}
              </div>

              {macIntelAsset && (
                <div className="text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  macOS Intel 用户请下载{' '}
                  <a
                    href={macIntelAsset.browser_download_url}
                    download={macIntelAsset.name}
                    className="underline underline-offset-2"
                    style={{ color: 'var(--accent-primary)' }}
                  >
                    x64 版本
                  </a>
                </div>
              )}
            </>
          )}

          <div className="flex items-center justify-between pt-1">
            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs hover:underline"
              style={{ color: 'var(--accent-primary)' }}
            >
              查看所有版本
            </a>
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        </div>
      }
    />
  );
}
