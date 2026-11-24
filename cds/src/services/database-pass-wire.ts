import type { Socket } from 'node:net';

/** Frame before interpreting credentials. A packet may be fragmented or coalesced by TCP. */
export function relayFrames(socket: Socket, length: (buffer: Buffer) => number, maximum: () => number, frame: (packet: Buffer) => void) {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = length(buffered);
        if (size < 4 || size > maximum()) throw new Error('Invalid database packet size');
        if (buffered.length < size) break;
        const packet = buffered.subarray(0, size);buffered = buffered.subarray(size);frame(packet);if(socket.destroyed)return;
      }
    } catch { socket.destroy(); }
  });
}

export function firstFrame(socket: Socket, length: (buffer: Buffer) => number, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const fail = () => { cleanup();reject(new Error('Database handshake closed')); };
    const cleanup = () => { socket.removeListener('data', data);socket.removeListener('close', fail);socket.removeListener('error', fail); };
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const size = length(buffered);
      if (size < 4 || size > maximum) { cleanup();socket.destroy();reject(new Error('Invalid database handshake size'));return; }
      if (buffered.length < size) return;
      socket.pause();cleanup();if (buffered.length > size) socket.unshift(buffered.subarray(size));resolve(buffered.subarray(0, size));
    };
    socket.on('data', data);socket.once('close', fail);socket.once('error', fail);socket.resume();
  });
}
export const mysqlFrameLength = (buffer: Buffer) => buffer.readUIntLE(0, 3) + 4;
