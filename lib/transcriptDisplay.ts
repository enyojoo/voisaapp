/** Normalize transcript strings from Gemini Live before UI or persistence. */

export function sanitizeTranscriptDisplay(text: string): string {
  const stripped = text
    .replace(/<\/?end>/gi, '')
    .replace(/<end\b[^>]*>/gi, '');
  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    /** Keep one line-break between clauses; `\n\n` blows up vertically in RN `Text`. */
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Translation column only: never mirrors the spoken/source text (drops echoed or trivially-equal strings). */
export function translationForDisplay(sanitizedOriginal: string, sanitizedTranslated: string): string {
  const o = sanitizedOriginal.trim();
  const t = sanitizedTranslated.trim();
  if (!t) return '';
  if (o.length > 0 && t.localeCompare(o, undefined, { sensitivity: 'base' }) === 0) return '';
  return t;
}

/**
 * Gemini Live output transcription arrives as incremental fragments (often word-by-word).
 * Handles both delta chunks and cumulative strings from the server.
 */
export function appendTranscriptionFragment(prevBody: string, fragment: string): string {
  const prev = sanitizeTranscriptDisplay(prevBody);
  const next = sanitizeTranscriptDisplay(fragment);
  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  const needsSpace =
    prev.length > 0 && !/[ \n]$/.test(prev) && !/^[,.;:!?)]/.test(next);
  return sanitizeTranscriptDisplay(`${prev}${needsSpace ? ' ' : ''}${next}`);
}

/** Merge consecutive finals into one readable turn when Gemini emits rapid commits mid-thought. */
export function mergeContinuationParagraph(prevBody: string, nextBody: string): string {
  const a = sanitizeTranscriptDisplay(prevBody);
  const b = sanitizeTranscriptDisplay(nextBody);
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  const endsSentence = /[.!?…]["')\]]?$/.test(a);
  /** Single `\n`: reads line‑by‑line in one transcript without blank “paragraph” rows. */
  const sep = endsSentence ? '\n' : ' ';
  return sanitizeTranscriptDisplay(`${a}${sep}${b}`);
}
