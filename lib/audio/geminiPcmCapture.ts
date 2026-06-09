import { AudioRecorder } from 'react-native-audio-api';

import { GEMINI_INPUT_SAMPLE_RATE, GEMINI_PCM_CHUNK_BYTES } from '@/lib/gemini/constants';
import { float32ToInt16LE, pcm16ToBase64 } from '@/lib/audio/pcmUtils';

export type PcmChunkHandler = (base64Pcm: string) => void;

const CHUNK_SAMPLES = GEMINI_PCM_CHUNK_BYTES / 2;

export class GeminiPcmCapture {
  readonly #recorder = new AudioRecorder();
  #running = false;
  #onChunk: PcmChunkHandler | null = null;
  #pending = new Int16Array(0);

  start(onChunk: PcmChunkHandler): void {
    if (this.#running) return;
    this.#onChunk = onChunk;
    this.#pending = new Int16Array(0);

    const ready = this.#recorder.onAudioReady(
      {
        sampleRate: GEMINI_INPUT_SAMPLE_RATE,
        bufferLength: CHUNK_SAMPLES,
        channelCount: 1,
      },
      ({ buffer }) => {
        if (!this.#onChunk) return;
        const channel = buffer.getChannelData(0);
        const int16 = float32ToInt16LE(channel);
        this.#appendAndEmit(int16);
      },
    );
    if (ready.status === 'error') {
      throw new Error(ready.message);
    }

    const started = this.#recorder.start();
    if (started.status === 'error') {
      throw new Error(started.message);
    }

    this.#running = true;
  }

  stop(): void {
    if (!this.#running) return;
    this.#recorder.clearOnAudioReady();
    this.#recorder.stop();
    this.#running = false;
    this.#onChunk = null;
    this.#pending = new Int16Array(0);
  }

  #appendAndEmit(chunk: Int16Array): void {
    const merged = new Int16Array(this.#pending.length + chunk.length);
    merged.set(this.#pending, 0);
    merged.set(chunk, this.#pending.length);
    this.#pending = merged;

    while (this.#pending.length >= CHUNK_SAMPLES) {
      const slice = this.#pending.slice(0, CHUNK_SAMPLES);
      this.#pending = this.#pending.slice(CHUNK_SAMPLES);
      this.#onChunk?.(pcm16ToBase64(slice));
    }
  }
}
