import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, unstable_batchedUpdates } from 'react-native';

import {
  prepareVoisaAudioSession,
  teardownVoisaAudioSession,
  type VoisaOutputRoute,
} from '@/lib/audio/audioSession';
import { GeminiPcmCapture } from '@/lib/audio/geminiPcmCapture';
import { GeminiPcmPlayback } from '@/lib/audio/geminiPcmPlayback';
import { connectGeminiLiveSession, type GeminiLiveSessionHandle } from '@/lib/gemini/liveSession';
import { mintGeminiLiveToken, type GeminiLiveTokenResponse } from '@/lib/gemini/token';
import { normalizeGeminiLanguageCode } from '@/lib/geminiLanguages';
import {
  mergeContinuationParagraph,
  sanitizeTranscriptDisplay,
  translationForDisplay,
} from '@/lib/transcriptDisplay';

export type TranslatorUiConnection =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type FinalTranscriptSegment = {
  id: string;
  original: string;
  translated: string;
  ts?: number;
};

const FINAL_MERGE_WINDOW_MS = 12_000;
/** Ephemeral tokens must connect within ~10 min; prefetch slightly under that. */
const TOKEN_PREFETCH_MAX_AGE_MS = 8 * 60 * 1000;
/** Buffer mic PCM while the Gemini WebSocket is still opening (~100 ms/chunk). */
const MAX_WARMUP_PCM_CHUNKS = 40;

type CachedToken = {
  key: string;
  response: GeminiLiveTokenResponse;
  mintedAt: number;
};

function appendMergedFinalSegment(
  prev: FinalTranscriptSegment[],
  original: string,
  translated: string,
  now: number,
): FinalTranscriptSegment[] {
  const o = sanitizeTranscriptDisplay(original);
  const t = sanitizeTranscriptDisplay(translated);
  if (!o && !t) return prev;

  if (prev.length === 0) {
    return [{ id: `${now}-${Math.random().toString(36).slice(2, 10)}`, original: o, translated: t, ts: now }];
  }

  const last = prev[prev.length - 1];
  const lastTs = last.ts ?? now;

  if (now - lastTs > FINAL_MERGE_WINDOW_MS) {
    return [...prev, { id: `${now}-${Math.random().toString(36).slice(2, 10)}`, original: o, translated: t, ts: now }];
  }

  return [
    ...prev.slice(0, -1),
    {
      ...last,
      original: mergeContinuationParagraph(last.original, o),
      translated: mergeContinuationParagraph(last.translated, t),
      ts: now,
    },
  ];
}

export function useGeminiLiveTranslator() {
  const [connection, setConnectionState] = useState<TranslatorUiConnection>('idle');
  const setConnection = useCallback((next: TranslatorUiConnection) => {
    connectionRef.current = next;
    setConnectionState(next);
  }, []);
  const [lastError, setLastError] = useState<string | null>(null);
  const [micLive, setMicLive] = useState(false);
  const [liveOriginal, setLiveOriginal] = useState('');
  const [liveTranslated, setLiveTranslated] = useState('');
  const [segments, setSegments] = useState<FinalTranscriptSegment[]>([]);
  const [outputRoute, setOutputRoute] = useState<VoisaOutputRoute>('earpiece');

  const sessionEpochRef = useRef(0);
  const connectionRef = useRef<TranslatorUiConnection>('idle');
  const liveSessionRef = useRef<GeminiLiveSessionHandle | null>(null);
  const captureRef = useRef<GeminiPcmCapture | null>(null);
  const playbackRef = useRef<GeminiPcmPlayback | null>(null);
  const activePairRef = useRef<{ languageA: string; languageB: string } | null>(null);
  const pendingOriginalRef = useRef('');
  const pendingTranslatedRef = useRef('');
  const tokenCacheRef = useRef<CachedToken | null>(null);
  const warmupEpochRef = useRef(0);
  const pcmWarmupBufferRef = useRef<string[]>([]);
  const streamReadyRef = useRef(false);

  const pairKey = (languageA: string, languageB: string) => `${languageA}|${languageB}`;

  const takeCachedToken = useCallback((languageA: string, languageB: string) => {
    const key = pairKey(languageA, languageB);
    const cached = tokenCacheRef.current;
    if (!cached || cached.key !== key) return null;
    if (Date.now() - cached.mintedAt > TOKEN_PREFETCH_MAX_AGE_MS) {
      tokenCacheRef.current = null;
      return null;
    }
    tokenCacheRef.current = null;
    return cached.response;
  }, []);

  const warmupSession = useCallback(async (opts: { languageA: string; languageB: string }) => {
    const languageA = normalizeGeminiLanguageCode(opts.languageA);
    const languageB = normalizeGeminiLanguageCode(opts.languageB);
    const key = pairKey(languageA, languageB);
    warmupEpochRef.current += 1;
    const epoch = warmupEpochRef.current;

    const cached = tokenCacheRef.current;
    if (cached?.key === key && Date.now() - cached.mintedAt <= TOKEN_PREFETCH_MAX_AGE_MS) {
      return;
    }

    try {
      const response = await mintGeminiLiveToken(languageA, languageB);
      if (epoch !== warmupEpochRef.current) return;
      tokenCacheRef.current = { key, response, mintedAt: Date.now() };
    } catch {
      /* startSession will mint on demand */
    }
  }, []);

  const commitFinal = useCallback((original: string, translated: string) => {
    const o = sanitizeTranscriptDisplay(original);
    const t = translationForDisplay(o, sanitizeTranscriptDisplay(translated));
    if (!o && !t) return;
    const now = Date.now();
    unstable_batchedUpdates(() => {
      setSegments((prev) => appendMergedFinalSegment(prev, o, t, now));
      setLiveOriginal('');
      setLiveTranslated('');
    });
    pendingOriginalRef.current = '';
    pendingTranslatedRef.current = '';
  }, []);

  const flushWarmupPcm = useCallback((handle: GeminiLiveSessionHandle) => {
    for (const chunk of pcmWarmupBufferRef.current) {
      handle.sendPcm16Base64(chunk);
    }
    pcmWarmupBufferRef.current = [];
  }, []);

  const startMicCapture = useCallback(
    (capture: GeminiPcmCapture, epoch: number) => {
      pcmWarmupBufferRef.current = [];
      streamReadyRef.current = false;
      capture.start((base64) => {
        if (epoch !== sessionEpochRef.current) return;
        if (streamReadyRef.current && liveSessionRef.current) {
          liveSessionRef.current.sendPcm16Base64(base64);
          return;
        }
        const buf = pcmWarmupBufferRef.current;
        buf.push(base64);
        if (buf.length > MAX_WARMUP_PCM_CHUNKS) buf.shift();
      });
      setMicLive(true);
    },
    [],
  );

  const teardownRuntime = useCallback(async () => {
    streamReadyRef.current = false;
    pcmWarmupBufferRef.current = [];
    captureRef.current?.stop();
    captureRef.current = null;
    liveSessionRef.current?.close();
    liveSessionRef.current = null;
    if (playbackRef.current) {
      await playbackRef.current.teardown();
      playbackRef.current = null;
    }
    await teardownVoisaAudioSession();
    if (Platform.OS === 'ios') {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    setMicLive(false);
  }, []);

  const startSession = useCallback(
    async (opts: { languageA: string; languageB: string }) => {
      const languageA = normalizeGeminiLanguageCode(opts.languageA);
      const languageB = normalizeGeminiLanguageCode(opts.languageB);

      setLastError(null);
      setMicLive(false);
      sessionEpochRef.current += 1;
      warmupEpochRef.current += 1;
      const epoch = sessionEpochRef.current;
      activePairRef.current = { languageA, languageB };
      setConnection('connecting');

      if (liveSessionRef.current || captureRef.current || playbackRef.current) {
        await teardownRuntime();
        if (epoch !== sessionEpochRef.current) return;
      }

      try {
        const capture = new GeminiPcmCapture();
        captureRef.current = capture;

        const tokenPromise = (async () => {
          const cached = takeCachedToken(languageA, languageB);
          if (cached) return cached;
          return mintGeminiLiveToken(languageA, languageB);
        })();

        const [tokenResp, , playback] = await Promise.all([
          tokenPromise,
          prepareVoisaAudioSession(setOutputRoute),
          (async () => {
            const player = new GeminiPcmPlayback();
            await player.prepare();
            return player;
          })(),
        ]);

        if (epoch !== sessionEpochRef.current) {
          await playback.teardown();
          await teardownVoisaAudioSession();
          return;
        }

        playbackRef.current = playback;
        startMicCapture(capture, epoch);

        const handle = await connectGeminiLiveSession({
          ephemeralToken: tokenResp.token,
          model: tokenResp.model,
          callbacks: {
            onOpen: () => {
              if (epoch !== sessionEpochRef.current) return;
              setConnection('connected');
              streamReadyRef.current = true;
            },
            onInputTranscription: (text) => {
              if (epoch !== sessionEpochRef.current) return;
              pendingOriginalRef.current = sanitizeTranscriptDisplay(text);
              setLiveOriginal(pendingOriginalRef.current);
            },
            onOutputTranscription: (text) => {
              if (epoch !== sessionEpochRef.current) return;
              const o = pendingOriginalRef.current;
              pendingTranslatedRef.current = translationForDisplay(o, sanitizeTranscriptDisplay(text));
              setLiveTranslated(pendingTranslatedRef.current);
            },
            onAudioChunk: (data) => {
              playbackRef.current?.enqueueInlineData(data);
            },
            onTurnComplete: () => {
              if (epoch !== sessionEpochRef.current) return;
              commitFinal(pendingOriginalRef.current, pendingTranslatedRef.current);
            },
            onInterrupted: () => {
              if (epoch !== sessionEpochRef.current) return;
              playbackRef.current?.clearScheduled();
            },
            onError: (message) => {
              if (epoch !== sessionEpochRef.current) return;
              setLastError(message);
              setConnection('error');
            },
            onClose: () => {
              if (epoch !== sessionEpochRef.current) return;
              if (connectionRef.current !== 'error') {
                setConnection('idle');
              }
              setMicLive(false);
            },
          },
        });

        if (epoch !== sessionEpochRef.current) {
          handle.close();
          return;
        }

        liveSessionRef.current = handle;
        if (streamReadyRef.current) {
          flushWarmupPcm(handle);
        }
      } catch (e) {
        if (epoch !== sessionEpochRef.current) return;
        await teardownRuntime();
        const msg = e instanceof Error ? e.message : String(e);
        setLastError(msg);
        setConnection('error');
        throw e;
      }
    },
    [commitFinal, flushWarmupPcm, setConnection, startMicCapture, takeCachedToken, teardownRuntime],
  );

  const stopSession = useCallback(async () => {
    sessionEpochRef.current += 1;
    warmupEpochRef.current += 1;
    tokenCacheRef.current = null;
    activePairRef.current = null;
    pendingOriginalRef.current = '';
    pendingTranslatedRef.current = '';
    setLiveOriginal('');
    setLiveTranslated('');
    setLastError(null);
    setConnection('idle');
    setOutputRoute('earpiece');
    await teardownRuntime();
  }, [teardownRuntime]);

  useEffect(() => {
    return () => {
      void stopSession();
    };
  }, [stopSession]);

  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const hasLive = liveOriginal.length > 0 || liveTranslated.length > 0;
    if (!hasLive) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [liveOriginal, liveTranslated]);

  const liveContinuationSegmentId = useMemo(() => {
    if (liveOriginal.length === 0 && liveTranslated.length === 0) return null;
    if (segments.length === 0) return null;
    const last = segments[segments.length - 1];
    const lastTs = last.ts ?? 0;
    if (Date.now() - lastTs > FINAL_MERGE_WINDOW_MS) return null;
    return last.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOriginal, liveTranslated, segments, nowTick]);

  return {
    connection,
    lastError,
    micLive,
    liveOriginal,
    liveTranslated,
    segments,
    liveContinuationSegmentId,
    outputRoute,
    warmupSession,
    startSession,
    stopSession,
    clearSegments: () => setSegments([]),
  };
}
