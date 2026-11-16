#!/usr/bin/env python3
"""Capture one Breeze PCM stream to WAV with matching latency metrics."""
import argparse
import json
import time
import urllib.request
import uuid
import wave
from pathlib import Path

import numpy as np

REF_PATH = Path('/ref.wav')
REF_TEXT = '你不需要证明任何事因为你本身就值得被爱'
INSTRUCTION = '始终保持参考说话人的音色、年龄感和身份。像面对熟悉的人自然交谈，咬字清楚，停顿随语义变化；不要念稿，不要变成另一个人。'
TEXTS = {
    'short': '你好呀，我是爱莉希雅。很高兴今天能和你说话。',
    'long': '夜色慢慢落下来，窗外的灯光一盏接一盏地亮起。忙碌了一整天之后，记得给自己留一点安静的时间。先倒一杯温水，找一个舒服的位置坐下，慢慢地呼吸。你不需要时刻保持完美，只要按照自己的节奏，一点一点向前走，就已经很好了。',
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--text', choices=TEXTS, default='short')
    parser.add_argument('--cfg', type=float, default=3.8)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    boundary = '----ElysiaModelComparison' + uuid.uuid4().hex
    fields = {
        'text': TEXTS[args.text],
        'instruction': INSTRUCTION,
        'cfg_scale': str(args.cfg),
        'ref_text': REF_TEXT,
        'seed': '42',
    }
    body = bytearray()
    for name, value in fields.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="ref_gentle.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
    body.extend(REF_PATH.read_bytes())
    body.extend(f'\r\n--{boundary}--\r\n'.encode())
    request = urllib.request.Request(
        args.url.rstrip('/') + '/v1/audio/speech',
        data=bytes(body),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    )

    pcm = bytearray()
    arrivals = []
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=300) as response:
        sample_rate = int(response.headers.get('X-Sample-Rate', '24000'))
        while True:
            chunk = response.read1(65536)
            if not chunk:
                break
            pcm.extend(chunk)
            arrivals.append((time.monotonic() - started, len(chunk)))
    elapsed = time.monotonic() - started
    duration = len(pcm) / (sample_rate * 2)
    minimum_buffer = 0.0
    received = 0
    for arrival, size in arrivals:
        minimum_buffer = max(minimum_buffer, arrival - received / (sample_rate * 2))
        received += size
    minimum_buffer = max(0.0, minimum_buffer)

    stem = f'{args.label}-{args.text}'
    wav_path = out / f'{stem}.wav'
    with wave.open(str(wav_path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)
    samples = np.frombuffer(pcm, dtype='<i2').astype(np.float64) / 32768.0
    record = {
        'label': args.label,
        'text': args.text,
        'text_content': TEXTS[args.text],
        'cfg_scale': args.cfg,
        'seed': 42,
        'instruction': INSTRUCTION,
        'reference_text': REF_TEXT,
        'sample_rate': sample_rate,
        'duration_seconds': duration,
        'first_audio_seconds': arrivals[0][0] if arrivals else None,
        'elapsed_seconds': elapsed,
        'rtf': elapsed / duration if duration else None,
        'realtime_multiple': duration / elapsed if elapsed else None,
        'minimum_perfect_buffer_seconds': minimum_buffer,
        'rms': float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0.0,
        'peak': float(np.max(np.abs(samples))) if len(samples) else 0.0,
        'clipped_sample_ratio': float(np.mean(np.abs(samples) >= 32767 / 32768)) if len(samples) else 0.0,
        'wav': wav_path.name,
    }
    (out / f'{stem}.capture.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(record, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
