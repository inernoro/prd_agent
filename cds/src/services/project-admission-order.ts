/** 各合格项目按最近一次准入轮转，同项目按排队顺序；资源不足项目不挡住其他项目。 */
export class ProjectAdmissionOrder {
  private clock = 0;
  private readonly admitted = new Map<string, number>();

  next<T>(queue: readonly T[], project: (item: T) => string | undefined,
    eligible: (item: T) => boolean = () => true): number {
    const seen = new Set<string>();
    let selected = -1, earliest = Infinity;
    for (let index = 0; index < queue.length; index++) {
      const key = project(queue[index]) || '_unknown';
      if (seen.has(key)) continue;
      seen.add(key);
      if (!eligible(queue[index])) continue;
      const last = this.admitted.get(key) || 0;
      if (last < earliest) { earliest = last; selected = index; }
    }
    return selected;
  }

  grant(project?: string): void { this.admitted.set(project || '_unknown', ++this.clock); }
  clear(): void { this.admitted.clear(); this.clock = 0; }
}
