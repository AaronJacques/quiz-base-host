"""Keeps a Piper voice loaded and synthesises one JSON request per stdin line.

Request:  {"id": 1, "text": "Hallo"}
Response: {"id": 1, "wav": "<base64 WAV>"}  or  {"id": 1, "error": "..."}
"""
import base64
import io
import json
import sys
import wave

from piper import PiperVoice, SynthesisConfig


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
    main()
