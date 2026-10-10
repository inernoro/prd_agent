import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedSseWriter } from '../../src/services/bounded-sse-writer.js';

class Peer extends EventEmitter {
  writableLength = 0;
  write = vi.fn(() => true);
  destroy = vi.fn(() => { this.emit('close'); });
}

describe('bounded branch state stream writer', () => {
  afterEach(() => vi.useRealTimers());
  it('never evaluates twenty blocked event factories and recovers from current snapshot once', () => {
    const peer = new Peer();
    peer.write.mockReturnValueOnce(false);
    let state = 'first';
    const snapshot = vi.fn(() => `snapshot:${state}`);
    const writer = new BoundedSseWriter(peer, snapshot, () => {});
    const factory = vi.fn(() => 'event');
    writer.send(factory);
    for (let i = 0; i < 20; i++) writer.send(factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(peer.write).toHaveBeenCalledTimes(1);
    state = 'latest'; peer.emit('drain');
    expect(peer.write).toHaveBeenLastCalledWith('snapshot:latest');
    expect(snapshot).toHaveBeenCalledTimes(1);
    writer.close();
  });
  it('does not create recovery work from a suppressed heartbeat alone', () => {
    const peer = new Peer(); peer.write.mockReturnValueOnce(false);
    const snapshot = vi.fn(() => 'snapshot');
    const writer = new BoundedSseWriter(peer, snapshot, () => {});
    writer.send(() => 'event'); writer.send(() => 'heartbeat', true); peer.emit('drain');
    expect(snapshot).not.toHaveBeenCalled();
    writer.close();
  });
  it('disconnects a five-second blocked peer and cleans every listener exactly once', () => {
    vi.useFakeTimers();
    const peer = new Peer(); peer.write.mockReturnValue(false);
    const cleanup = vi.fn();
    const writer = new BoundedSseWriter(peer, () => 'snapshot', cleanup);
    writer.send(() => 'event'); vi.advanceTimersByTime(4999);
    expect(cleanup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(peer.destroy).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(peer.eventNames()).toEqual([]);
    expect(writer.send(() => 'late')).toBe(false);
    writer.close(); expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('cancels the deadline on disconnect without cancelling any deployment work', () => {
    vi.useFakeTimers();
    const peer = new Peer(); peer.write.mockReturnValue(false);
    const cleanup = vi.fn();
    const writer = new BoundedSseWriter(peer, () => 'snapshot', cleanup);
    writer.send(() => 'event'); peer.emit('close'); vi.advanceTimersByTime(6000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(peer.destroy).not.toHaveBeenCalled();
    expect(peer.listenerCount('drain')).toBe(0);
  });
  it('limits a frame by UTF-8 bytes before calling peer.write', () => {
    const peer = new Peer();
    const writer = new BoundedSseWriter(peer, () => '', () => {});
    expect(writer.send(() => '中'.repeat(90000))).toBe(false);
    expect(peer.write).not.toHaveBeenCalled();
    expect(peer.destroy).toHaveBeenCalledTimes(1);
  });
  it('refuses excessive existing socket buffering before evaluating the payload', () => {
    const peer = new Peer(); peer.writableLength = 512 * 1024 + 1;
    const factory = vi.fn(() => 'event');
    const writer = new BoundedSseWriter(peer, () => '', () => {});
    expect(writer.send(factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(peer.write).not.toHaveBeenCalled();
  });
  it('handles failed serialization/write or recovery without throwing into the publisher', () => {
    const peer = new Peer();
    const writer = new BoundedSseWriter(peer, () => '', () => { throw new Error('cleanup'); });
    expect(writer.send(() => { throw new Error('private'); })).toBe(false);
    expect(peer.destroy).toHaveBeenCalledTimes(1);
    const recoveryPeer = new Peer(); recoveryPeer.write.mockReturnValueOnce(false);
    const recoveryWriter = new BoundedSseWriter(recoveryPeer, () => { throw new Error('snapshot'); }, () => {});
    recoveryWriter.send(() => 'first'); recoveryWriter.send(() => 'second');
    expect(() => recoveryPeer.emit('drain')).not.toThrow();
    expect(recoveryPeer.destroy).toHaveBeenCalledTimes(1);
  });
  it('starts a fresh bounded deadline if the recovery snapshot is also blocked', () => {
    vi.useFakeTimers();
    const peer = new Peer(); peer.write.mockReturnValue(false);
    const writer = new BoundedSseWriter(peer, () => 'snapshot', () => {});
    writer.send(() => 'first'); writer.send(() => 'second'); vi.advanceTimersByTime(4000);
    peer.emit('drain'); vi.advanceTimersByTime(4999);
    expect(peer.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(peer.destroy).toHaveBeenCalledTimes(1);
  });
});
