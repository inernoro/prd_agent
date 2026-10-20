"""Official OpenAI Speech API only. Prepare without a key/network by default.

Prepare:
  python batch_official_tts.py --prepare-only
After the user approves the exact official audition, save the approval contract
printed in official_audio/narration-requests.json to
 evidence/official-audition-approved.json, then run with --audition-approved.
Use OPENAI_API_KEY or --prompt-key (no echo); no credential argument is accepted.
"""
from pathlib import Path
import argparse, array, concurrent.futures, getpass, hashlib, importlib.util
import io, json, os, re, struct, threading, time, urllib.error, urllib.request, wave

ROOT = Path(__file__).resolve().parent
ENGINE = 'openai-speech'
MODEL = 'gpt-4o-mini-tts'
VOICE = 'coral'
LOCKS = {}


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)


def wav_data(body):
    # Speech responses can use RIFF/data size 0xffffffff because their length
    # was unknown when streaming began. Only that explicit convention permits
    # deriving the frame count from the completed HTTP response.
    streamed = False
    if body[:4] == b'RIFF' and body[8:12] == b'WAVE' and body[4:8] == b'\xff' * 4:
        offset = 12
        while offset + 8 <= len(body):
            kind = body[offset:offset + 4]
            size = struct.unpack_from('<I', body, offset + 4)[0]
            if kind == b'data':
                streamed = size == 0xffffffff
                break
            offset += 8 + size + (size & 1)
    with wave.open(io.BytesIO(body), 'rb') as f:
        channels, width, rate, frames = f.getnchannels(), f.getsampwidth(), f.getframerate(), f.getnframes()
        if f.getcomptype() != 'NONE' or width != 2 or channels not in (1, 2) or frames <= 0:
            raise ValueError('Speech response is not nonempty PCM16 WAV')
        raw = f.readframes(frames)
        if streamed:
            if not raw or len(raw) % (channels * width):
                raise ValueError('Speech streaming WAV has incomplete PCM frames')
            frames = len(raw) // (channels * width)
        elif len(raw) != frames * channels * width:
            raise ValueError('Speech WAV is truncated')
    return (channels, width, rate), frames, raw


def source_rows(spec_path, split):
    source = json.loads(spec_path.read_text())
    rows, seen = [], set()
    for segment in source['segments']:
        for scene in segment['scenes']:
            sid = scene['id']
            if not re.fullmatch(r'[A-Za-z0-9_-]+', sid) or sid in seen:
                raise ValueError('Duplicate or unsafe scene ID')
            seen.add(sid)
            voice = scene.get('voice', '')
            if not isinstance(voice, str):
                raise ValueError('Scene narration must be text')
            if not voice.strip():
                continue
            clauses = split(voice)  # Only split; NEVER call Kokoro's spoken() aliases.
            if not clauses or ''.join(clauses) != voice or any(not x.strip() or len(x) > 4096 for x in clauses):
                raise ValueError('Sentence preparation did not preserve source narration')
            rows.append({'id': sid, 'segment_id': segment['id'], 'chapter': segment['chapter'],
                         'input': voice, 'sentences': clauses})
    if not rows:
        raise ValueError('No voiced scenes in the source')
    return rows


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--spec', type=Path, default=ROOT / 'production.json')
    p.add_argument('--out', type=Path, default=ROOT / 'official_audio')
    p.add_argument('--api-helper', type=Path,
                   default=ROOT / 'official_tts.py')
    p.add_argument('--prepare-only', action='store_true')
    p.add_argument('--audition-approved', action='store_true')
    p.add_argument('--prompt-key', action='store_true')
    p.add_argument('--workers', '--threads', dest='workers', type=int, default=4)
    p.add_argument('--model', default=MODEL)
    p.add_argument('--voice', default=VOICE)
    p.add_argument('--pause', type=float, default=.18)
    a = p.parse_args()
    if not 1 <= a.workers <= 4 or not 0 <= a.pause <= 2:
        p.error('workers must be 1-4; pause must be 0-2 seconds')
    helper = load_module(a.api_helper, 'official_speech_config')
    prepare = load_module(ROOT / 'prepare_narration.py', 'caption_split_only')
    endpoint, style = helper.ENDPOINT, helper.STYLE
    if endpoint != 'https://api.openai.com/v1/audio/speech':
        p.error('Only the official OpenAI Speech API endpoint is allowed')
    rows = source_rows(a.spec, prepare.split)
    settings = {'engine': ENGINE, 'endpoint': endpoint, 'model': a.model, 'voice': a.voice,
                'instructions': style, 'response_format': 'wav', 'speed': 1.0,
                'pause_seconds': a.pause}
    contract = {'approved': True, 'engine': ENGINE, 'model': a.model, 'voice': a.voice,
                'instructions_sha256': hashlib.sha256(style.encode()).hexdigest()}
    a.out.mkdir(parents=True, exist_ok=True)
    prepared = {'schema': 1, **settings, 'state': 'prepared_not_called',
                'source': str(a.spec.resolve()), 'source_sha256': hashlib.sha256(a.spec.read_bytes()).hexdigest(),
                'source_text_preserved': True, 'kokoro_aliases_applied': False,
                'scene_count': len(rows), 'request_count': sum(len(r['sentences']) for r in rows),
                'required_approval_file': str(ROOT / 'evidence/official-audition-approved.json'),
                'required_approval_contract': contract, 'segments': rows}
    save_json(a.out / 'narration-requests.json', prepared)
    if a.prepare_only:
        print(json.dumps({'state': 'prepared_not_called', 'scenes': len(rows),
                          'requests': prepared['request_count'], 'out': str(a.out)}, ensure_ascii=False))
        return 0
    approval = ROOT / 'evidence/official-audition-approved.json'
    if not a.audition_approved or not approval.is_file():
        p.error('User audition approval is required: --audition-approved AND the approval record; no API called')
    try:
        approved = json.loads(approval.read_text())
    except (ValueError, OSError):
        p.error('Approval record is unreadable; no API called')
    if any(approved.get(k) != v for k, v in contract.items()):
        p.error('Approval must match the exact engine/model/voice/instructions; no API called')
    key = os.environ.get('OPENAI_API_KEY', '')
    if not key and a.prompt_key:
        key = getpass.getpass('Official API credential (hidden): ')
    if not key.strip():
        p.error('Missing official API credential; configure OPENAI_API_KEY or use --prompt-key; no API called')
    parts = a.out / 'parts'
    parts.mkdir(exist_ok=True)

    def sentence_audio(text):
        payload = {'model': a.model, 'voice': a.voice, 'input': text, 'instructions': style,
                   'response_format': 'wav', 'speed': 1.0}
        fingerprint = digest({'endpoint': endpoint, 'request': payload})
        path = parts / (fingerprint + '.wav')
        lock = LOCKS.setdefault(fingerprint, threading.Lock())
        with lock:
            if path.is_file() and path.with_suffix('.json').is_file():
                try:
                    prior = json.loads(path.with_suffix('.json').read_text())
                    body = path.read_bytes()
                    if prior['request_sha256'] == fingerprint and prior['sha256'] == hashlib.sha256(body).hexdigest():
                        return fingerprint, wav_data(body)
                except (ValueError, KeyError, OSError, EOFError, wave.Error):
                    pass
            request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                       headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
            try:
                with urllib.request.urlopen(request, timeout=150) as response:
                    body = response.read()
            except urllib.error.HTTPError as error:
                raise RuntimeError('Official Speech API HTTP ' + str(error.code) + '; body and credentials not logged') from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise RuntimeError('Official Speech API network failure; credentials and response body not logged') from None
            decoded = wav_data(body)
            tmp = path.with_suffix('.pending.wav');tmp.write_bytes(body);tmp.replace(path)
            save_json(path.with_suffix('.json'), {'engine': ENGINE, 'request_sha256': fingerprint,
                      'sha256': hashlib.sha256(body).hexdigest(), 'input': text,
                      'model': a.model, 'voice': a.voice, 'instructions_sha256': contract['instructions_sha256']})
            return fingerprint, decoded

    def render(row):
        began = time.monotonic()
        fingerprint = digest({'settings': settings, 'sentences': row['sentences']})
        output = a.out / (row['id'] + '.wav'); meta_path = output.with_suffix('.json')
        if output.is_file() and meta_path.is_file():
            try:
                prior = json.loads(meta_path.read_text()); body = output.read_bytes()
                params, frames, _ = wav_data(body)
                if (prior.get('engine') == ENGINE and prior.get('request_sha256') == fingerprint
                        and prior.get('sha256') == hashlib.sha256(body).hexdigest()
                        and abs(prior['seconds'] - frames / params[2]) < 1e-6):
                    return prior
            except (ValueError, KeyError, OSError, EOFError, wave.Error):
                pass
        raw_parts, captions, position, parameters = [], [], 0, None
        for text in row['sentences']:
            part_fp, (current, frames, raw) = sentence_audio(text)
            if parameters is None:
                parameters = current
            if current != parameters:
                raise RuntimeError('Sentence WAV formats differ; refusing guessed resampling or timestamps')
            rate = current[2]; start = position / rate; position += frames
            captions.append({'start': start, 'end': position / rate, 'text': text,
                             'spoken_text': text, 'request_sha256': part_fp})
            silence_frames = round(a.pause * rate)
            raw_parts.extend([raw, b'\0' * (silence_frames * current[0] * current[1])])
            position += silence_frames
        pcm = b''.join(raw_parts); buf = io.BytesIO()
        with wave.open(buf, 'wb') as writer:
            writer.setnchannels(parameters[0]);writer.setsampwidth(parameters[1]);writer.setframerate(parameters[2]);writer.writeframes(pcm)
        body = buf.getvalue(); _, checked_frames, _ = wav_data(body)
        if checked_frames != position:
            raise RuntimeError('WAV frame count mismatch')
        samples = array.array('h', pcm)
        peak = max(abs(int(x)) for x in samples) / 32768
        tmp = output.with_suffix('.pending.wav');tmp.write_bytes(body);tmp.replace(output)
        meta = {'id': row['id'], 'segment_id': row['segment_id'], 'engine': ENGINE,
                'audio': str(output.resolve()), 'voice': a.voice, 'model': a.model, 'lang': 'cmn',
                'speed': 1.0, 'pause_seconds': a.pause, 'sample_rate': parameters[2],
                'seconds': position / parameters[2], 'request_sha256': fingerprint,
                'sha256': hashlib.sha256(body).hexdigest(),
                'instructions_sha256': contract['instructions_sha256'],
                'caption_alignment': 'Each exact-source sentence synthesized separately; timestamps from actual PCM sample counts',
                'captions': captions, 'peak': peak, 'render_seconds': time.monotonic() - began,
                'pronunciation_review': 'individual_scene_not_reviewed', 'audition_approval_checked': True}
        save_json(meta_path, meta)
        return meta

    collected = {}
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
            futures = {pool.submit(render, row): row['id'] for row in rows}
            for future in concurrent.futures.as_completed(futures):
                sid = futures[future]
                try:
                    collected[sid] = future.result()
                except Exception:
                    for other in futures: other.cancel()
                    raise RuntimeError('Scene ' + sid + ' failed; valid sentence cache retained; no secret logged') from None
                ordered = [collected[r['id']] for r in rows if r['id'] in collected]
                save_json(a.out / 'narration-manifest.partial.json',
                          {'schema': 1, 'engine': ENGINE, 'complete': False, 'segments': ordered})
                print(json.dumps({'id': sid, 'seconds': collected[sid]['seconds']}, ensure_ascii=False), flush=True)
        ordered = [collected[r['id']] for r in rows]
        segment_seconds, chapter_seconds = {}, {}
        for row, meta in zip(rows, ordered):
            segment_seconds[row['segment_id']] = segment_seconds.get(row['segment_id'], 0) + meta['seconds']
            chapter_key = 'c' + str(row['chapter'])
            chapter_seconds[chapter_key] = chapter_seconds.get(chapter_key, 0) + meta['seconds']
        save_json(a.out / 'narration-manifest.json',
                  {'schema': 1, 'engine': ENGINE, 'endpoint': endpoint, 'model': a.model, 'voice': a.voice,
                   'lang': 'cmn', 'threads': a.workers, 'complete': True,
                   'total_seconds': sum(m['seconds'] for m in ordered), 'segment_seconds': segment_seconds,
                   'chapter_seconds': chapter_seconds, 'segments': ordered,
                   'pronunciation_review': 'individual_scenes_await_review'})
    finally:
        key = ''
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError) as exc:
        # Never include request objects, headers, raw server text or credentials.
        raise SystemExit(type(exc).__name__ + ': batch stopped; inspect prepared inputs and valid cache, not credential logs') from None
