"""Keeps NVIDIA Parakeet (sherpa-onnx, offline transducer) loaded and recognises one JSON request per stdin line.

Start:    sherpa_worker.py <model dir> <threads>
Ready:    {"ready": true, "loadMs": 4800}
Request:  {"id": 1, "pcm": "<base64 s16le, 16 kHz, mono>"}
Response: {"id": 1, "text": "..."}  or  {"id": 1, "error": "..."}
Stats:    {"id": 2, "op": "stats"}  ->  {"id": 2, "peakMb": 874}

Never writes recognised text anywhere but its answer on stdout (no log of what people say).
Ctrl+C in the terminal reaches the whole process group: the worker ignores SIGINT, so the bot can
finish what it hears while it shuts down; it ends when its stdin closes (the bot exits, or closes it).
"""
import signal

signal.signal(signal.SIGINT, signal.SIG_IGN)  # before the slow imports below

import array  # noqa: E402
import base64  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import resource  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import sherpa_onnx  # noqa: E402

RATE = 16000


def peak_mb() -> int:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024)  # bytes on macOS, KiB on Linux


def samples(pcm_b64: str) -> list:
    pcm = array.array("h")
    pcm.frombytes(base64.b64decode(pcm_b64))
    if sys.byteorder != "little":
        pcm.byteswap()
    return [s / 32768.0 for s in pcm]


def main() -> None:
    model, threads = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 1
    t0 = time.perf_counter()
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(model, "encoder.int8.onnx"),
        decoder=os.path.join(model, "decoder.int8.onnx"),
        joiner=os.path.join(model, "joiner.int8.onnx"),
        tokens=os.path.join(model, "tokens.txt"),
        num_threads=max(1, threads),
        model_type="nemo_transducer",
    )
    print(json.dumps({"ready": True, "loadMs": round((time.perf_counter() - t0) * 1000)}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue  # nothing to answer to
        rid = req.get("id")
        try:
            if req.get("op") == "stats":
                out = {"id": rid, "peakMb": peak_mb()}
            else:
                stream = rec.create_stream()
                stream.accept_waveform(RATE, samples(req["pcm"]))
                rec.decode_stream(stream)
                out = {"id": rid, "text": stream.result.text}
        except Exception as e:  # noqa: BLE001 - report every failure to the caller (never the text)
            out = {"id": rid, "error": type(e).__name__ + ": " + str(e)[:200]}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:  # the bot is gone – nothing to report to
        sys.exit(0)
