import { AudioBufferSourceNode, AudioContext, GainNode } from 'react-native-audio-api';

import { voisaTranslatedAudioVolume } from '@/lib/config';
import { GEMINI_OUTPUT_SAMPLE_RATE } from '@/lib/gemini/constants';
import { decodeInlineAudioData, int16ToFloat32 } from '@/lib/audio/pcmUtils';

export class GeminiPcmPlayback {
  readonly #ctx: AudioContext;
  readonly #gain: GainNode;
  #nextTime = 0;
  #armed = false;
  #scheduled: InstanceType<typeof AudioBufferSourceNode>[] = [];
  #onPlaybackIdle: (() => void) | null = null;

  constructor() {
    this.#ctx = new AudioContext({ sampleRate: GEMINI_OUTPUT_SAMPLE_RATE });
    this.#gain = this.#ctx.createGain();
    this.#gain.gain.value = voisaTranslatedAudioVolume();
    this.#gain.connect(this.#ctx.destination);
  }

  async prepare(): Promise<void> {
    await this.#ctx.resume();
    this.#nextTime = this.#ctx.currentTime + 0.05;
    this.#armed = true;
  }

  setOnPlaybackIdle(callback: (() => void) | null): void {
    this.#onPlaybackIdle = callback;
  }

  /** True while queued buffers are scheduled or still playing. */
  hasScheduledAudio(): boolean {
    return this.#scheduled.length > 0 || this.#nextTime > this.#ctx.currentTime + 0.02;
  }

  #notifyIdleIfDrained(): void {
    if (!this.hasScheduledAudio()) {
      this.#onPlaybackIdle?.();
    }
  }

  /** Re-resume after OS output route changes (headphones plug/unplug). */
  async syncOutputRoute(): Promise<void> {
    if (!this.#armed) return;
    try {
      await this.#ctx.resume();
    } catch {
      /* ignore */
    }
  }

  enqueueInlineData(data: string | Uint8Array | ArrayBuffer): void {
    if (!this.#armed) return;
    const int16 = decodeInlineAudioData(data);
    if (int16.length === 0) return;

    const float32 = int16ToFloat32(int16);
    const buffer = this.#ctx.createBuffer(1, float32.length, GEMINI_OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const source = this.#ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    this.#scheduled.push(source);
    source.onEnded = () => {
      this.#scheduled = this.#scheduled.filter((node) => node !== source);
      this.#notifyIdleIfDrained();
    };

    const startAt = Math.max(this.#ctx.currentTime, this.#nextTime);
    source.start(startAt);
    this.#nextTime = startAt + buffer.duration;
  }

  /** Gemini `interrupted` — drop queued TTS so playback does not talk over the user. */
  clearScheduled(): void {
    for (const source of this.#scheduled) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.#scheduled = [];
    this.#nextTime = this.#ctx.currentTime + 0.05;
    this.#notifyIdleIfDrained();
  }

  async teardown(): Promise<void> {
    this.clearScheduled();
    this.#armed = false;
    try {
      await this.#ctx.close();
    } catch {
      /* ignore */
    }
  }
}
