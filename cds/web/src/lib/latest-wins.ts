/**
 * 「最新的赢」闸门：决定一次异步响应还能不能贴到界面上。
 *
 * 抽出来是为了**能被真正测到**（Codex P2，核对属实）。原先这套取舍散在
 * `loadSeries` 里，守卫只能扫源码字符串——而扫字符串证明不了行为：把
 * 「记账」挪到请求之前、其余一字不改，每个响应都会被丢弃，那种守卫照样全绿。
 *
 * 三条语义，缺一不可：
 *   1. 晚回的**更旧**响应不许覆盖已经贴上去的更新响应（图往回跳）；
 *   2. 慢、但仍是目前最新的响应**必须**能贴——判据是「比已贴的新」，不是
 *      「等于最后发出的那个」。后者在「每次请求都超过轮询间隔」时会把自己
 *      饿死：下一轮总在上一轮回来前把序号推走，于是永远没有响应能贴；
 *   3. 换目标（如换分支）后开新会话，在飞的旧请求一律作废——**且序号全局单调**。
 *      重置序号会让旧请求的序号反超新会话，它不但能贴陈数据，还会把水位抬高
 *      到吃掉后面好几轮。
 */
export interface LatestWinsTicket {
  readonly seq: number;
  readonly session: number;
}

export interface LatestWinsGate {
  /** 换目标：作废在飞的旧请求，清空水位。序号不重置。 */
  newSession(): void;
  /** 发起一次请求，领一张票。 */
  begin(): LatestWinsTicket;
  /** 这张票的响应还能不能贴？能则记账并返回 true。 */
  accept(ticket: LatestWinsTicket): boolean;
}

export function createLatestWinsGate(): LatestWinsGate {
  let seq = 0;
  let session = 0;
  let applied = 0;
  return {
    newSession() {
      session += 1;
      applied = 0;
    },
    begin() {
      seq += 1;
      return { seq, session };
    },
    accept(ticket) {
      if (ticket.session !== session) return false;
      if (ticket.seq <= applied) return false;
      applied = ticket.seq;
      return true;
    },
  };
}
