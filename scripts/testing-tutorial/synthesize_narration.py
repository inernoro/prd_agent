"""Render local Kokoro narration; caption times follow actual sentence sample counts.

Run from a venv with kokoro-onnx, onnxruntime, numpy, soundfile and espeakng-loader.
Provide --model-dir containing kokoro-v1.0.onnx and voices-v1.0.bin.
Existing valid WAV/JSON pairs are reused when text and synthesis settings match.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import time
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
import onnxruntime as rt

ROOT = Path(__file__).resolve().parent

def save_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', '--spec', dest='manifest', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, default=ROOT / 'tts')
    parser.add_argument('--voice', default='zf_xiaobei')
    parser.add_argument('--speed', type=float, default=.9)
    parser.add_argument('--pause', type=float, default=.18)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    if args.threads < 1 or args.speed <= 0 or args.pause < 0:
        parser.error('threads and speed must be positive; pause must be nonnegative')
    source = json.loads(args.manifest.read_text())
    segments = source['segments'] if isinstance(source, dict) else source
    ids = [x['id'] for x in segments]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate scene IDs')
    args.out.mkdir(parents=True, exist_ok=True)
    options = rt.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    model = None
    all_meta = []
    for segment in segments:
        sid = segment['id']
        if not re.fullmatch(r'[A-Za-z0-9_-]+', sid):
            raise ValueError(f'Unsafe scene ID: {sid}')
        sentences = segment.get('sentences') or re.findall(r'.+?(?:[。！？]|$)', segment.get('text', ''))
        rows = []
        for sentence in sentences:
            speech = sentence['text'] if isinstance(sentence, dict) else sentence
            caption = sentence.get('caption', speech) if isinstance(sentence, dict) else speech
            if speech.strip():
                rows.append((speech, caption))
        if not rows:
            continue
        voice, speed = segment.get('voice', args.voice), segment.get('speed', args.speed)
        fingerprint = hashlib.sha256(json.dumps({'rows': rows, 'voice': voice, 'speed': speed,
                                                'pause': args.pause, 'language': 'cmn'},
                                               ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        output = args.out / (sid + '.wav')
        prior_path = output.with_suffix('.json')
        reused = False
        if not args.force and prior_path.is_file() and output.is_file():
            try:
                prior = json.loads(prior_path.read_text())
                old_rows = [(x.get('spoken_text'), x.get('text')) for x in prior.get('captions', [])]
                settings_match = (prior.get('voice') == voice and prior.get('speed', .9) == speed
                                  and prior.get('pause_seconds', .18) == args.pause and prior.get('lang') == 'cmn')
                info = sf.info(output)
                if old_rows == rows and settings_match and info.frames > 0 and abs(info.duration - prior['seconds']) < .001:
                    all_meta.append(prior)
                    reused = True
                    print(json.dumps({'id': sid, 'reused': True, 'seconds': prior['seconds']}, ensure_ascii=False), flush=True)
            except (ValueError, KeyError, RuntimeError, OSError):
                pass
        if not reused:
            if model is None:
                session = rt.InferenceSession(str(args.model_dir / 'kokoro-v1.0.onnx'), sess_options=options,
                                             providers=['CPUExecutionProvider'])
                model = Kokoro.from_session(session, str(args.model_dir / 'voices-v1.0.bin'))
            chunks, captions, position, rate = [], [], 0, 24000
            began = time.monotonic()
            for speech, caption in rows:
                samples, rate = model.create(speech, voice=voice, speed=speed, lang='cmn')
                if not len(samples) or not np.isfinite(samples).all():
                    raise ValueError(f'Invalid generated sentence audio: {sid}')
                silence = np.zeros(round(args.pause * rate), dtype=np.float32)
                start = position / rate
                position += len(samples)
                captions.append({'start': start, 'end': position / rate, 'text': caption, 'spoken_text': speech})
                chunks.extend([samples, silence])
                position += len(silence)
            samples = np.concatenate(chunks)
            peak = float(np.max(np.abs(samples)))
            if peak >= 1:
                raise ValueError(f'Audio would clip: {sid}, peak={peak}')
            temporary = output.with_suffix('.tmp.wav')
            sf.write(str(temporary), samples, rate, subtype='PCM_16')
            temporary.replace(output)
            meta = {'id': sid, 'audio': str(output.resolve()), 'voice': voice, 'lang': 'cmn',
                    'speed': speed, 'pause_seconds': args.pause, 'sample_rate': rate,
                    'seconds': len(samples) / rate, 'request_sha256': fingerprint,
                    'caption_alignment': 'Each sentence synthesized separately; timestamps from actual sample counts',
                    'captions': captions, 'peak': peak, 'render_seconds': time.monotonic() - began}
            save_json(prior_path, meta)
            all_meta.append(meta)
            print(json.dumps({x: meta[x] for x in ['id', 'seconds', 'render_seconds', 'peak']}, ensure_ascii=False), flush=True)
        save_json(args.out / 'narration-manifest.partial.json',
                  {'engine': 'kokoro-onnx', 'threads': args.threads, 'complete': False, 'segments': all_meta})
    save_json(args.out / 'narration-manifest.json',
              {'engine': 'kokoro-onnx', 'threads': args.threads, 'complete': True,
               'total_seconds': sum(x['seconds'] for x in all_meta), 'segments': all_meta})

if __name__ == '__main__':
    main()
