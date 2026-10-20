"""Prepare Chinese narration without changing source captions.

Usage: python prepare_chinese_narration.py --spec segments.json --out requests.json
       --only c1-s03-a2,c2-s03-b2 selects an additional render batch.
"""
from pathlib import Path
import argparse
import json
import re

ROOT = Path(__file__).resolve().parent

def han(text):
    return len(re.findall(r'[\u3400-\u9fff]', text))

def split(text):
    atoms = re.findall(r'.+?(?:[，,；;。！？!?]|$)', text, re.S)
    chunks, buf = [], ''
    for atom in atoms:
        if han(buf + atom) > 38 and han(buf) >= 20:
            chunks.append(buf)
            buf = ''
        if han(atom) > 38:
            for ch in atom:
                if han(buf) >= 38:
                    chunks.append(buf)
                    buf = ''
                buf += ch
        else:
            buf += atom
    if buf:
        chunks.append(buf)
    assert ''.join(chunks) == text, 'Caption splitting changed source text'
    return chunks

def spoken(text):
    aliases = [(r'P0\s*/\s*P1', 'P零级和P一级'), (r'Codex', '扣德克斯'),
               (r'Agent', '智能体'), (r'GitHub', '吉特哈布'), (r'CDS', 'C D S'),
               (r'MAP', 'map')]
    for word, reading in [('P0', 'P零级'), ('P1', 'P一级'), ('P2', 'P二级'),
                          ('P3', 'P三级'), ('SSOT', 'S S O T'), ('SSO', 'S S O'),
                          ('HTML', 'H T M L'), ('PR', 'P R'), ('CI', 'C I'), ('AI', 'A I')]:
        aliases.append((r'(?<![A-Za-z0-9])' + word + r'(?![A-Za-z0-9])', reading))
    for pattern, reading in aliases:
        text = re.sub(pattern, reading, text)
    return text

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', type=Path, default=ROOT / 'segments.json')
    parser.add_argument('--out', type=Path, default=ROOT / 'tts/narration-requests.json')
    parser.add_argument('--only', default='', help='Comma-separated scene IDs')
    args = parser.parse_args()
    source = json.loads(args.spec.read_text())
    selected = set(filter(None, args.only.split(',')))
    rows, seen, chars = [], set(), 0
    for segment in source['segments']:
        for scene in segment['scenes']:
            sid = scene['id']
            if sid in seen:
                raise ValueError(f'Duplicate scene: {sid}')
            seen.add(sid)
            voice = scene.get('voice', '')
            if not voice.strip() or (selected and sid not in selected):
                continue
            captions = split(voice)
            chars += len(voice)
            rows.append({'id': sid, 'segment_id': segment['id'],
                         'sentences': [{'caption': x, 'text': spoken(x)} for x in captions]})
    if selected - {r['id'] for r in rows}:
        raise ValueError(f'Unknown or silent requested scenes: {selected - {r["id"] for r in rows}}')
    if not rows:
        raise ValueError('No voiced scenes selected')
    result = {'schema': 1, 'source': str(args.spec), 'source_text_preserved': True,
              'voice': 'zf_xiaobei', 'language': 'cmn', 'speed': .9,
              'caption_policy': 'Captions retain exact source; speech aliases affect pronunciation only',
              'segments': rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'scenes': len(rows), 'caption_clauses': sum(len(x['sentences']) for x in rows),
                      'longest_caption_han': max(han(y['caption']) for x in rows for y in x['sentences']),
                      'source_characters': chars, 'out': str(args.out)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
