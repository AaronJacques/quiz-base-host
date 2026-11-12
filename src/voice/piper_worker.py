"""Keeps a Piper voice loaded and synthesises one JSON request per stdin line.

Request:  {"id": 1, "text": "Hallo"}
Response: {"id": 1, "wav": "<base64 WAV>"}  or  {"id": 1, "error": "..."}

Ctrl+C in the terminal reaches the whole process group. The worker ignores SIGINT, so the bot can
still say goodbye while it shuts down; it ends when its stdin closes (the bot exits, or closes it).
"""
import signal

signal.signal(signal.SIGINT, signal.SIG_IGN)  # before the slow imports below

import base64  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import wave  # noqa: E402

from piper import PiperVoice, SynthesisConfig  # noqa: E402


def main() -> None:
    model, length_scale = sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    voice = PiperVoice.load(model)
    config = SynthesisConfig(length_scale=length_scale)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wav:
                voice.synthesize_wav(req["text"], wav, syn_config=config)
            out = {"id": req["id"], "wav": base64.b64encode(buf.getvalue()).decode()}
        except Exception as e:  # noqa: BLE001 - report every failure to the caller
            out = {"id": req["id"], "error": str(e)}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:  # the bot is gone – nothing to report to
        sys.exit(0)
