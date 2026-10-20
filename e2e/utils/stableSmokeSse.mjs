export function readSseTypingText(stream) {
  let sawPhase = false;
  let done = false;
  let answer = '';
  for (const frame of stream.replaceAll('\r\n', '\n').split('\n\n')) {
    const lines = frame.split('\n');
    const eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    if (eventType === 'error') throw new Error('问答流包含 error，不能判为成功');
    if (eventType === 'phase') sawPhase = true;
    if (eventType === 'done') {
      if (done) throw new Error('问答流重复 done');
      done = true;
    }
    if (eventType !== 'typing') continue;
    if (done) throw new Error('问答流在 done 后继续写答案');
    if (!sawPhase) throw new Error('问答流在 phase 前写答案');
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    let payload;
    try {
      payload = JSON.parse(data);
    } catch { throw new Error('问答 typing 数据无法解析'); }
    if (typeof payload?.text !== 'string') throw new Error('问答 typing.text 不是字符串');
    answer += payload.text;
  }
  if (!done) throw new Error('问答流缺少 done，答案可能被截断');
  if (!answer.trim()) throw new Error('问答流没有实际答案');
  return answer;
}
