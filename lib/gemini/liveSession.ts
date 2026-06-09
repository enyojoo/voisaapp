import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai/web';

import { GEMINI_LIVE_TRANSLATE_MODEL } from '@/lib/gemini/constants';

export type GeminiLiveSessionCallbacks = {
  onOpen?: () => void;
  onClose?: (reason?: string) => void;
  onError?: (message: string) => void;
  onInputTranscription?: (text: string, languageCode?: string, finished?: boolean) => void;
  onOutputTranscription?: (text: string, languageCode?: string, finished?: boolean) => void;
  onAudioChunk?: (data: string | Uint8Array | ArrayBuffer) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onGoAway?: (timeLeft?: string) => void;
};

export type GeminiLiveSessionHandle = {
  sendPcm16Base64: (base64Pcm: string) => void;
  close: () => void;
};

export async function connectGeminiLiveSession(opts: {
  ephemeralToken: string;
  model?: string;
  callbacks: GeminiLiveSessionCallbacks;
}): Promise<GeminiLiveSessionHandle> {
  const ai = new GoogleGenAI({
    apiKey: opts.ephemeralToken,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  let session: Session | null = null;
  let closed = false;

  const handleMessage = (message: LiveServerMessage) => {
    if (message.goAway) {
      opts.callbacks.onGoAway?.(message.goAway.timeLeft);
    }

    const sc = message.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      opts.callbacks.onInputTranscription?.(
        sc.inputTranscription.text,
        sc.inputTranscription.languageCode ?? undefined,
        sc.inputTranscription.finished ?? undefined,
      );
    }

    if (sc.outputTranscription?.text) {
      opts.callbacks.onOutputTranscription?.(
        sc.outputTranscription.text,
        sc.outputTranscription.languageCode ?? undefined,
        sc.outputTranscription.finished ?? undefined,
      );
    }

    const parts = sc.modelTurn?.parts;
    if (parts?.length) {
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline?.data) {
          opts.callbacks.onAudioChunk?.(inline.data as string | Uint8Array | ArrayBuffer);
        }
      }
    }

    if (sc.interrupted) {
      opts.callbacks.onInterrupted?.();
    }

    if (sc.turnComplete) {
      opts.callbacks.onTurnComplete?.();
    }
  };

  session = await ai.live.connect({
    model: opts.model ?? GEMINI_LIVE_TRANSLATE_MODEL,
    config: {},
    callbacks: {
      onopen: () => opts.callbacks.onOpen?.(),
      onmessage: handleMessage,
      onerror: (e: ErrorEvent) => {
        if (!closed) opts.callbacks.onError?.(e.message ?? 'Gemini Live error');
      },
      onclose: (e: CloseEvent) => {
        closed = true;
        opts.callbacks.onClose?.(e.reason);
      },
    },
  });

  return {
    sendPcm16Base64(base64Pcm: string) {
      if (!session || closed) return;
      void session.sendRealtimeInput({
        audio: {
          data: base64Pcm,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      session = null;
    },
  };
}
