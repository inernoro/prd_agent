import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const port = Number(process.env.PORT || 8080);
const stats = {
  upgrades: 0,
  binaryMessages: 0,
  completedSessions: 0,
  lastHeaders: {},
};

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeWebSocketBinary(payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x82, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeDoubaoResponse(sequence, isLast, text) {
  const payload = gzipSync(Buffer.from(JSON.stringify({
    result: {
      text,
      utterances: text
        ? [{ start_time: 0, end_time: 100, text }]
        : [],
    },
  })));
  const body = Buffer.alloc(8);
  body.writeInt32BE(sequence, 0);
  body.writeUInt32BE(payload.length, 4);
  const flags = isLast ? 0x03 : 0x01;
  return Buffer.concat([
    Buffer.from([0x11, 0x90 | flags, 0x11, 0x00]),
    body,
    payload,
  ]);
}

function consumeFrames(state, chunk, onBinary, onClose) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const largeLength = state.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("frame-too-large");
      }
      length = Number(largeLength);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (state.buffer.length < offset + maskLength + length) return;
    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    if (opcode === 0x08) {
      onClose(payload);
      return;
    }
    if (opcode === 0x02) onBinary(payload);
  }
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    status: "ok",
    ...stats,
  }));
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/asr" || !request.headers["sec-websocket-key"]) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }

  stats.upgrades += 1;
  stats.lastHeaders = {
    host: request.headers.host || "",
    appKey: request.headers["x-api-app-key"] ? "present" : "absent",
    accessKey: request.headers["x-api-access-key"] ? "present" : "absent",
    resourceId: request.headers["x-api-resource-id"] || "",
  };
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(request.headers["sec-websocket-key"])}`,
    "",
    "",
  ].join("\r\n"));

  const state = { buffer: Buffer.alloc(0), received: 0 };
  socket.on("data", (chunk) => {
    consumeFrames(
      state,
      chunk,
      () => {
        state.received += 1;
        stats.binaryMessages += 1;
        if (state.received === 1) {
          socket.write(encodeWebSocketBinary(encodeDoubaoResponse(1, false, "")));
          return;
        }
        stats.completedSessions += 1;
        socket.write(encodeWebSocketBinary(
          encodeDoubaoResponse(-state.received, true, "CDS WSS stub roundtrip"),
        ));
      },
      (payload) => {
        const closePayload = payload.length > 125 ? Buffer.alloc(0) : payload;
        socket.end(Buffer.concat([
          Buffer.from([0x88, closePayload.length]),
          closePayload,
        ]));
      },
    );
  });
});

server.listen(port, "0.0.0.0");
