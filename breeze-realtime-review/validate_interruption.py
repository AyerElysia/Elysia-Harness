#!/usr/bin/env python3
"""Validate Breeze streaming output, cancellation, and post-cancel recovery."""
import asyncio
import json
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

import numpy as np
import websockets

OUT = Path('/harness/breeze-realtime-benchmark')
REF_PATH = Path('/ref.wav')
REF_TEXT = '你不需要证明任何事因为你本身就值得被爱'
INSTRUCTION = '始终保持参考说话人的音色、年龄感和身份。像面对熟悉的人自然交谈，咬字清楚，停顿随语义变化；不要念稿，不要变成另一个人。'
SHORT = '你好呀，我是爱莉希雅。很高兴今天能和你说话。'
LONG = '夜色慢慢落下来，窗外的灯光一盏接一盏地亮起。忙碌了一整天之后，记得给自己留一点安静的时间。先倒一杯温水，找一个舒服的位置坐下，慢慢地呼吸。你不需要时刻保持完美，只要按照自己的节奏，一点一点向前走，就已经很好了。'


def multipart_request(url, fields, include_ref=False):
    boundary = '----ElysiaInterruptionValidation' + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    if include_ref:
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="ref_audio"; filename="ref_gentle.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
        body.extend(REF_PATH.read_bytes())
        body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())
    return urllib.request.Request(
        url,
        data=bytes(body),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    )


def speech_request(url, text):
    return multipart_request(url, {
        'text': text,
        'instruction': INSTRUCTION,
        'cfg_scale': '3.8',
        'ref_text': REF_TEXT,
        'seed': '42',
    }, include_ref=True)


def save_wav(path, pcm, sample_rate=24000):
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)
    samples = np.frombuffer(pcm, dtype='<i2')
    if not len(samples):
        return {'duration_seconds': 0.0}
    floats = samples.astype(np.float64) / 32768.0
    return {
        'duration_seconds': len(samples) / sample_rate,
        'rms': float(np.sqrt(np.mean(floats * floats))),
        'peak': float(np.max(np.abs(floats))),
        'clipped_sample_ratio': float(np.mean(np.abs(samples.astype(np.int32)) >= 32767)),
    }


def write_result(name, record):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(record, ensure_ascii=False), flush=True)


def register_voice():
    request = multipart_request('http://127.0.0.1:7865/v1/voices', {'ref_text': REF_TEXT}, include_ref=True)
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode())
    voice_id = payload.get('id') or payload.get('voice_id')
    if not voice_id:
        raise RuntimeError(f'Voice registration returned no id: {payload}')
    return voice_id


def capture_cpp_short():
    pcm = bytearray()
    started = time.monotonic()
    first_audio = None
    with urllib.request.urlopen(speech_request('http://127.0.0.1:7865/v1/audio/speech', SHORT), timeout=120) as response:
        sample_rate = int(response.headers.get('X-Sample-Rate', '24000'))
        while True:
            chunk = response.read1(65536)
            if not chunk:
                break
            if first_audio is None:
                first_audio = time.monotonic() - started
            pcm.extend(chunk)
    elapsed = time.monotonic() - started
    stats = save_wav(OUT / 'cpp-q8dd4-short.wav', bytes(pcm), sample_rate)
    record = {
        'test': 'cpp-q8dd4-short-capture',
        'success': bool(pcm),
        'first_audio_seconds': first_audio,
        'elapsed_seconds': elapsed,
        'realtime_multiple': stats['duration_seconds'] / elapsed,
        **stats,
    }
    write_result('cpp-q8dd4-short-capture.result.json', record)


async def recv_until(ws, wanted, started, first_audio=None, pcm=None):
    while True:
        message = await asyncio.wait_for(ws.recv(), timeout=90)
        if isinstance(message, bytes):
            if first_audio is None:
                first_audio = time.monotonic() - started
            if pcm is not None:
                pcm.extend(message)
            continue
        event = json.loads(message)
        if event.get('type') == 'error':
            raise RuntimeError(event)
        if event.get('type') == wanted:
            return event, first_audio


async def cpp_cancel(voice_id):
    record = {'test': 'cpp-q8dd4-websocket-cancel'}
    async with websockets.connect('ws://127.0.0.1:7866', max_size=None, ping_interval=None) as ws:
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        record['ready'] = ready
        await ws.send(json.dumps({
            'type': 'start', 'voice_id': voice_id, 'instruction': INSTRUCTION,
            'cfg_scale': 3.8, 'seed': 42,
        }))
        started_event = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
        if started_event.get('type') != 'started':
            raise RuntimeError(started_event)
        pcm = bytearray()
        started = time.monotonic()
        await ws.send(json.dumps({'type': 'flush', 'text': LONG}))
        first_audio = None
        cancel_sent = None
        while True:
            message = await asyncio.wait_for(ws.recv(), timeout=90)
            if isinstance(message, bytes):
                if first_audio is None:
                    first_audio = time.monotonic() - started
                    await asyncio.sleep(0.75)
                    cancel_sent = time.monotonic()
                    await ws.send(json.dumps({'type': 'cancel'}))
                pcm.extend(message)
                continue
            event = json.loads(message)
            if event.get('type') == 'error':
                raise RuntimeError(event)
            if event.get('type') == 'cancelled':
                cancel_ack = time.monotonic()
                break
        record.update({
            'first_audio_seconds': first_audio,
            'cancel_ack_seconds': cancel_ack - cancel_sent,
            'audio_seconds_received_through_ack': len(pcm) / 48000,
        })
        write_result('cpp-q8dd4-websocket-cancel.result.json', record)
        recovered_pcm = bytearray()
        recovery_started = time.monotonic()
        await ws.send(json.dumps({'type': 'end', 'text': SHORT}))
        done, recovery_first = await recv_until(ws, 'done', recovery_started, pcm=recovered_pcm)
        stats = save_wav(OUT / 'cpp-q8dd4-after-cancel.wav', bytes(recovered_pcm))
        record.update({
            'recovery_first_audio_seconds': recovery_first,
            'recovery_elapsed_seconds': time.monotonic() - recovery_started,
            'recovery_audio': stats,
            'success': done.get('type') == 'done' and bool(recovered_pcm),
        })
    write_result('cpp-q8dd4-websocket-cancel.result.json', record)


def fast_cancel():
    record = {'test': 'fast-all-http-cancel'}
    pcm = bytearray()
    started = time.monotonic()
    request = speech_request('http://127.0.0.1:7864/v1/audio/speech', LONG)
    with urllib.request.urlopen(request, timeout=120) as response:
        request_id = response.headers.get('X-Request-ID')
        cancel_token = response.headers.get('X-Cancel-Token')
        record['has_request_id'] = bool(request_id)
        record['has_cancel_token'] = bool(cancel_token)
        first = response.read1(65536)
        pcm.extend(first)
        record['first_audio_seconds'] = time.monotonic() - started
        time.sleep(0.75)
        cancel_started = time.monotonic()
        headers = {'X-Request-ID': request_id or ''}
        if cancel_token:
            headers['X-Cancel-Token'] = cancel_token
        delete = urllib.request.Request(
            f'http://127.0.0.1:7864/v1/requests/{request_id}',
            headers=headers,
            method='DELETE',
        )
        try:
            with urllib.request.urlopen(delete, timeout=15) as cancel_response:
                record['cancel_http_status'] = cancel_response.status
                record['cancel_response'] = cancel_response.read().decode(errors='replace')[:500]
        except urllib.error.HTTPError as exc:
            record['cancel_http_status'] = exc.code
            record['cancel_response'] = exc.read().decode(errors='replace')[:500]
        record['cancel_ack_seconds'] = time.monotonic() - cancel_started
        try:
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                pcm.extend(chunk)
        except Exception as exc:
            record['stream_end_exception'] = repr(exc)
        record['stream_closed_after_cancel_seconds'] = time.monotonic() - cancel_started
        record['audio_seconds_received'] = len(pcm) / 48000
    idle_started = time.monotonic()
    for _ in range(100):
        with urllib.request.urlopen('http://127.0.0.1:7864/health', timeout=3) as health_response:
            health = json.loads(health_response.read().decode())
        if not health.get('busy'):
            break
        time.sleep(0.05)
    record['health_idle_after_cancel_seconds'] = time.monotonic() - idle_started
    record['health'] = health
    recovered = bytearray()
    recovery_started = time.monotonic()
    with urllib.request.urlopen(speech_request('http://127.0.0.1:7864/v1/audio/speech', SHORT), timeout=120) as response:
        recovery_first = None
        while True:
            chunk = response.read1(65536)
            if not chunk:
                break
            if recovery_first is None:
                recovery_first = time.monotonic() - recovery_started
            recovered.extend(chunk)
    record.update({
        'recovery_first_audio_seconds': recovery_first,
        'recovery_elapsed_seconds': time.monotonic() - recovery_started,
        'recovery_audio_seconds': len(recovered) / 48000,
        'success': record['cancel_http_status'] == 202 and not health.get('busy') and bool(recovered),
    })
    write_result('fast-all-http-cancel.result.json', record)


def main():
    capture_cpp_short()
    voice_id = register_voice()
    asyncio.run(cpp_cancel(voice_id))
    fast_cancel()


if __name__ == '__main__':
    main()
