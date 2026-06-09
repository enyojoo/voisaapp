#!/usr/bin/env python3
"""Phase 0 gate: validate gemini-3.5-live-translate-preview bidirectional en↔es flip.

Usage:
  export GEMINI_API_KEY=...
  python scripts/spike-gemini-two-way.py --wav-en path/to/english.wav --wav-es path/to/spanish.wav

Streams each WAV (16kHz mono PCM) through one Live Translate session with
target_language_code=es and echo_target_language=True; prints input/output
transcription language codes to verify direction flip.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import struct
import sys
import wave

from google import genai
from google.genai import types

MODEL = "gemini-3.5-live-translate-preview"
SEND_SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1600  # 100ms @ 16kHz


def read_wav_pcm16_mono(path: str, target_rate: int = SEND_SAMPLE_RATE) -> bytes:
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise ValueError(f"{path}: expected 16-bit PCM, got width={width}")
    if channels != 1:
        raise ValueError(f"{path}: expected mono, got channels={channels}")
    if rate != target_rate:
        raise ValueError(f"{path}: expected {target_rate}Hz, got {rate}Hz (resample externally)")
    return frames


async def stream_pcm(session, pcm: bytes, label: str) -> None:
    chunk_bytes = CHUNK_SAMPLES * 2
    sent = 0
    for i in range(0, len(pcm), chunk_bytes):
        chunk = pcm[i : i + chunk_bytes]
        if not chunk:
            break
        await session.send_realtime_input(
            audio=types.Blob(data=chunk, mime_type=f"audio/pcm;rate={SEND_SAMPLE_RATE}")
        )
        sent += len(chunk)
        await asyncio.sleep(0.1)
    print(f"[{label}] sent {sent} bytes", flush=True)
    await asyncio.sleep(2.0)


async def drain_responses(session, label: str, max_seconds: float = 8.0) -> None:
    deadline = asyncio.get_event_loop().time() + max_seconds
    async for response in session.receive():
        sc = response.server_content
        if not sc:
            continue
        if sc.input_transcription and sc.input_transcription.text:
            lc = sc.input_transcription.language_code or "?"
            print(f"[{label}] IN ({lc}): {sc.input_transcription.text}", flush=True)
        if sc.output_transcription and sc.output_transcription.text:
            lc = sc.output_transcription.language_code or "?"
            print(f"[{label}] OUT ({lc}): {sc.output_transcription.text}", flush=True)
        if sc.model_turn and sc.model_turn.parts:
            for part in sc.model_turn.parts:
                if part.inline_data and isinstance(part.inline_data.data, bytes):
                    print(f"[{label}] audio chunk {len(part.inline_data.data)} bytes", flush=True)
        if asyncio.get_event_loop().time() > deadline:
            break


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav-en", required=True, help="English speech WAV (16kHz mono PCM)")
    parser.add_argument("--wav-es", required=True, help="Spanish speech WAV (16kHz mono PCM)")
    parser.add_argument("--target", default="es", help="target_language_code (default: es)")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("GEMINI_API_KEY is required", file=sys.stderr)
        return 1

    en_pcm = read_wav_pcm16_mono(args.wav_en)
    es_pcm = read_wav_pcm16_mono(args.wav_es)

    client = genai.Client(api_key=api_key)
    config = types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        translation_config=types.TranslationConfig(
            target_language_code=args.target,
            echo_target_language=True,
        ),
    )

    print(f"Connecting to {MODEL} target={args.target} echo=true", flush=True)
    async with client.aio.live.connect(model=MODEL, config=config) as session:
        recv_task = asyncio.create_task(drain_responses(session, "en-segment", 12.0))
        await stream_pcm(session, en_pcm, "EN")
        await asyncio.sleep(1.0)
        await stream_pcm(session, es_pcm, "ES")
        await asyncio.sleep(3.0)
        recv_task.cancel()
        try:
            await recv_task
        except asyncio.CancelledError:
            pass

    print("Spike complete — verify OUT language codes flipped between segments.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
