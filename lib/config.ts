import { FunctionRegion } from '@supabase/supabase-js';
import Constants from 'expo-constants';

const KNOWN_SUPABASE_FUNCTION_REGIONS = new Set<string>(Object.values(FunctionRegion));

function getExtra(key: string): string | undefined {
  const extra = Constants.expoConfig?.extra as Record<string, string> | undefined;
  return extra?.[key] ?? process.env[key as keyof NodeJS.ProcessEnv] as string | undefined;
}

export const supabaseUrl =
  getExtra('EXPO_PUBLIC_SUPABASE_URL') ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
/** Supabase "publishable" key (Dashboard label; same JWT as legacy "anon" key). */
export const supabasePublishableKey =
  getExtra('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ??
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function assertSupabaseConfigured(): void {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill values.',
    );
  }
}

/**
 * Optional: pin Edge Function invocation region (e.g. `eu-west-1`) when relay routing is flaky.
 * Values match Supabase `FunctionRegion` slugs / dashboard regions.
 */
export function supabaseFunctionsInvokeRegion(): FunctionRegion | undefined {
  const raw =
    getExtra('EXPO_PUBLIC_SUPABASE_FUNCTIONS_REGION') ??
    process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_REGION;
  if (!raw?.trim()) return undefined;
  const v = raw.trim();
  return KNOWN_SUPABASE_FUNCTION_REGIONS.has(v) ? (v as FunctionRegion) : undefined;
}

/**
 * Gemini translated audio playback gain (default 1). Lower slightly (e.g. 0.92) if output clips the
 * device speaker; raise only if you intentionally need more headroom (max 1.5).
 */
export function voisaTranslatedAudioVolume(): number {
  const raw =
    getExtra('EXPO_PUBLIC_VOISA_TRANSLATED_AUDIO_VOLUME') ??
    process.env.EXPO_PUBLIC_VOISA_TRANSLATED_AUDIO_VOLUME ??
    getExtra('EXPO_PUBLIC_VOISA_REMOTE_AUDIO_VOLUME') ??
    process.env.EXPO_PUBLIC_VOISA_REMOTE_AUDIO_VOLUME;
  if (!raw?.trim()) return 1;
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.25, n));
}
