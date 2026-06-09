import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js';

import { supabaseFunctionsInvokeRegion } from '@/lib/config';
import { supabase } from '@/lib/supabase';

export type GeminiLiveTokenResponse = {
  token: string;
  model: string;
  expireTime: string;
  languageA: string;
  languageB: string;
};

const INVOKE_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attemptIndex: number): number {
  return 450 * 2 ** attemptIndex + Math.floor(Math.random() * 320);
}

function isRetriableInvokeError(error: unknown): boolean {
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return true;
  if (error instanceof FunctionsHttpError) {
    const status = typeof error.context?.status === 'number' ? error.context.status : 0;
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 502 && status <= 504) return true;
  }
  return false;
}

async function formatInvokeFailure(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const res = error.context as Response;
      const ct = res.headers.get('Content-Type') ?? '';
      if (ct.includes('application/json')) {
        const j = (await res.clone().json()) as { error?: unknown; detail?: unknown };
        if (typeof j.error === 'string') {
          const detail = typeof j.detail === 'string' ? `: ${j.detail}` : '';
          return `${j.error}${detail}`;
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function mintGeminiLiveToken(
  languageA: string,
  languageB: string,
): Promise<GeminiLiveTokenResponse> {
  const region = supabaseFunctionsInvokeRegion();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.functions.invoke<GeminiLiveTokenResponse>(
      'gemini-live-token',
      {
        body: { languageA, languageB },
        timeout: INVOKE_TIMEOUT_MS,
        ...(region ? { region } : {}),
      },
    );

    if (!error && data?.token && data?.model) {
      return data;
    }

    if (!error) {
      throw new Error('gemini-live-token returned an invalid payload');
    }

    lastError = error;

    const retriable = isRetriableInvokeError(error);
    if (!retriable || attempt === MAX_ATTEMPTS - 1) {
      throw new Error(await formatInvokeFailure(error));
    }

    await sleep(backoffMs(attempt));
  }

  throw new Error(await formatInvokeFailure(lastError));
}
