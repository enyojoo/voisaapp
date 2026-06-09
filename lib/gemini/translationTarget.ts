import { normalizeGeminiLanguageCode } from '@/lib/geminiLanguages';

/** Compare BCP-47 tags loosely (en ↔ en-US, pt-BR ↔ pt). */
export function languagesMatch(a: string, b: string): boolean {
  const na = normalizeGeminiLanguageCode(a).toLowerCase();
  const nb = normalizeGeminiLanguageCode(b).toLowerCase();
  if (na === nb) return true;
  return na.split('-')[0] === nb.split('-')[0];
}

/**
 * Gemini Live Translate exposes a single `targetLanguageCode` per session.
 * For a chosen pair (A, B), flip the target to the opposite language whenever
 * the detected source matches one side of the pair.
 */
export function translationTargetForDetectedSource(
  detectedSource: string | undefined,
  languageA: string,
  languageB: string,
): string | null {
  if (!detectedSource?.trim()) return null;
  const a = normalizeGeminiLanguageCode(languageA);
  const b = normalizeGeminiLanguageCode(languageB);
  if (languagesMatch(detectedSource, a)) return b;
  if (languagesMatch(detectedSource, b)) return a;
  return null;
}

export function translationDirectionFromPair(
  detectedSource: string | undefined,
  activeTarget: string,
  languageA: string,
  languageB: string,
): { from: string; to: string } {
  const to = normalizeGeminiLanguageCode(activeTarget);
  if (detectedSource?.trim()) {
    return { from: normalizeGeminiLanguageCode(detectedSource), to };
  }
  if (languagesMatch(to, languageA)) {
    return { from: normalizeGeminiLanguageCode(languageB), to: normalizeGeminiLanguageCode(languageA) };
  }
  if (languagesMatch(to, languageB)) {
    return { from: normalizeGeminiLanguageCode(languageA), to: normalizeGeminiLanguageCode(languageB) };
  }
  return { from: normalizeGeminiLanguageCode(languageA), to };
}

export function tokenCacheKey(
  languageA: string,
  languageB: string,
  targetLanguage: string,
): string {
  const a = normalizeGeminiLanguageCode(languageA);
  const b = normalizeGeminiLanguageCode(languageB);
  const t = normalizeGeminiLanguageCode(targetLanguage);
  return `${a}|${b}|${t}`;
}
