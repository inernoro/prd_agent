const target = process.argv[2] || "ws://127.0.0.1:18080/asr";
const socket = new WebSocket(target);
socket.binaryType = "arraybuffer";
let received = 0;

socket.addEventListener("open", () => {
  socket.send(new Uint8Array([1, 2, 3]));
});

socket.addEventListener("message", (event) => {
  received += 1;
  const bytes = new Uint8Array(event.data);
  if (bytes[0] !== 0x11 || (bytes[1] >> 4) !== 0x09) {
    throw new Error("invalid-doubao-response");
  }
  if (received === 1) {
    socket.send(new Uint8Array([4, 5, 6]));
    return;
  }
  console.log(JSON.stringify({ received, finalFlags: bytes[1] & 0x0f }));
  socket.close();
});

setTimeout(() => {
  if (received < 2) throw new Error("roundtrip-timeout");
}, 5000);
