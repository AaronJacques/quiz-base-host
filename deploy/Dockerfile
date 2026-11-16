# syntax=docker/dockerfile:1
# Quizmaster (qbhost discord): headless Chromium for quiz-base, whisper.cpp (STT), Piper (TTS).
# The judge uses the Anthropic API (llm.provider "anthropic", ANTHROPIC_API_KEY) – no Claude CLI in the image.
# Built on the server itself (deploy/remote-deploy.sh), so whisper.cpp is compiled for exactly that CPU.

# ── whisper.cpp ───────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS whisper
ARG WHISPER_VERSION=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=ON \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON \
 && cmake --build /build -j"$(nproc)" --target whisper-server \
 && install -m 755 /build/bin/whisper-server /usr/local/bin/whisper-server

# ── runtime ───────────────────────────────────────────────────────────────────
# Playwright image = Ubuntu 24.04 + Node + Chromium with all system libraries; must match package.json.
FROM mcr.microsoft.com/playwright:v1.58.2-noble
ARG PIPER_VERSION=1.3.0
# Parakeet STT (voice.localStt "parakeet"), must equal SHERPA_ONNX_VERSION in src/voice/stt-sherpa.ts (a test checks it).
# ~40 MB in the image; the model (~490 MB, .tar.bz2 – hence bzip2) is only downloaded by voice-setup when the config asks for it.
ARG SHERPA_ONNX_VERSION=2.0.1
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv libgomp1 tini bzip2 \
 && rm -rf /var/lib/apt/lists/*
# Piper (and sherpa-onnx) live in the image; the voice setup expects them at <voice.dir>/venv (linked by the
# entrypoint). The container user cannot write /opt, so voice-setup only checks sherpa-onnx here.
RUN python3 -m venv /opt/piper && /opt/piper/bin/pip install --no-cache-dir "piper-tts==${PIPER_VERSION}" "sherpa-onnx==${SHERPA_ONNX_VERSION}"
COPY --from=whisper /usr/local/bin/whisper-server /usr/local/bin/whisper-server

WORKDIR /app
COPY package.json package-lock.json ./
# tsx (runtime) is a dev dependency – install everything.
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY . .
COPY deploy/entrypoint.sh /usr/local/bin/qbhost-entrypoint
RUN chmod 755 /usr/local/bin/qbhost-entrypoint

# Runtime data (.qbhost: browser profile, judge cache, links, voice models) is a volume; HOME lives in it
# because the container runs as the unprivileged deploy user (no home directory in the image).
ENV NODE_ENV=production HOME=/app/.qbhost/home
ENTRYPOINT ["tini", "--", "/usr/local/bin/qbhost-entrypoint"]
CMD ["node_modules/.bin/tsx", "src/cli.ts", "discord"]
