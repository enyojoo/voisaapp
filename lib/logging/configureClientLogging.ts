/**
 * Optional Gemini Live verbosity in Metro (`EXPO_PUBLIC_VOISA_VERBOSE_GEMINI=1`).
 */
export function configureVoisaRuntimeLogging(): void {
  const verbose =
    typeof process !== 'undefined' &&
    typeof process.env?.EXPO_PUBLIC_VOISA_VERBOSE_GEMINI === 'string' &&
    process.env.EXPO_PUBLIC_VOISA_VERBOSE_GEMINI === '1';

  if (verbose) {
    console.info('[Voisa] Gemini verbose logging enabled');
  }
}
