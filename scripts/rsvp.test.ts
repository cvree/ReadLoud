/* ────────────────────────────────────────────────────────────────
   Reading-mode tests.

   Run with `npm test`. Same shape as `captions.test.ts`: no framework
   and no dependency, because a check you cannot run on a clean
   checkout in one command is a check nobody runs.

   What is worth testing here is not that a word appears on screen —
   that you can see. It is the three things that break invisibly:
   offsets that drift away from the document, a dial that does not
   deliver the rate it promises, and a clock that skips a word during
   a stall. All three are asserted below against a fake clock, so the
   whole file runs in milliseconds.
   ──────────────────────────────────────────────────────────────── */

import { tokenize, tokenIndexAt } from "../lib/rsvp/tokenize.ts";
import { pivotFor } from "../lib/rsvp/orp.ts";
import { dwellsMs, effectiveWpm, withRampUp, WPM_RANGE } from "../lib/rsvp/pacing.ts";
import { driftTest, pacingReport, tokenRoundTrip } from "../lib/rsvp/selftest.ts";
import { isEnglishVoice, languageLabel } from "../lib/tts/language.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n      " + (e as Error).message); }
}
function eq(a: unknown, b: unknown, msg = "") {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg}\n      got:      ${A}\n      expected: ${B}`);
}
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const PROSE =
  "Call me Ishmael. Some years ago - never mind how long precisely - having " +
  "little or no money in my purse, I thought I would sail about a little.\n\n" +
  "It cost $1,234.56 on 2026-09-11, or about 3.14 times what Dr. Maturin paid, " +
  "which was incomprehensibly cheaper.";

console.log("\n── token offsets ──");
t("every token slices back out of the source", () => {
  const report = tokenRoundTrip(PROSE);
  eq(report.mismatches, []);
  ok(report.tokens > 40, `only ${report.tokens} tokens`);
});
t("nothing is dropped between tokens", () => {
  eq(tokenRoundTrip(PROSE).dropped, []);
});
t("offsets are absolute when a base is given", () => {
  const base = 1_000;
  const tokens = tokenize(PROSE, base);
  eq(tokens[0].start, base);
  eq(PROSE.slice(tokens[3].start - base, tokens[3].end - base), tokens[3].text);
  eq(tokenRoundTrip(PROSE, base).ok, true);
});
t("round trip survives a document of punctuation and whitespace", () => {
  const nasty = "  ...   —  \n\n\n  ?!  \t  x  ";
  eq(tokenRoundTrip(nasty).ok, true);
});
t("empty text yields no tokens", () => {
  eq(tokenize("   \n\n  ").length, 0);
  eq(tokenRoundTrip("").ok, true);
});

console.log("\n── what stays whole ──");
t("trailing punctuation stays attached to its word", () => {
  const tokens = tokenize("The end. Really?");
  eq(tokens.map((x) => x.text), ["The", "end.", "Really?"]);
});
t("currency, decimals and dates are one token and not sentence ends", () => {
  for (const s of ["$1,234.56", "3.14", "2026-09-11", "v1.2.3"]) {
    const tokens = tokenize(s);
    eq(tokens.length, 1, `${s} split into ${tokens.length}`);
    eq(tokens[0].flags.endsSentence, false, `${s} read as a sentence end`);
    eq(tokens[0].flags.numeric, true, `${s} not marked numeric`);
  }
});
t("abbreviations are not sentence ends", () => {
  for (const s of ["Dr.", "etc.", "e.g.", "J."]) {
    eq(tokenize(s)[0].flags.endsSentence, false, s);
  }
});
t("a real full stop is a sentence end", () => {
  eq(tokenize("Ishmael.")[0].flags.endsSentence, true);
  eq(tokenize('"Now!"')[0].flags.endsSentence, true);
});
t("clause punctuation is a breath, not a stop", () => {
  const [comma] = tokenize("however,");
  eq([comma.flags.endsClause, comma.flags.endsSentence], [true, false]);
});
t("the last word of a paragraph is flagged", () => {
  const tokens = tokenize("one two\n\nthree four");
  eq(tokens.map((x) => x.flags.endsParagraph), [false, true, false, true]);
});

console.log("\n── splitting a word too wide to flash ──");
t("a long word splits with a hyphen and keeps exact offsets", () => {
  const word = "incomprehensibilities";
  const tokens = tokenize(word);
  ok(tokens.length > 1, "not split");
  eq(tokens.map((x) => x.text).join(""), word);
  ok(tokens.slice(0, -1).every((x) => x.display.endsWith("-")), "no continuation hyphen");
  ok(tokens.slice(0, -1).every((x) => x.flags.continued), "continued flag missing");
  eq(tokens[tokens.length - 1].flags.continued, false);
  eq(tokenRoundTrip(word).ok, true);
});
t("a hyphenated compound splits at its own hyphen", () => {
  const tokens = tokenize("counter-intuitive");
  eq(tokens.map((x) => x.text), ["counter-", "intuitive"]);
});
t("no displayed fragment is wider than the ceiling", () => {
  for (const t2 of tokenize("antidisestablishmentarianism supercalifragilistic")) {
    ok(t2.display.length <= 13, `${t2.display} is ${t2.display.length} wide`);
  }
});
t("pieces are balanced rather than greedy", () => {
  const lengths = tokenize("incomprehensibilities").map((x) => x.text.length);
  ok(Math.max(...lengths) - Math.min(...lengths) <= 2, `uneven: ${lengths.join("/")}`);
});
t("a word a little over the ceiling is shown whole, not orphaned", () => {
  // Fourteen characters with the quotes and comma. Splitting it produced a
  // three-character second flash, which reads as a glitch.
  eq(tokenize('"unremarkable,"').map((x) => x.display), ['"unremarkable,"']);
});

console.log("\n── the pivot ──");
t("pivot by core length", () => {
  eq(pivotFor("a"), 0);
  eq(pivotFor("the"), 1);
  eq(pivotFor("reading"), 2);
  eq(pivotFor("incredible"), 3);
  eq(pivotFor("extraordinarily"), 4);
});
t("leading punctuation does not eat the fixation", () => {
  eq(pivotFor('"Hello'), 2); // one for the quote, one into the word
  eq(pivotFor("(a"), 1);
});
t("pivot is always inside the word", () => {
  for (const w of ["a", "-", "...", "hi", "x-", "1"]) {
    const p = pivotFor(w);
    ok(p >= 0 && p < w.length, `${w} -> ${p}`);
  }
});

console.log("\n── pacing ──");
t("the dial delivers what it says", () => {
  for (const wpm of [WPM_RANGE.min, 400, 600, WPM_RANGE.max]) {
    const report = pacingReport(PROSE, wpm);
    ok(report.ok, `${wpm} wpm delivered ${report.effective}`);
  }
});
t("punctuation still changes the individual holds", () => {
  const tokens = tokenize(PROSE);
  const dwells = dwellsMs(tokens, 600);
  ok(Math.max(...dwells) > Math.min(...dwells) * 2, "every word held for the same time");
});
t("a document of nothing but full stops is not paced at a third speed", () => {
  // The normalization case: without it the mean weight would be 2.1 and the
  // dial would silently deliver 286 wpm instead of 600.
  const report = pacingReport("One. Two. Three. Four. Five. Six.", 600);
  ok(report.ok, `delivered ${report.effective}`);
});
t("ramp-up is slower at the start and gone by word twelve", () => {
  const flat = new Array(30).fill(100);
  const ramped = withRampUp(flat);
  ok(ramped[0] > flat[0] * 1.3, "no ramp at the first word");
  ok(ramped[11] < ramped[0], "ramp not decreasing");
  eq(ramped.slice(12), flat.slice(12));
});
t("effective wpm of an empty schedule is zero, not NaN", () => {
  eq(effectiveWpm([]), 0);
  eq(dwellsMs([], 600), []);
});

console.log("\n── the clock ──");
t("every word is shown, in order, with no drift", () => {
  const report = driftTest(600, 500);
  ok(report.ok, report.notes.join(" "));
  eq(report.shown, 500);
});
t("holds at 1200 wpm on a 60 Hz frame source", () => {
  const report = driftTest(WPM_RANGE.max, 400);
  ok(report.ok, report.notes.join(" "));
});
t("a stall is rebased, never fast-forwarded through", () => {
  // 400 ms of nothing painting: every word that came due must still be shown.
  const report = driftTest(600, 300, { stallAtHalfwayMs: 400 });
  eq(report.shown, 300, report.notes.join(" "));
  ok(report.ok, report.notes.join(" "));
});
t("a 30 Hz display loses no words", () => {
  const report = driftTest(900, 300, { frameMs: 1000 / 30 });
  eq(report.shown, 300, report.notes.join(" "));
});

console.log("\n── lookup ──");
t("tokenIndexAt finds the token containing an offset", () => {
  const tokens = tokenize(PROSE);
  for (let i = 0; i < tokens.length; i += 7) {
    const mid = tokens[i].start + Math.floor(tokens[i].text.length / 2);
    eq(tokenIndexAt(tokens, mid), i, `offset ${mid}`);
    eq(tokenIndexAt(tokens, tokens[i].start), i, `start ${tokens[i].start}`);
  }
  eq(tokenIndexAt([], 5), -1);
});

console.log("\n── reading language ──");
t("English variants are recognized", () => {
  for (const lang of ["en", "en-US", "en-GB", "en_AU", "EN-us"]) {
    eq(isEnglishVoice(lang), true, lang);
  }
});
t("everything else is not English", () => {
  // The bug this guards: "eng" and "en-x" aside, the near-misses are the ones
  // that used to slip through a `startsWith("en")` check.
  for (const lang of ["de-DE", "nl-NL", "enm", "eo", "es-MX", undefined]) {
    eq(isEnglishVoice(lang), false, String(lang));
  }
});
t("languages are named in English for the picker", () => {
  // Intl data is present in Node; assert the shape rather than exact wording,
  // which varies with the ICU build.
  ok(/english/i.test(languageLabel("en-GB")), languageLabel("en-GB"));
  ok(/german/i.test(languageLabel("de-DE")), languageLabel("de-DE"));
  eq(languageLabel(undefined), "Unknown language");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
