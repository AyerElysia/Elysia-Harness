"""
dsh-livestream 的语音识别进程：B 站视频没有字幕时，听一段、写成带时间的字幕。插件按需启动它，一场直播里一直开着（模型只加载一次）。

装法（任何一个 Python 3.9+ 都行，放哪都可以，路径填到插件设置的 asrPython）：
    python -m venv asr-venv
    asr-venv/Scripts/python -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
    （没有 NVIDIA 显卡只装 faster-whisper，用 CPU，模型换小一点的，比如 small）

用法：python whisper_worker.py --model large-v3-turbo --models-dir <模型放哪>
    stdin  一行一个请求 {"id": "...", "url": "...", "headers": "Referer: ...\\r\\n", "from": 秒, "to": 秒}
    stdout 先一行 {"ready": true, "device": "cuda", "model": "..."}；
           每个请求回一行 {"id": "...", "lang": "zh", "lines": [{"from": 秒, "to": 秒, "text": "..."}]}
           或 {"id": "...", "error": "..."}
音频直接从地址读（PyAV，faster-whisper 自带），只取 from–to 这一段：不用 ffmpeg，也不用下载整个文件。
"""

import argparse
import json
import os
import sys
import time

# 中文默认会写出繁体字：给一句简体的开头，后面就跟着写简体
PROMPTS = {"zh": "以下是普通话的句子，使用简体中文。"}


def add_cuda_dlls() -> None:
    """Windows 上 pip 装的 nvidia-cublas / nvidia-cudnn 的 DLL 不在搜索路径里，加进去"""
    if os.name != "nt":
        return
    for base in sys.path:
        root = os.path.join(base, "nvidia")
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            bin_dir = os.path.join(root, name, "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def load_model(name: str, device: str, models_dir: str):
    from faster_whisper import WhisperModel

    if device in ("auto", "cuda"):
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                return WhisperModel(name, device="cuda", compute_type="float16", download_root=models_dir or None), "cuda"
        except Exception as err:  # 显卡用不了（驱动、DLL）：退回 CPU
            print(f"cuda unavailable: {err}", file=sys.stderr)
    return WhisperModel(name, device="cpu", compute_type="int8", download_root=models_dir or None), "cpu"


def read_audio(url: str, headers: str, start: float, end: float):
    """从地址读 start–end 秒，16 kHz 单声道 float32"""
    import av
    import numpy as np

    options = {"headers": headers, "rw_timeout": "20000000"} if headers else {"rw_timeout": "20000000"}
    chunks = []
    with av.open(url, options=options, timeout=20) as container:
        stream = container.streams.audio[0]
        if start > 0:
            container.seek(int(start * av.time_base), backward=True)
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        first = None
        for frame in container.decode(stream):
            t = float(frame.pts * frame.time_base) if frame.pts is not None else None
            if t is not None and t + frame.samples / frame.sample_rate < start:
                continue
            if t is not None and t >= end:
                break
            if first is None:
                first = t if t is not None else start
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32), start
    audio = np.concatenate(chunks).astype(np.float32) / 32768.0
    # seek 落在 start 之前的关键帧：把前面多出来的剪掉
    skip = max(0, int((start - first) * 16000))
    audio = audio[skip : skip + int((end - start) * 16000)]
    return audio, start


def transcribe(model, audio, offset: float):
    if len(audio) < 16000:
        return "", []
    lang, _prob, _all = model.detect_language(audio)
    segments, _info = model.transcribe(
        audio,
        language=lang,
        initial_prompt=PROMPTS.get(lang),
        vad_filter=True,
        # 不拿上一句当提示：背景音乐里容易一句话重复下去
        condition_on_previous_text=False,
        beam_size=5,
    )
    lines = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            lines.append({"from": round(offset + seg.start, 2), "to": round(offset + seg.end, 2), "text": text})
    return lang, lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--models-dir", default="")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    add_cuda_dlls()
    model, device = load_model(args.model, args.device, args.models_dir)
    # 先听一秒静音：显卡第一次跑要初始化好几秒，放在准备阶段，别让第一次识别等
    import numpy as np

    list(model.transcribe(np.zeros(16000, dtype=np.float32), language="zh")[0])

    def send(obj) -> None:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    send({"ready": True, "device": device, "model": args.model})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        req = {}
        try:
            req = json.loads(raw)
            t0 = time.time()
            audio, offset = read_audio(req["url"], req.get("headers", ""), float(req["from"]), float(req["to"]))
            t1 = time.time()
            lang, lines = transcribe(model, audio, offset)
            send({"id": req["id"], "lang": lang, "lines": lines, "audioSec": round(len(audio) / 16000, 1), "readMs": int((t1 - t0) * 1000), "asrMs": int((time.time() - t1) * 1000)})
        except Exception as err:
            send({"id": req.get("id"), "error": f"{type(err).__name__}: {err}"[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
