/** 各合格项目按最近一次准入轮转，同项目按排队顺序；资源不足项目不挡住其他项目。 */
export class ProjectAdmissionOrder {
  private clock = 0;
  private readonly admitted = new Map<string, number>();

  next<T>(queue: readonly T[], project: (item: T) => string | undefined,
    eligible: (item: T) => boolean = () => true): number {
    const seen = new Set<string>();
    const qualified = new Set<string>();
    let selected = -1, earliest = Infinity;
    for (let index = 0; index < queue.length; index++) {
      const key = project(queue[index]) || '_unknown';
      if (seen.has(key)) continue;
      seen.add(key);
      if (!eligible(queue[index])) continue;
      qualified.add(key);
      // 首次/重新合格只补当前一轮信用；保留先让另一项目推进，不能拿永久零信用插队。
      if (!this.admitted.has(key)) this.admitted.set(key, Math.max(0, this.clock - 1));
      const last = this.admitted.get(key)!;
      if (last < earliest) { earliest = last; selected = index; }
    }
    // 离开合格队列后旧信用失效，回归项目与新到项目遵守同一进入规则。
    for (const key of this.admitted.keys()) if (!qualified.has(key)) this.admitted.delete(key);
    return selected;
  }

  grant(project?: string): void { this.admitted.set(project || '_unknown', ++this.clock); }
  clear(): void { this.admitted.clear(); this.clock = 0; }
}
