import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import JSZip from 'jszip';
import { ChevronDown, ChevronRight, Folder, FolderOpen, ExternalLink } from 'lucide-react';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { FilePreview, type DocBrowserEntry, type EntryPreview } from '@/components/file-preview';

type TreeFile = { kind: 'file'; name: string; path: string };
type TreeDir = { kind: 'dir'; name: string; path: string; children: TreeNode[] };
type TreeNode = TreeFile | TreeDir;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
};

function basename(path: string): string {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

/** Build a nested folder tree from flat zip file paths (folders first, alpha). */
function buildTree(paths: string[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  const dirMap = new Map<string, TreeDir>([['', root]]);

  const ensureDir = (dirPath: string): TreeDir => {
    if (dirMap.has(dirPath)) return dirMap.get(dirPath)!;
    const parentPath = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
    const parent = ensureDir(parentPath);
    const dir: TreeDir = { kind: 'dir', name: basename(dirPath), path: dirPath, children: [] };
    parent.children.push(dir);
    dirMap.set(dirPath, dir);
    return dir;
  };

  for (const full of paths) {
    const parts = full.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1];
    const dirPath = parts.slice(0, -1).join('/');
    const dir = ensureDir(dirPath);
    dir.children.push({ kind: 'file', name: fileName, path: full });
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.kind === 'dir') sortNodes(n.children);
    return nodes;
  };
  return sortNodes(root.children);
}

/** Pick the default file: root SKILL.md → any SKILL.md → first *.md → first file. */
function pickDefault(paths: string[], preferred: string): string | null {
  if (paths.length === 0) return null;
  const lower = preferred.toLowerCase();
  const rootExact = paths.find((p) => p.toLowerCase() === lower);
  if (rootExact) return rootExact;
  const anyExact = paths.find((p) => basename(p).toLowerCase() === lower);
  if (anyExact) return anyExact;
  const firstMd = paths.find((p) => extOf(p) === '.md' || extOf(p) === '.markdown');
  if (firstMd) return firstMd;
  return paths[0];
}

function FileRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (node.kind === 'dir') {
    const isOpen = expanded.has(node.path);
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[12px] transition-colors hover:bg-white/6"
          style={{ paddingLeft: 8 + depth * 14, color: 'var(--text-secondary)' }}
        >
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen &&
          node.children.map((c) => (
            <FileRow
              key={c.path}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
      </div>
    );
  }
  const cfg = getFileTypeConfig(node.name, '');
  const active = selectedPath === node.path;
  const Icon = cfg.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[12px] transition-colors"
      style={{
        paddingLeft: 8 + depth * 14 + 13,
        background: active ? 'var(--accent-primary, rgba(59,130,246,0.18))' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      <Icon size={13} style={{ color: active ? undefined : cfg.color, flexShrink: 0 }} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function SkillContentBrowser({
  zipUrl,
  defaultFileName = 'SKILL.md',
  sizeBytes,
}: {
  zipUrl: string;
  defaultFileName?: string;
  sizeBytes?: number;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const filesRef = useRef<Map<string, JSZip.JSZipObject>>(new Map());
  // 仅保留"当前预览"的 blob URL —— 切文件即回收上一个，避免内存堆积
  const currentUrlRef = useRef<string | null>(null);
  // 单调递增序号：解决"快速点 A 再点 B，A 的慢解压后覆盖 B"的竞态
  const loadSeqRef = useRef(0);

  const sizeHint = useMemo(() => {
    if (!sizeBytes) return '';
    const mb = sizeBytes / (1024 * 1024);
    return mb >= 1 ? `（约 ${mb.toFixed(1)} MB）` : `（约 ${Math.max(1, Math.round(sizeBytes / 1024))} KB）`;
  }, [sizeBytes]);

  const revokeUrls = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    const obj = filesRef.current.get(path);
    if (!obj) return;
    const seq = ++loadSeqRef.current;
    setSelectedPath(path);
    const name = basename(path);
    const cfg = getFileTypeConfig(name, '');
    try {
      if (cfg.preview === 'text') {
        const text = await obj.async('string');
        if (loadSeqRef.current !== seq) return; // 已被更晚的选择取代，丢弃
        revokeUrls(); // 切到文本视图：回收上一个 blob URL
        setPreview({ text, fileUrl: null, contentType: '' });
        return;
      }
      const blobRaw = await obj.async('blob');
      if (loadSeqRef.current !== seq) return;
      const mime = MIME_BY_EXT[extOf(name)] || '';
      const blob = mime ? new Blob([blobRaw], { type: mime }) : blobRaw;
      const url = URL.createObjectURL(blob);
      if (loadSeqRef.current !== seq) {
        URL.revokeObjectURL(url); // 创建后才发现已过期，立即回收
        return;
      }
      revokeUrls(); // 回收上一个文件的 blob URL，再挂当前
      currentUrlRef.current = url;
      setPreview({ text: null, fileUrl: url, contentType: mime });
    } catch {
      if (loadSeqRef.current !== seq) return;
      setPreview({ text: '> 该文件读取失败', fileUrl: null, contentType: '' });
    }
  }, [revokeUrls]);

  useEffect(() => {
    let cancelled = false;
    loadSeqRef.current++; // 让上一个 zipUrl 仍在飞的 loadFile 立即作废
    setStatus('loading');
    setError(null);
    setPreview(null);
    setSelectedPath(null);
    revokeUrls();
    filesRef.current = new Map();

    (async () => {
      try {
        const res = await fetch(zipUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const zip = await JSZip.loadAsync(blob);
        if (cancelled) return;

        const paths: string[] = [];
        zip.forEach((relPath, file) => {
          if (file.dir) return;
          if (relPath.split('/').some((seg) => seg === '__MACOSX' || seg === '.DS_Store')) return;
          paths.push(relPath);
          filesRef.current.set(relPath, file);
        });

        if (paths.length === 0) {
          setTree([]);
          setStatus('ready');
          return;
        }

        setTree(buildTree(paths));
        const def = pickDefault(paths, defaultFileName);

        // 默认展开通往选中文件的目录链
        if (def) {
          const segs = def.split('/').filter(Boolean);
          const dirChain = new Set<string>();
          let acc = '';
          for (let i = 0; i < segs.length - 1; i++) {
            acc = acc ? `${acc}/${segs[i]}` : segs[i];
            dirChain.add(acc);
          }
          setExpanded(dirChain);
        }
        setStatus('ready');
        if (def) await loadFile(def);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '解压失败');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      // 卸载/zipUrl 变更时也作废在飞的 loadFile，否则它过了 staleness 检查
      // 仍会 createObjectURL 写进 currentUrlRef，而 revokeUrls 已先执行，泄漏。
      // loadSeqRef 是普通自增计数器（非 DOM 节点 ref），cleanup 里自增即其用途。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadSeqRef.current++;
      revokeUrls();
    };
  }, [zipUrl, defaultFileName, loadFile, revokeUrls]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const syntheticEntry: DocBrowserEntry | undefined = useMemo(() => {
    if (!selectedPath) return undefined;
    return {
      id: selectedPath,
      title: basename(selectedPath),
      isFolder: false,
      sourceType: 'zip',
      contentType: preview?.contentType || '',
      fileSize: 0,
    };
  }, [selectedPath, preview]);

  return (
    <div className="flex h-full min-h-0">
      {/* 左：文件树 */}
      <div
        className="w-[260px] shrink-0 border-r py-2"
        style={{
          borderColor: 'var(--border-subtle)',
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        {status === 'loading' && <MapSectionLoader text={`正在解压技能包${sizeHint}…`} />}
        {status === 'error' && (
          <div className="px-3 py-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            无法读取文件列表
          </div>
        )}
        {status === 'ready' && tree.length === 0 && (
          <div className="px-3 py-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            该技能包为空
          </div>
        )}
        {status === 'ready' &&
          tree.map((n) => (
            <FileRow
              key={n.path}
              node={n}
              depth={0}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={toggleDir}
              onSelect={loadFile}
            />
          ))}
      </div>

      {/* 右：内容 */}
      <div
        className="flex-1 px-6 py-5"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {status === 'loading' && <MapSectionLoader text={`正在解压技能包${sizeHint}…`} />}
        {status === 'error' && (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              无法在线预览该技能包
            </p>
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {error || '下载或解压失败'}
            </p>
            <a
              href={zipUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-4 text-[12px] font-semibold transition-colors"
              style={{
                background: 'rgba(59,130,246,0.1)',
                border: '1px solid rgba(59,130,246,0.2)',
                color: 'rgba(59,130,246,0.9)',
              }}
            >
              <ExternalLink size={13} />
              在新标签打开原始 zip
            </a>
          </div>
        )}
        {status === 'ready' && tree.length === 0 && (
          <div className="py-20 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            该技能包没有可预览的文件
          </div>
        )}
        {status === 'ready' && tree.length > 0 && (
          <FilePreview entry={syntheticEntry} preview={preview} />
        )}
      </div>
    </div>
  );
}

export default SkillContentBrowser;
