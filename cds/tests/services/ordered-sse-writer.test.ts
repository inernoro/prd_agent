import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { OrderedSseWriter } from '../../src/services/ordered-sse-writer.js';
class Peer extends EventEmitter { writableLength = 0; write = vi.fn(() => true); destroy = vi.fn(() => { this.emit('close'); }); }
afterEach(() => vi.useRealTimers());
it('preserves all queued mixed frames over partial drains without resending accepted frames', () => {
  const peer = new Peer(); peer.write.mockReturnValueOnce(false).mockReturnValueOnce(false);
  const writer = new OrderedSseWriter(peer, () => {}); writer.send(() => 'start'); writer.send(() => 'step'); writer.send(() => 'terminal');
  expect(peer.write.mock.calls.map(call => call[0])).toEqual(['start']);
  peer.emit('drain'); expect(peer.write.mock.calls.map(call => call[0])).toEqual(['start', 'step']);
  peer.emit('drain'); expect(peer.write.mock.calls.map(call => call[0])).toEqual(['start', 'step', 'terminal']); writer.close();
});
it('suppresses blocked heartbeat factories without consuming observation slots', () => {
  const peer = new Peer(); peer.write.mockReturnValueOnce(false); const writer = new OrderedSseWriter(peer, () => {});
  writer.send(() => 'start'); const heartbeat = vi.fn(() => 'heartbeat');
  for (let i = 0; i < 1000; i++) expect(writer.send(heartbeat, true)).toBe(true);
  expect(heartbeat).not.toHaveBeenCalled(); writer.send(() => 'completed'); peer.emit('drain');
  expect(peer.write.mock.calls.map(call => call[0])).toEqual(['start', 'completed']); writer.close();
});
it('bounds the queue to 64 before evaluating the 65th payload and cleans once', () => {
  const peer = new Peer(); peer.write.mockReturnValueOnce(false); const cleanup = vi.fn(), writer = new OrderedSseWriter(peer, cleanup);
  writer.send(() => 'start'); for (let i = 0; i < 64; i++) expect(writer.send(() => String(i))).toBe(true);
  const factory = vi.fn(() => 'overflow'); expect(writer.send(factory)).toBe(false); expect(factory).not.toHaveBeenCalled();
  expect(peer.destroy).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1); expect(peer.eventNames()).toEqual([]);
  peer.emit('drain'); expect(writer.send(() => 'late')).toBe(false); writer.close(); expect(cleanup).toHaveBeenCalledTimes(1);
});
it('counts waiting frames and native socket bytes together', () => {
  const peer = new Peer(); peer.write.mockReturnValueOnce(false); const writer = new OrderedSseWriter(peer, () => {});
  writer.send(() => 'start'); expect(writer.send(() => 'a'.repeat(200 * 1024))).toBe(true);
  peer.writableLength = 200 * 1024; expect(writer.send(() => 'b'.repeat(120 * 1024))).toBe(false);
  expect(peer.write).toHaveBeenCalledTimes(1); expect(peer.destroy).toHaveBeenCalledTimes(1);
});
it('uses UTF-8 byte limits rather than JS string length', () => {
  const peer = new Peer(), writer = new OrderedSseWriter(peer, () => {});
  expect(writer.send(() => '中'.repeat(90000))).toBe(false); expect(peer.write).not.toHaveBeenCalled();
});
it('freezes queued frames when they are observed, even if their input later changes', () => {
  const peer = new Peer(); peer.write.mockReturnValueOnce(false); const writer = new OrderedSseWriter(peer, () => {});
  writer.send(() => 'start'); const payload = { value: 'observed' }; writer.send(() => JSON.stringify(payload)); payload.value = 'later';
  peer.emit('drain'); expect(peer.write).toHaveBeenLastCalledWith('{"value":"observed"}'); writer.close();
});
it('does not extend the five-second deadline for an endless sequence of later observations', () => {
  vi.useFakeTimers(); const peer = new Peer(); peer.write.mockReturnValueOnce(false); const writer = new OrderedSseWriter(peer, () => {});
  writer.send(() => 'start'); for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(1000); writer.send(() => 'later'); }
  vi.advanceTimersByTime(999); expect(peer.destroy).not.toHaveBeenCalled(); vi.advanceTimersByTime(1); expect(peer.destroy).toHaveBeenCalledTimes(1);
});
it('starts a fresh deadline after real drain progress and another blocked write', () => {
  vi.useFakeTimers(); const peer = new Peer(); peer.write.mockReturnValue(false); const writer = new OrderedSseWriter(peer, () => {});
  writer.send(() => 'start'); writer.send(() => 'next'); vi.advanceTimersByTime(4000); peer.emit('drain'); vi.advanceTimersByTime(4999);
  expect(peer.destroy).not.toHaveBeenCalled(); vi.advanceTimersByTime(1); expect(peer.destroy).toHaveBeenCalledTimes(1);
});
it('cancels timers and releases the queue on ordinary disconnect without destroying again', () => {
  vi.useFakeTimers(); const peer = new Peer(); peer.write.mockReturnValue(false); const cleanup = vi.fn(), writer = new OrderedSseWriter(peer, cleanup);
  writer.send(() => 'start'); writer.send(() => 'next'); peer.emit('close'); vi.advanceTimersByTime(6000);
  expect(peer.destroy).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(1); expect(peer.eventNames()).toEqual([]);
});
it.each(['serialization', 'write', 'drain'])('isolates %s errors and cleanup failure from the publisher', kind => {
  const peer = new Peer(), writer = new OrderedSseWriter(peer, () => { throw new Error('cleanup'); });
  if (kind === 'serialization') expect(writer.send(() => { throw new Error('private'); })).toBe(false);
  if (kind === 'write') { peer.write.mockImplementationOnce(() => { throw new Error('write'); }); expect(writer.send(() => 'first')).toBe(false); }
  if (kind === 'drain') { peer.write.mockReturnValueOnce(false); writer.send(() => 'first'); writer.send(() => 'queued'); peer.write.mockImplementationOnce(() => { throw new Error('drain'); }); expect(() => peer.emit('drain')).not.toThrow(); }
  expect(peer.destroy).toHaveBeenCalledTimes(1); expect(peer.eventNames()).toEqual([]);
});
