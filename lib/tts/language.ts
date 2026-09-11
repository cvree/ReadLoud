/* ────────────────────────────────────────────────────────────────
   The language ReadLoud reads in.

   This is not a preference, it is a fact about the pipeline, and it
   is written down in one place because three separate parts of the
   app depend on it agreeing:

     * Kokoro is an English-only model (`lib/tts/kokoro.ts`).
     * The chunker segments sentences with an English locale, and
       reading mode's tokenizer uses an English abbreviation list and
       an English optimal-recognition-point table.
     * `getVoices()` hands back every voice the operating system has
       installed, in an order that has nothing to do with what the
       page is written in. Without a language rule, a machine with a
       German network voice and an English compact one will read an
       English book with German phonetics — which does not sound like
       a bug, it sounds like gibberish.

   So: non-English voices are listed, labelled, and never chosen by
   default; and an utterance with no matched voice is tagged `en-US`
   rather than left to the operating system's own idea of a default.
   ──────────────────────────────────────────────────────────────── */

export const READING_LANGUAGE = "en";

/** Used when no installed voice matched, so the engine does not guess. */
export const FALLBACK_LANG = "en-US";

/**
 * True for `en`, `en-US`, `en_AU`, `EN-gb`; false for `eng`, `enm`, `eo`.
 *
 * The separator check is the point: a bare `startsWith("en")` also matches
 * Middle English and Esperanto, which is how this kind of guard usually
 * fails.
 */
export function isEnglishVoice(lang: string | undefined): boolean {
  return new RegExp(`^${READING_LANGUAGE}([-_]|$)`, "i").test(lang ?? "");
}

/**
 * "en-GB" → "British English", "de-DE" → "German (Germany)".
 *
 * The voice picker used to show a bare quality tag like "Premium", which is
 * exactly the information a reader does not need when the actual problem is
 * that the voice is Finnish. Named in English because the interface is.
 */
let displayNames: Intl.DisplayNames | null | undefined;

export function languageLabel(lang: string | undefined): string {
  if (!lang) return "Unknown language";
  const tag = lang.replace(/_/g, "-");
  try {
    if (displayNames === undefined) {
      displayNames =
        typeof Intl !== "undefined" && "DisplayNames" in Intl
          ? new Intl.DisplayNames(["en"], { type: "language" })
          : null;
    }
    return displayNames?.of(tag) ?? tag;
  } catch {
    // An unknown or malformed tag throws rather than returning undefined.
    return tag;
  }
}
