from difflib import SequenceMatcher
import json
from pathlib import Path
from statistics import median
import subprocess
import sys

from faster_whisper import WhisperModel
import numpy as np
from opencc import OpenCC


workspace = Path(sys.argv[1])
movie = workspace / 'watercolor-acceptance.mp4'
convert = OpenCC('t2s')


def normalized(text):
    return ''.join(character for character in convert.convert(text).lower() if character.isalnum())


model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=4)
pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(movie), '-map', '0:a:0',
                               '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'])
segments, _ = model.transcribe(np.frombuffer(pcm, dtype='<f4'), language='zh', beam_size=3,
                               word_timestamps=True, vad_filter=True)
words = []
transcript = []
for segment in segments:
    transcript.append({'fromSec': segment.start, 'toSec': segment.end, 'text': segment.text.strip()})
    for word in segment.words or []:
        words.extend((character, word.start, word.end) for character in normalized(word.word))

cues = json.loads((workspace / 'watercolor-captions.json').read_text())
results = []
for index, cue in enumerate(cues, start=1):
    start, end = cue['fromSec'], cue['toSec']
    target = normalized(cue['text'])
    nearby = [word for word in words if word[2] >= start - 2.5 and word[1] <= end + 2.5]
    offsets = []
    for left, right, size in SequenceMatcher(None, target, ''.join(word[0] for word in nearby), autojunk=False).get_matching_blocks():
        if size >= 2 or len(target) <= 3:
            offsets.extend(range(right, right + size))
    coverage = len(offsets) / len(target) if target else 0
    spoken_start = nearby[offsets[0]][1] if offsets else None
    spoken_end = nearby[offsets[-1]][2] if offsets else None
    results.append({'cue': index, 'textCoverage': round(coverage, 3),
                    'audioMinusCaptionStartSec': round(spoken_start - start, 3) if spoken_start is not None else None,
                    'audioMinusCaptionEndSec': round(spoken_end - end, 3) if spoken_end is not None else None})

reliable = [item for item in results if item['textCoverage'] >= 0.65 and item['audioMinusCaptionStartSec'] is not None]
summary = {'model': 'faster-whisper-small-int8', 'cues': len(cues), 'recognizedSegments': len(transcript),
           'reliablyMatchedCues': len(reliable), 'medianAbsoluteStartOffsetSec':
               round(median(abs(item['audioMinusCaptionStartSec']) for item in reliable), 3) if reliable else None,
           'cuesWithStartOffsetOverOneSecond': sum(abs(item['audioMinusCaptionStartSec']) > 1 for item in reliable),
           'timings': results, 'speech': transcript}
output = workspace / 'dsn-1400e277-evidence' / 'watercolor-caption-audio.json'
output.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps({key: value for key, value in summary.items() if key not in {'timings', 'speech'}}))
