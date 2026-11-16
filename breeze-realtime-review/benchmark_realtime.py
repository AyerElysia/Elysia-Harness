#!/usr/bin/env python3
"""Measure Breeze PCM streaming latency and playback buffer requirements."""
import argparse
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

REF_PATH = Path('/home/ayerelysia/.local/share/elysium-migration-20260908/voice/GPT-SoVITS/ref_elysia/ref_gentle.wav')
REF_TEXT = '你不需要证明任何事因为你本身就值得被爱'
INSTRUCTION = '始终保持参考说话人的音色、年龄感和身份。像面对熟悉的人自然交谈，咬字清楚，停顿随语义变化；不要念稿，不要变成另一个人。'
TEXTS = {
    'short': '你好呀，我是爱莉希雅。很高兴今天能和你说话。',
    'medium': '今天过得怎么样？如果有开心的事情，就说给我听听吧。如果有点累，也可以先靠在这里休息一会儿。',
    'long': '夜色慢慢落下来，窗外的灯光一盏接一盏地亮起。忙碌了一整天之后，记得给自己留一点安静的时间。先倒一杯温水，找一个舒服的位置坐下，慢慢地呼吸。你不需要时刻保持完美，只要按照自己的节奏，一点一点向前走，就已经很好了。',
}


def request_for(text, cfg):
    boundary = '----ElysiaRealtimeBenchmark' + uuid.uuid4().hex
    fields = {
        'text': text,
        'instruction': INSTRUCTION,
        'cfg_scale': str(cfg),
        'ref_text': REF_TEXT,
        'seed': '42',
    }
    body = bytearray()
    for name, value in fields.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="ref_gentle.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
    body.extend(REF_PATH.read_bytes())
    body.extend(f'\r\n--{boundary}--\r\n'.encode())
    return urllib.request.Request(
        ARGS.url.rstrip('/') + '/v1/audio/speech',
        data=bytes(body),
        headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'X-Breeze-Client': 'realtime-benchmark',
        },
    )


def summarize_arrivals(arrivals, sample_rate):
    audio_bytes = 0
    minimum_buffer = 0.0
    for arrival in arrivals:
        audio_seconds = arrival['bytes'] / (sample_rate * 2)
        minimum_buffer = max(minimum_buffer, arrival['seconds_since_start'] - audio_bytes / (sample_rate * 2))
        audio_bytes += arrival['bytes']
    return audio_bytes, max(0.0, minimum_buffer)


def run(text_name, cfg, run_name):
    text = TEXTS[text_name]
    started = time.monotonic()
    arrivals = []
    record = {
        'label': ARGS.label,
        'url': ARGS.url,
        'text_name': text_name,
        'text_characters': len(text),
        'cfg_scale': cfg,
        'run': run_name,
        'seed': 42,
        'has_instruction': True,
    }
    try:
        with urllib.request.urlopen(request_for(text, cfg), timeout=300) as response:
            sample_rate = int(response.headers.get('X-Sample-Rate', '24000'))
            record.update({
                'http_status': response.status,
                'content_type': response.headers.get('Content-Type'),
                'sample_rate': sample_rate,
                'request_id': response.headers.get('X-Request-ID'),
            })
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                arrivals.append({'bytes': len(chunk), 'seconds_since_start': time.monotonic() - started})
        audio_bytes, minimum_buffer = summarize_arrivals(arrivals, sample_rate)
        elapsed = time.monotonic() - started
        duration = audio_bytes / (sample_rate * 2)
        first_audio = arrivals[0]['seconds_since_start'] if arrivals else None
        record.update({
            'success': response.status == 200 and audio_bytes > 0,
            'audio_bytes': audio_bytes,
            'duration_seconds': duration,
            'first_audio_seconds': first_audio,
            'elapsed_seconds': elapsed,
            'rtf': elapsed / duration if duration else None,
            'realtime_multiple': duration / elapsed if elapsed else None,
            'minimum_perfect_buffer_seconds': minimum_buffer,
            'chunk_count': len(arrivals),
            'chunk_arrivals': arrivals,
        })
    except urllib.error.HTTPError as exc:
        record.update({
            'success': False,
            'http_status': exc.code,
            'error': exc.read().decode('utf-8', errors='replace')[:2000],
            'elapsed_seconds': time.monotonic() - started,
        })
    except Exception as exc:
        record.update({'success': False, 'error': repr(exc), 'elapsed_seconds': time.monotonic() - started})
    record.pop('audio_sha256', None)
    OUT.mkdir(parents=True, exist_ok=True)
    stem = f'{ARGS.label}-{text_name}-cfg{cfg:g}-{run_name}'
    (OUT / f'{stem}.result.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {key: value for key, value in record.items() if key != 'chunk_arrivals'}
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return record


ARGS = None
OUT = None


def main():
    global ARGS, OUT
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--text', choices=TEXTS, default='short')
    parser.add_argument('--cfg', type=float, default=3.8)
    parser.add_argument('--runs', type=int, default=2)
    parser.add_argument('--warmup', action='store_true')
    ARGS = parser.parse_args()
    OUT = Path(ARGS.out)
    if ARGS.warmup:
        run(ARGS.text, ARGS.cfg, 'warmup')
    for index in range(1, ARGS.runs + 1):
        run(ARGS.text, ARGS.cfg, f'run{index}')


if __name__ == '__main__':
    main()
