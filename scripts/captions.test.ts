/* ────────────────────────────────────────────────────────────────
   Caption ingestion tests.

   Run with `npm test`. No test framework and no dependency: node can
   strip the types itself, and the whole point of these is to be
   runnable in one command on a clean checkout.

   What is worth testing here is not the parsing - that is mechanical -
   but `repairCaptions`, which makes judgement calls about text nobody
   punctuated. Those calls are the difference between a listenable
   transcript and a wall of words, and they are easy to regress.
   ──────────────────────────────────────────────────────────────── */

import {
  parseCaptions, detectCaptionFormat, repairCaptions, captionsToParts, formatStamp,
} from "../lib/ingest/captions.ts";
import { parseYouTubeUrl, validateHandoff } from "../lib/ingest/youtube.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n      " + (e as Error).message); }
}
function eq(a: unknown, b: unknown, msg = "") {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg}\n      got:      ${A}\n      expected: ${B}`);
}

console.log("\n── format detection ──");
t("WEBVTT", () => eq(detectCaptionFormat("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi"), "vtt"));
t("SubRip", () => eq(detectCaptionFormat("1\n00:00:01,000 --> 00:00:02,000\nhi"), "srt"));
t("SBV", () => eq(detectCaptionFormat("0:00:01.000,0:00:04.000\nhi"), "sbv"));
t("json3", () => eq(detectCaptionFormat('{"events":[{"tStartMs":0}]}'), "json3"));
t("TTML", () => eq(detectCaptionFormat('<?xml version="1.0"?><tt xmlns="x"><body/></tt>'), "ttml"));
t("panel paste", () => eq(detectCaptionFormat("0:00\nhello\n0:04\nthere\n0:08\nfriend\n0:12\nagain"), "panel"));
t("prose is not a transcript", () =>
  eq(detectCaptionFormat("We met at 3:15 and left at 4:20. It rained."), null));

console.log("\n── VTT / SRT ──");
t("vtt cues + markup stripped", () => {
  const cues = parseCaptions(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500 align:start\n<c.colorE5E5E5>Hello</c> <00:00:02.000>there\n\n" +
    "2\n00:00:04.000 --> 00:00:06.000\nSecond line",
  );
  eq(cues.length, 2, "cue count");
  eq(cues[0], { start: 1, end: 3.5, text: "Hello there" });
  eq(cues[1].start, 4);
});
t("srt comma decimals", () => {
  const cues = parseCaptions("1\n00:00:01,000 --> 00:00:02,500\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo");
  eq(cues.map(c => c.text), ["One", "Two"]);
  eq(cues[0].end, 2.5);
});
t("entities decoded, &amp; last", () => {
  const cues = parseCaptions("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry &quot;hi&quot; &amp;lt;");
  eq(cues[0].text, 'Tom & Jerry "hi" &lt;');
});
t("mm:ss.mmm timestamps", () => {
  const cues = parseCaptions("WEBVTT\n\n01:02.500 --> 01:04.000\nShort form");
  eq(cues[0].start, 62.5);
});

console.log("\n── json3 ──");
t("json3 skips aAppend and empty segs", () => {
  const cues = parseCaptions(JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "one " }, { utf8: "two" }] },
    { tStartMs: 900, dDurationMs: 500, segs: [{ utf8: "two" }], aAppend: 1 },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "\n" }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "three" }] },
  ]}));
  eq(cues.map(c => c.text), ["one two", "three"]);
  eq(cues[0].end, 1);
});

console.log("\n── panel paste ──");
t("timestamp then text on next line", () => {
  const cues = parseCaptions("0:00\nfirst line\n0:04\nsecond line\n1:02:03\nlate line\n0:20\nx");
  eq(cues.map(c => c.text), ["first line", "second line", "late line", "x"]);
  eq(cues[2].start, 3723);
});
t("timestamp and text on one line", () => {
  const cues = parseCaptions("0:00\tfirst\n0:04\tsecond\n0:08\tthird\n0:12\tfourth");
  eq(cues.map(c => c.text), ["first", "second", "third", "fourth"]);
});

console.log("\n── repair: rolling-window dedupe ──");
t("drops the repeated head of a scrolling cue", () => {
  const r = repairCaptions([
    { start: 0, end: 2, text: "the quick brown" },
    { start: 1.8, end: 4, text: "quick brown fox jumps" },
    { start: 3.8, end: 6, text: "fox jumps over the lazy dog" },
  ]);
  eq(r.text, "the quick brown fox jumps over the lazy dog");
});
t("a fully contained cue adds nothing", () => {
  const r = repairCaptions([
    { start: 0, end: 2, text: "alpha beta gamma" },
    { start: 1.5, end: 3, text: "beta gamma" },
  ]);
  eq(r.text, "alpha beta gamma");
});
t("a single shared word is NOT treated as overlap", () => {
  const r = repairCaptions([
    { start: 0, end: 2, text: "we walked and then" },
    { start: 2, end: 4, text: "then we stopped" },
  ]);
  eq(r.text.includes("then we stopped"), true, "real speech must survive");
});

console.log("\n── repair: punctuation reconstruction ──");
const unpunctuated = [
  { start: 0,    end: 1.6,  text: "so the first thing to understand" },
  { start: 1.7,  end: 3.2,  text: "is that the eye moves in jumps" },
  { start: 4.4,  end: 6.0,  text: "these are called saccades" },
  { start: 9.0,  end: 11.0, text: "now here is the interesting part" },
  { start: 11.1, end: 13.0, text: "your eye is still for about a quarter of a second" },
  { start: 13.1, end: 15.0, text: "and then it jumps again" },
];
t("gaps become sentence and paragraph breaks", () => {
  const r = repairCaptions(unpunctuated);
  eq(r.reconstructed, true, "should detect an unpunctuated track");
  eq(r.text,
    "so the first thing to understand is that the eye moves in jumps. these are called saccades.\n\n" +
    "now here is the interesting part your eye is still for about a quarter of a second and then it jumps again.");
});
t("a punctuated track is left alone", () => {
  const r = repairCaptions([
    { start: 0,   end: 1.6, text: "So, the first thing to understand." },
    { start: 1.7, end: 3.2, text: "The eye moves in jumps!" },
    { start: 4.4, end: 6.0, text: "These are called saccades?" },
    { start: 6.1, end: 8.0, text: "Yes. Truly. They are, in fact, quite fast." },
    { start: 8.1, end: 9.0, text: "And that matters." },
  ]);
  eq(r.reconstructed, false, "must not rewrite human captions");
  eq(r.text.includes("saccades? Yes."), true);
  eq(/\.\s*\./.test(r.text), false, "no doubled full stops");
});
t("short tracks are never reconstructed", () => {
  eq(repairCaptions([{ start: 0, end: 1, text: "hello there friend" }]).reconstructed, false);
});
t("no orphan period after a comma", () => {
  const cues = [];
  for (let i = 0; i < 30; i++) cues.push({ start: i * 2, end: i * 2 + 1, text: `word${i} and,` });
  const r = repairCaptions(cues);
  eq(/,\s*\./.test(r.text), false, "comma must not gain a period");
});

t("contiguous track still gets sentence breaks", () => {
  // The common real-world shape: every cue starts exactly where the last
  // ended, so there is not a single gap to key off.
  const cues = [];
  const words = "the eye moves in quick jumps between points of rest and each jump takes about twenty milliseconds while each rest lasts far longer than that which is where all of the reading actually happens".split(" ");
  for (let i = 0; i < words.length; i += 3) {
    cues.push({ start: i, end: i + 3, text: words.slice(i, i + 3).join(" ") });
  }
  const r = repairCaptions(cues);
  eq(r.reconstructed, true);
  const sentences = r.text.split(".").filter(x => x.trim());
  if (sentences.length < 2) throw new Error("expected several sentences, got: " + r.text);
  for (const sen of sentences) {
    const n = sen.trim().split(/\s+/).length;
    if (n > 34) throw new Error(`sentence of ${n} words is too long: ${sen.trim()}`);
  }
  // and no words may be lost or duplicated
  eq(r.text.replace(/[.\n]/g, " ").split(/\s+/).filter(Boolean), words);
});

t("a forced break lands on a real boundary, not an arbitrary one", () => {
  const lines = [
    "so the first thing to understand about reading",
    "about reading is that your eyes do not glide",
    "do not glide across the page at all",
    "they jump", "and between the jumps they are completely still",
    "those jumps are called saccades",
    "and the still moments are called fixations",
  ];
  const r = repairCaptions(lines.map((text, i) => ({ start: i * 2, end: i * 2 + 1.8, text })));
  // The break belongs before "they jump", not in the middle of "do not glide".
  eq(r.text.includes("across the page at all. they jump"), true, r.text);
  eq(r.text.includes("glide."), false, "must not break mid-clause");
});

console.log("\n── sectioning ──");
t("parts are titled by timestamp", () => {
  const cues = [];
  for (let i = 0; i < 900; i++) cues.push({ start: i * 3, end: i * 3 + 2.5, text: "lorem ipsum dolor sit amet consectetur" });
  const parts = captionsToParts(cues);
  if (parts.length < 2) throw new Error("expected several sections, got " + parts.length);
  eq(parts[0].title, "0:00");
  if (!/^\d+:\d{2}/.test(parts[1].title)) throw new Error("bad title " + parts[1].title);
});
t("formatStamp", () => {
  eq(formatStamp(0), "0:00"); eq(formatStamp(62), "1:02"); eq(formatStamp(3723), "1:02:03");
});
t("empty input is not a crash", () => { eq(repairCaptions([]).text, ""); eq(captionsToParts([]), []); });

console.log("\n── youtube urls ──");
for (const [input, expected] of [
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ&feature=share", "dQw4w9WgXcQ"],
  ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
] as const) {
  t("url " + input, () => eq(parseYouTubeUrl(input)?.videoId, expected));
}
t("start time t=1h2m3s", () => eq(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=1h2m3s")?.start, 3723));
t("start time t=90", () => eq(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90")?.start, 90));
t("rejects vimeo", () => eq(parseYouTubeUrl("https://vimeo.com/123456"), null));
t("rejects a lookalike host", () => eq(parseYouTubeUrl("https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ"), null));
t("rejects junk", () => eq(parseYouTubeUrl("not a url at all"), null));

console.log("\n── handoff validation ──");
t("accepts a good payload", () => {
  const h = validateHandoff({ v: 1, videoId: "dQw4w9WgXcQ", title: "T", cues: [{ start: 0, end: 1, text: "hi" }] });
  eq(h.cues.length, 1);
});
t("rejects a bad version", () => {
  let threw = false;
  try { validateHandoff({ v: 2, videoId: "dQw4w9WgXcQ", cues: [{ text: "x" }] }); } catch { threw = true; }
  eq(threw, true);
});
t("rejects a bad video id", () => {
  let threw = false;
  try { validateHandoff({ v: 1, videoId: "../../etc", cues: [{ text: "x" }] }); } catch { threw = true; }
  eq(threw, true);
});
t("drops non-string cue text rather than throwing", () => {
  const h = validateHandoff({ v: 1, videoId: "dQw4w9WgXcQ", cues: [{ text: 42 }, { text: "real", start: 1 }] });
  eq(h.cues.map(c => c.text), ["real"]);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
