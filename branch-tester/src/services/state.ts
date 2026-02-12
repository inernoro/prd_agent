import fs from 'node:fs';
import path from 'node:path';
import type { BtState, BranchEntry } from '../types.js';

function emptyState(): BtState {
  return {
    activeBranchId: null,
    history: [],
    branches: {},
    nextPortIndex: 1,
  };
}

export class StateService {
  private state: BtState = emptyState();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static slugify(branch: string): string {
    return branch
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }

  load(): void {
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.state = JSON.parse(raw) as BtState;
    } else {
      this.state = emptyState();
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getState(): Readonly<BtState> {
    return this.state;
  }

  getBranch(id: string): BranchEntry | undefined {
    return this.state.branches[id];
  }

  addBranch(entry: BranchEntry): void {
    if (this.state.branches[entry.id]) {
      throw new Error(`Branch "${entry.id}" already exists`);
    }
    this.state.branches[entry.id] = entry;
  }

  removeBranch(id: string): void {
    if (!this.state.branches[id]) {
      throw new Error(`Branch "${id}" not found`);
    }
    delete this.state.branches[id];
    if (this.state.activeBranchId === id) {
      this.state.activeBranchId = null;
    }
  }

  updateStatus(id: string, status: BranchEntry['status']): void {
    const entry = this.state.branches[id];
    if (!entry) {
      throw new Error(`Branch "${id}" not found`);
    }
    entry.status = status;
  }

  activate(id: string): void {
    if (!this.state.branches[id]) {
      throw new Error(`Branch "${id}" not found`);
    }
    this.state.activeBranchId = id;
    this.state.history.push(id);
    this.state.branches[id].lastActivatedAt = new Date().toISOString();
  }

  rollback(): string | null {
    if (this.state.history.length <= 1) {
      return null;
    }
    this.state.history.pop();
    const previousId = this.state.history[this.state.history.length - 1];
    this.state.activeBranchId = previousId;
    return previousId;
  }

  allocateDbName(id: string, defaultDbName: string): string {
    if (id === 'main' || id === 'master') {
      return defaultDbName;
    }
    const index = this.state.nextPortIndex;
    this.state.nextPortIndex++;
    return `${defaultDbName}_${index}`;
  }
}
