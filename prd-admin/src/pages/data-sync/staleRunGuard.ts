/**
 * 「这一帧是不是当前这条 Run 的」。
 *
 * 页面在历史列表与详情之间来回切时不卸载，而 useSseStream 只在**组件卸载**时 abort——
 * 换了 runId 之后，上一条 Run 的流可能还连着，它的 progress 事件会把 A 的进度画到
 * B 的地址下。换 Run 时会先 reset() 断掉那条流，但 abort 与「已经在管道里的那一帧」
 * 之间仍有窗口，所以入口这里再判一次。
 *
 * 抽成函数而不是写在回调里：页面没有 jsdom 跑不起组件，只有独立的纯函数才断言得了行为。
 */
export function shouldApplyRun(incomingRunId: string | undefined, currentRunId: string): boolean {
  // 载荷没带 runId 时不拦——拦了会把「服务端少发一个字段」变成「页面永远不更新」，
  // 那是比串号更难查的故障。真正的隔离靠 reset()，这里只是第二道。
  if (!incomingRunId) return true;
  return incomingRunId === currentRunId;
}
