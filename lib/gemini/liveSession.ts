import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai/web';

import { GEMINI_LIVE_TRANSLATE_MODEL } from '@/lib/gemini/constants';

export type SessionResumptionUpdate = {
  resumable?: boolean;
  newHandle?: string;
};

export type GeminiLiveSessionCallbacks = {
  onOpen?: (handle: GeminiLiveSessionHandle) => void;
  onClose?: (reason?: string) => void;
  onError?: (message: string) => void;
  onInputTranscription?: (text: string, languageCode?: string, finished?: boolean) => void;
  onOutputTranscription?: (text: string, languageCode?: string, finished?: boolean) => void;
  onAudioChunk?: (data: string | Uint8Array | ArrayBuffer) => void;
  onTurnComplete?: () => void;
  onGenerationComplete?: () => void;
  onInterrupted?: () => void;
  onGoAway?: (timeLeft?: string) => void;
  onSessionResumptionUpdate?: (update: SessionResumptionUpdate) => void;
};

export type GeminiLiveSessionHandle = {
  sendPcm16Base64: (base64Pcm: string) => void;
  sendAudioStreamEnd: () => void;
  close: () => void;
};

export async function connectGeminiLiveSession(opts: {
  ephemeralToken: string;
  model?: string;
  targetLanguageCode?: string;
  resumptionHandle?: string;
  callbacks: GeminiLiveSessionCallbacks;
}): Promise<GeminiLiveSessionHandle> {
  const ai = new GoogleGenAI({
    apiKey: opts.ephemeralToken,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  let session: Session | null = null;
  let closed = false;
  const pendingPcm: string[] = [];

  const flushPendingPcm = () => {
    if (!session || closed || pendingPcm.length === 0) return;
    for (const base64Pcm of pendingPcm) {
      void session.sendRealtimeInput({
        audio: {
          data: base64Pcm,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    }
    pendingPcm.length = 0;
  };

  const handle: GeminiLiveSessionHandle = {
    sendPcm16Base64(base64Pcm: string) {
      if (closed) return;
      if (!session) {
        pendingPcm.push(base64Pcm);
        return;
      }
      void session.sendRealtimeInput({
        audio: {
          data: base64Pcm,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    },
    sendAudioStreamEnd() {
      if (closed || !session) return;
      void session.sendRealtimeInput({ audioStreamEnd: true });
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

  const handleMessage = (message: LiveServerMessage) => {
    if (message.goAway) {
      opts.callbacks.onGoAway?.(message.goAway.timeLeft);
    }

    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      opts.callbacks.onSessionResumptionUpdate?.({
        resumable: update.resumable ?? undefined,
        newHandle: update.newHandle ?? undefined,
      });
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

    if (sc.generationComplete) {
      opts.callbacks.onGenerationComplete?.();
    }

    if (sc.turnComplete) {
      opts.callbacks.onTurnComplete?.();
    }
  };

  const sessionResumption = opts.resumptionHandle
    ? { handle: opts.resumptionHandle }
    : {};

  session = await ai.live.connect({
    model: opts.model ?? GEMINI_LIVE_TRANSLATE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption,
      contextWindowCompression: { slidingWindow: {} },
      ...(opts.targetLanguageCode
        ? {
            translationConfig: {
              targetLanguageCode: opts.targetLanguageCode,
              echoTargetLanguage: false,
            },
          }
        : {}),
    },
    callbacks: {
      onopen: () => {
        flushPendingPcm();
        opts.callbacks.onOpen?.(handle);
      },
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

  flushPendingPcm();
  return handle;
}
