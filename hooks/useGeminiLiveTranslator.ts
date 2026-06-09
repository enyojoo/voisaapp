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
import {
  tokenCacheKey,
  translationDirectionFromPair,
  translationTargetForDetectedSource,
} from '@/lib/gemini/translationTarget';
import { normalizeGeminiLanguageCode } from '@/lib/geminiLanguages';
import {
  appendTranscriptionFragment,
  mergeContinuationParagraph,
  sanitizeTranscriptDisplay,
  translationForDisplay,
} from '@/lib/transcriptDisplay';

export type TranslatorUiConnection =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export type MicSessionPhase = 'listening' | 'responseTail' | 'idle';

export type FinalTranscriptSegment = {
  id: string;
  original: string;
  translated: string;
  ts?: number;
};

const FINAL_MERGE_WINDOW_MS = 12_000;
/** Ephemeral tokens must connect within ~10 min; prefetch slightly under that. */
const TOKEN_PREFETCH_MAX_AGE_MS = 8 * 60 * 1000;
/** Mint a fresh token ~5 min before the 30 min expireTime. */
const TOKEN_REFRESH_BEFORE_EXPIRE_MS = 5 * 60 * 1000;
/** Buffer mic PCM while the Gemini WebSocket is still opening (~100 ms/chunk). */
const MAX_WARMUP_PCM_CHUNKS = 40;
/** Avoid thrashing when Gemini flickers language detection between chunks. */
const TARGET_FLIP_COOLDOWN_MS = 1_500;
/** Debounce before resuming mic after response-tail playback drains. */
const MIC_RESUME_DEBOUNCE_MS = 150;
/** Backoff for silent Gemini WebSocket resumption (10 min server lifetime). */
const RESUME_RETRY_INITIAL_MS = 400;
const RESUME_RETRY_MAX_MS = 8_000;

type CachedToken = {
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
  const [detectedSourceLanguage, setDetectedSourceLanguage] = useState<string | null>(null);
  const [activeTargetLanguage, setActiveTargetLanguage] = useState<string | null>(null);
  const [languagePair, setLanguagePair] = useState<{ languageA: string; languageB: string } | null>(
    null,
  );

  const sessionEpochRef = useRef(0);
  const connectionRef = useRef<TranslatorUiConnection>('idle');
  const liveSessionRef = useRef<GeminiLiveSessionHandle | null>(null);
  const captureRef = useRef<GeminiPcmCapture | null>(null);
  const playbackRef = useRef<GeminiPcmPlayback | null>(null);
  const activePairRef = useRef<{ languageA: string; languageB: string } | null>(null);
  const sessionTargetRef = useRef<string | null>(null);
  const pendingOriginalRef = useRef('');
  const pendingTranslatedRef = useRef('');
  const tokenCacheRef = useRef<Map<string, CachedToken>>(new Map());
  const warmupEpochRef = useRef(0);
  const pcmWarmupBufferRef = useRef<string[]>([]);
  const streamReadyRef = useRef(false);
  const flipInProgressRef = useRef(false);
  const lastFlipAtRef = useRef(0);
  const micPhaseRef = useRef<MicSessionPhase>('idle');
  const ignoreLateAudioRef = useRef(false);
  const micResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userSessionActiveRef = useRef(false);
  const resumptionHandleRef = useRef<string | undefined>(undefined);
  const activeTokenRef = useRef<GeminiLiveTokenResponse | null>(null);
  const resumeScheduledRef = useRef(false);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectLiveRef = useRef<
    (opts: {
      epoch: number;
      tokenResp: GeminiLiveTokenResponse;
      resumptionHandle?: string;
    }) => Promise<GeminiLiveSessionHandle | null>
  >(async () => null);
  const maybeFlipTranslationTargetRef = useRef<
    (detectedSource: string | undefined, epoch: number) => Promise<void>
  >(async () => {});
  const scheduleResumeConnectionRef = useRef<(epoch: number) => Promise<void>>(async () => {});

  const clearMicResumeTimer = useCallback(() => {
    if (micResumeTimerRef.current) {
      clearTimeout(micResumeTimerRef.current);
      micResumeTimerRef.current = null;
    }
  }, []);

  const clearTokenRefreshTimer = useCallback(() => {
    if (tokenRefreshTimerRef.current) {
      clearTimeout(tokenRefreshTimerRef.current);
      tokenRefreshTimerRef.current = null;
    }
  }, []);

  const takeCachedToken = useCallback(
    (languageA: string, languageB: string, targetLanguage: string) => {
      const key = tokenCacheKey(languageA, languageB, targetLanguage);
      const cached = tokenCacheRef.current.get(key);
      if (!cached) return null;
      if (Date.now() - cached.mintedAt > TOKEN_PREFETCH_MAX_AGE_MS) {
        tokenCacheRef.current.delete(key);
        return null;
      }
      tokenCacheRef.current.delete(key);
      return cached.response;
    },
    [],
  );

  const storeCachedToken = useCallback((response: GeminiLiveTokenResponse) => {
    const key = tokenCacheKey(response.languageA, response.languageB, response.targetLanguage);
    tokenCacheRef.current.set(key, { response, mintedAt: Date.now() });
  }, []);

  const scheduleTokenRefresh = useCallback(
    (tokenResp: GeminiLiveTokenResponse) => {
      clearTokenRefreshTimer();
      const expireMs = new Date(tokenResp.expireTime).getTime();
      const refreshAt = expireMs - TOKEN_REFRESH_BEFORE_EXPIRE_MS;
      const delay = Math.max(0, refreshAt - Date.now());
      tokenRefreshTimerRef.current = setTimeout(() => {
        void (async () => {
          if (!userSessionActiveRef.current) return;
          const pair = activePairRef.current;
          const target = sessionTargetRef.current;
          if (!pair || !target) return;
          try {
            const fresh = await mintGeminiLiveToken(pair.languageA, pair.languageB, target);
            activeTokenRef.current = fresh;
            storeCachedToken(fresh);
            scheduleTokenRefresh(fresh);
          } catch {
            /* next resumption reconnect will retry mint */
          }
        })();
      }, delay);
    },
    [clearTokenRefreshTimer, storeCachedToken],
  );

  const resolveToken = useCallback(
    async (languageA: string, languageB: string, targetLanguage: string) => {
      const cached = takeCachedToken(languageA, languageB, targetLanguage);
      if (cached) return cached;
      const response = await mintGeminiLiveToken(languageA, languageB, targetLanguage);
      return response;
    },
    [takeCachedToken],
  );

  const warmupSession = useCallback(
    async (opts: { languageA: string; languageB: string }) => {
      const languageA = normalizeGeminiLanguageCode(opts.languageA);
      const languageB = normalizeGeminiLanguageCode(opts.languageB);
      warmupEpochRef.current += 1;
      const epoch = warmupEpochRef.current;

      const targets = [languageA, languageB];
      const fresh = targets.every((target) => {
        const key = tokenCacheKey(languageA, languageB, target);
        const cached = tokenCacheRef.current.get(key);
        return cached && Date.now() - cached.mintedAt <= TOKEN_PREFETCH_MAX_AGE_MS;
      });
      if (fresh) return;

      try {
        const results = await Promise.allSettled(
          targets.map((targetLanguage) => mintGeminiLiveToken(languageA, languageB, targetLanguage)),
        );
        if (epoch !== warmupEpochRef.current) return;
        for (const result of results) {
          if (result.status === 'fulfilled') storeCachedToken(result.value);
        }
      } catch {
        /* startSession will mint on demand */
      }
    },
    [storeCachedToken],
  );

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

  const handlePlaybackIdle = useCallback(() => {
    if (micPhaseRef.current !== 'responseTail') return;
    micPhaseRef.current = 'idle';
    clearMicResumeTimer();
    micResumeTimerRef.current = setTimeout(() => {
      if (micPhaseRef.current === 'idle' && userSessionActiveRef.current) {
        micPhaseRef.current = 'listening';
      }
    }, MIC_RESUME_DEBOUNCE_MS);
  }, [clearMicResumeTimer]);

  const startMicCapture = useCallback((capture: GeminiPcmCapture, epoch: number) => {
    pcmWarmupBufferRef.current = [];
    streamReadyRef.current = false;
    micPhaseRef.current = 'listening';
    capture.start((base64) => {
      if (epoch !== sessionEpochRef.current) return;

      const phase = micPhaseRef.current;
      if (phase === 'responseTail' && playbackRef.current?.hasScheduledAudio()) {
        return;
      }

      if (streamReadyRef.current && liveSessionRef.current) {
        liveSessionRef.current.sendPcm16Base64(base64);
        return;
      }
      const buf = pcmWarmupBufferRef.current;
      buf.push(base64);
      if (buf.length > MAX_WARMUP_PCM_CHUNKS) buf.shift();
    });
    setMicLive(true);
  }, []);

  const teardownRuntime = useCallback(async () => {
    streamReadyRef.current = false;
    pcmWarmupBufferRef.current = [];
    flipInProgressRef.current = false;
    resumeScheduledRef.current = false;
    micPhaseRef.current = 'idle';
    ignoreLateAudioRef.current = false;
    clearMicResumeTimer();
    sessionTargetRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    liveSessionRef.current?.close();
    liveSessionRef.current = null;
    if (playbackRef.current) {
      playbackRef.current.setOnPlaybackIdle(null);
      await playbackRef.current.teardown();
      playbackRef.current = null;
    }
    await teardownVoisaAudioSession();
    if (Platform.OS === 'ios') {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    setMicLive(false);
  }, [clearMicResumeTimer]);

  const connectLive = useCallback(
    async (opts: {
      epoch: number;
      tokenResp: GeminiLiveTokenResponse;
      resumptionHandle?: string;
    }) => {
      const { epoch, tokenResp, resumptionHandle } = opts;
      streamReadyRef.current = false;

      const handle = await connectGeminiLiveSession({
        ephemeralToken: tokenResp.token,
        model: tokenResp.model,
        targetLanguageCode: tokenResp.targetLanguage,
        resumptionHandle,
        callbacks: {
          onOpen: (openHandle) => {
            if (epoch !== sessionEpochRef.current) return;
            setConnection('connected');
            streamReadyRef.current = true;
            liveSessionRef.current = openHandle;
            flushWarmupPcm(openHandle);
          },
          onInputTranscription: (text, languageCode) => {
            if (epoch !== sessionEpochRef.current) return;
            ignoreLateAudioRef.current = false;
            micPhaseRef.current = 'listening';
            clearMicResumeTimer();
            if (languageCode?.trim()) {
              const normalized = normalizeGeminiLanguageCode(languageCode);
              setDetectedSourceLanguage(normalized);
            }
            pendingOriginalRef.current = appendTranscriptionFragment(
              pendingOriginalRef.current,
              text,
            );
            setLiveOriginal(pendingOriginalRef.current);
            void maybeFlipTranslationTargetRef.current(languageCode, epoch);
          },
          onOutputTranscription: (text) => {
            if (epoch !== sessionEpochRef.current) return;
            const o = pendingOriginalRef.current;
            const merged = appendTranscriptionFragment(pendingTranslatedRef.current, text);
            pendingTranslatedRef.current = translationForDisplay(o, merged);
            setLiveTranslated(pendingTranslatedRef.current);
          },
          onAudioChunk: (data) => {
            if (epoch !== sessionEpochRef.current) return;
            if (ignoreLateAudioRef.current) return;
            playbackRef.current?.enqueueInlineData(data);
          },
          onTurnComplete: () => {
            if (epoch !== sessionEpochRef.current) return;
            liveSessionRef.current?.sendAudioStreamEnd();
            micPhaseRef.current = 'responseTail';
            commitFinal(pendingOriginalRef.current, pendingTranslatedRef.current);
          },
          onGenerationComplete: () => {
            if (epoch !== sessionEpochRef.current) return;
            ignoreLateAudioRef.current = true;
          },
          onInterrupted: () => {
            if (epoch !== sessionEpochRef.current) return;
            ignoreLateAudioRef.current = false;
            micPhaseRef.current = 'listening';
            clearMicResumeTimer();
            playbackRef.current?.clearScheduled();
          },
          onSessionResumptionUpdate: (update) => {
            if (epoch !== sessionEpochRef.current) return;
            if (update.resumable && update.newHandle) {
              resumptionHandleRef.current = update.newHandle;
            }
          },
          onGoAway: () => {
            if (epoch !== sessionEpochRef.current) return;
            void scheduleResumeConnectionRef.current(epoch);
          },
          onError: (message) => {
            if (epoch !== sessionEpochRef.current) return;
            if (userSessionActiveRef.current && !flipInProgressRef.current) {
              void scheduleResumeConnectionRef.current(epoch);
              return;
            }
            setLastError(message);
            setConnection('error');
          },
          onClose: () => {
            if (epoch !== sessionEpochRef.current) return;
            if (!userSessionActiveRef.current) {
              setConnection('idle');
              return;
            }
            if (flipInProgressRef.current) return;
            if (connectionRef.current === 'error') return;
            void scheduleResumeConnectionRef.current(epoch);
          },
        },
      });

      if (epoch !== sessionEpochRef.current) {
        handle.close();
        return null;
      }

      liveSessionRef.current = handle;
      sessionTargetRef.current = tokenResp.targetLanguage;
      setActiveTargetLanguage(tokenResp.targetLanguage);
      activeTokenRef.current = tokenResp;
      if (streamReadyRef.current) flushWarmupPcm(handle);
      return handle;
    },
    [clearMicResumeTimer, commitFinal, flushWarmupPcm, setConnection],
  );

  connectLiveRef.current = connectLive;

  const scheduleResumeConnection = useCallback(
    async (epoch: number) => {
      if (resumeScheduledRef.current) return;
      if (!userSessionActiveRef.current) return;
      if (flipInProgressRef.current) return;
      if (epoch !== sessionEpochRef.current) return;

      resumeScheduledRef.current = true;
      liveSessionRef.current?.close();
      liveSessionRef.current = null;
      streamReadyRef.current = false;

      let delayMs = RESUME_RETRY_INITIAL_MS;
      try {
        while (userSessionActiveRef.current && epoch === sessionEpochRef.current) {
          const pair = activePairRef.current;
          const target = sessionTargetRef.current;
          if (!pair || !target) break;

          try {
            let tokenResp = activeTokenRef.current;
            if (!tokenResp) {
              tokenResp = await resolveToken(pair.languageA, pair.languageB, target);
            } else {
              const expireMs = new Date(tokenResp.expireTime).getTime();
              if (expireMs - Date.now() < TOKEN_REFRESH_BEFORE_EXPIRE_MS) {
                tokenResp = await mintGeminiLiveToken(pair.languageA, pair.languageB, target);
                scheduleTokenRefresh(tokenResp);
              }
            }
            if (epoch !== sessionEpochRef.current) break;

            activeTokenRef.current = tokenResp;
            const handle = await connectLiveRef.current({
              epoch,
              tokenResp,
              resumptionHandle: resumptionHandleRef.current,
            });
            if (handle && streamReadyRef.current) break;
          } catch {
            /* keep session alive — retry until user stops */
          }

          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          delayMs = Math.min(RESUME_RETRY_MAX_MS, Math.round(delayMs * 1.5));
        }
      } finally {
        resumeScheduledRef.current = false;
      }
    },
    [resolveToken, scheduleTokenRefresh],
  );

  scheduleResumeConnectionRef.current = scheduleResumeConnection;

  const maybeFlipTranslationTarget = useCallback(
    async (detectedSource: string | undefined, epoch: number) => {
      if (epoch !== sessionEpochRef.current) return;
      if (flipInProgressRef.current) return;
      if (Date.now() - lastFlipAtRef.current < TARGET_FLIP_COOLDOWN_MS) return;

      const pair = activePairRef.current;
      const currentTarget = sessionTargetRef.current;
      if (!pair || !currentTarget) return;

      const desiredTarget = translationTargetForDetectedSource(
        detectedSource,
        pair.languageA,
        pair.languageB,
      );
      if (!desiredTarget || desiredTarget === currentTarget) return;

      flipInProgressRef.current = true;
      lastFlipAtRef.current = Date.now();
      resumptionHandleRef.current = undefined;

      sessionTargetRef.current = desiredTarget;
      setActiveTargetLanguage(desiredTarget);

      liveSessionRef.current?.close();
      liveSessionRef.current = null;
      streamReadyRef.current = false;
      micPhaseRef.current = 'listening';
      ignoreLateAudioRef.current = false;

      try {
        const tokenResp = await resolveToken(pair.languageA, pair.languageB, desiredTarget);
        if (epoch !== sessionEpochRef.current) return;

        activeTokenRef.current = tokenResp;
        scheduleTokenRefresh(tokenResp);
        const handle = await connectLiveRef.current({
          epoch,
          tokenResp,
        });
        if (!handle) return;
      } catch {
        if (epoch !== sessionEpochRef.current) return;
        void scheduleResumeConnectionRef.current(epoch);
      } finally {
        flipInProgressRef.current = false;
      }
    },
    [resolveToken, scheduleTokenRefresh],
  );

  maybeFlipTranslationTargetRef.current = maybeFlipTranslationTarget;

  const startSession = useCallback(
    async (opts: { languageA: string; languageB: string }) => {
      const languageA = normalizeGeminiLanguageCode(opts.languageA);
      const languageB = normalizeGeminiLanguageCode(opts.languageB);
      const initialTarget = languageB;

      setLastError(null);
      setMicLive(false);
      setDetectedSourceLanguage(null);
      sessionEpochRef.current += 1;
      warmupEpochRef.current += 1;
      const epoch = sessionEpochRef.current;
      activePairRef.current = { languageA, languageB };
      setLanguagePair({ languageA, languageB });
      sessionTargetRef.current = initialTarget;
      setActiveTargetLanguage(initialTarget);
      userSessionActiveRef.current = true;
      resumptionHandleRef.current = undefined;
      setConnection('connecting');

      if (liveSessionRef.current || captureRef.current || playbackRef.current) {
        await teardownRuntime();
        if (epoch !== sessionEpochRef.current) return;
      }

      try {
        const capture = new GeminiPcmCapture();
        captureRef.current = capture;

        const tokenResp = await resolveToken(languageA, languageB, initialTarget);
        if (epoch !== sessionEpochRef.current) return;

        activeTokenRef.current = tokenResp;
        scheduleTokenRefresh(tokenResp);

        await prepareVoisaAudioSession((route) => {
          setOutputRoute(route);
          void playbackRef.current?.syncOutputRoute();
        });

        if (epoch !== sessionEpochRef.current) {
          await teardownVoisaAudioSession();
          return;
        }

        const playback = new GeminiPcmPlayback();
        playback.setOnPlaybackIdle(handlePlaybackIdle);
        await playback.prepare();
        if (epoch !== sessionEpochRef.current) {
          await playback.teardown();
          await teardownVoisaAudioSession();
          return;
        }

        playbackRef.current = playback;
        startMicCapture(capture, epoch);

        await connectLive({ epoch, tokenResp });
      } catch (e) {
        if (epoch !== sessionEpochRef.current) return;
        userSessionActiveRef.current = false;
        await teardownRuntime();
        const msg = e instanceof Error ? e.message : String(e);
        setLastError(msg);
        setConnection('error');
        throw e;
      }
    },
    [
      connectLive,
      handlePlaybackIdle,
      resolveToken,
      scheduleTokenRefresh,
      setConnection,
      startMicCapture,
      teardownRuntime,
    ],
  );

  const stopSession = useCallback(async () => {
    userSessionActiveRef.current = false;
    sessionEpochRef.current += 1;
    warmupEpochRef.current += 1;
    clearTokenRefreshTimer();
    clearMicResumeTimer();
    tokenCacheRef.current.clear();
    activePairRef.current = null;
    sessionTargetRef.current = null;
    activeTokenRef.current = null;
    resumptionHandleRef.current = undefined;
    pendingOriginalRef.current = '';
    pendingTranslatedRef.current = '';
    setLiveOriginal('');
    setLiveTranslated('');
    setDetectedSourceLanguage(null);
    setActiveTargetLanguage(null);
    setLanguagePair(null);
    setLastError(null);
    setConnection('idle');
    setOutputRoute('earpiece');
    await teardownRuntime();
  }, [clearMicResumeTimer, clearTokenRefreshTimer, setConnection, teardownRuntime]);

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

  const translationDirection = useMemo(() => {
    if (!languagePair || !activeTargetLanguage) return null;
    return translationDirectionFromPair(
      detectedSourceLanguage ?? undefined,
      activeTargetLanguage,
      languagePair.languageA,
      languagePair.languageB,
    );
  }, [activeTargetLanguage, detectedSourceLanguage, languagePair]);

  return {
    connection,
    lastError,
    micLive,
    liveOriginal,
    liveTranslated,
    segments,
    liveContinuationSegmentId,
    outputRoute,
    detectedSourceLanguage,
    activeTargetLanguage,
    translationDirection,
    warmupSession,
    startSession,
    stopSession,
    clearSegments: () => setSegments([]),
  };
}
