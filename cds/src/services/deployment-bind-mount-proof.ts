import fs from 'node:fs';
import path from 'node:path';
import { type DeploymentStoragePlan, UnsafeDeploymentStorageError, renderStoragePlan } from './deployment-storage-plan.js';
import type { IShellExecutor } from '../types.js';

/** Trusted host dependency. Never derive this function from a request, profile or environment. */
export type BindMountInspector = (plan: DeploymentStoragePlan) => () => void;
const fail = (): never => { throw new UnsafeDeploymentStorageError('plan', 'storage-bind-identity-unconfirmed'); };
const inside = (root: string, value: string) => { const relative = path.relative(root, value); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function nativeFacts(plan: DeploymentStoragePlan): string {
  renderStoragePlan(plan);
  try {
    const facts: unknown[] = [];
    for (const mount of plan.mounts.filter(m => m.kind === 'bind')) {
      const source = path.resolve(mount.source);
      if (!mount.readOnly || source !== mount.source) fail();
      if (mount.purpose === 'source') {
        const root = mount.sourceRoot;
        if (!root || root !== path.resolve(root) || root === path.parse(root).root || !inside(root, source)) fail();
        if (!fs.lstatSync(root!).isDirectory() || fs.realpathSync(root!) !== root) fail();
      } else if (mount.serverTool !== true) fail();
      // All prefixes, including the anchor, are checked. Docker must not resolve a symlink
      // outside the accepted tree; read-only Unix sockets are not safe filesystem content.
      const parsed = path.parse(source); let current = parsed.root;
      for (const segment of source.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current, {bigint: true});
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail();
        if (current !== source && !stat.isDirectory()) fail();
        if (stat.isFile() && stat.nlink !== 1n) fail();
        facts.push([current, String(stat.dev), String(stat.ino), String(stat.mode)]);
      }
      const terminal = fs.lstatSync(source);
      if (mount.serverTool && !terminal.isFile()) fail();
      if (fs.realpathSync(source) !== source) fail();
    }
    return JSON.stringify(facts);
  } catch { return fail(); }
}

/** Deny unknown IO. This is a repeated identity fence, not a Docker/kernel path pin. */
export const nativeBindMountInspector: BindMountInspector = plan => {
  const accepted = nativeFacts(plan);
  return () => { if (nativeFacts(plan) !== accepted) fail(); };
};

/** Recheck synchronously both before dispatch and when the real worker slot starts. */
export function guardBindMountShell(shell: IShellExecutor, check: () => void): IShellExecutor {
  return {exec(command, options) {
    check();
    return shell.exec(command, {...options, beforeStart: () => { options?.beforeStart?.(); check(); }});
  }};
}
