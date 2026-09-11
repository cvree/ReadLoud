// ==UserScript==
// @name         ReadLoud transcript helper
// @namespace    https://github.com/cvree/ReadLoud
// @version      1.0.0
// @description  Hands a YouTube transcript to ReadLoud, using your own logged-in session. Nothing is uploaded anywhere.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Why this has to run here, on youtube.com, rather than inside ReadLoud:
 *
 * Caption URLs are increasingly stamped `exp=xpe`, which means they require a
 * proof-of-origin token minted at runtime by YouTube's player JavaScript.
 * It is not a cookie, so no amount of session forwarding substitutes for it -
 * a request without one returns HTTP 200 and an empty body. On this page the
 * player has already minted one and put it in the caption URL, and the fetch
 * below is same-origin. That is the whole trick.
 *
 * Nothing is sent to any server. The transcript travels to ReadLoud in a URL
 * fragment, which browsers never transmit.
 */

(function () {
  "use strict";

  var ORIGIN_HASH = /(?:^|[#&])readloud=([^&]+)/;

  function run() {
    var m = ORIGIN_HASH.exec(location.hash);
    if (!m) return; // an ordinary visit to YouTube; do nothing at all
    var target;
    try {
      target = new URL(decodeURIComponent(m[1]));
    } catch (e) {
      return;
    }
    // Only ever hand the transcript back to the page that asked for it.
    if (document.referrer && new URL(document.referrer).origin !== target.origin) return;
    if (target.protocol !== "https:" && target.hostname !== "localhost") return;

    history.replaceState(null, "", location.pathname + location.search);
    grab(target.origin);
  }

  /* ── UI ───────────────────────────────────────────────────── */

  function banner(text, tone) {
    var el = document.getElementById("readloud-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "readloud-banner";
      el.style.cssText =
        "position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);" +
        "padding:11px 18px;border-radius:12px;font:500 14px/1.4 system-ui,sans-serif;" +
        "color:#fff;background:#11151f;box-shadow:0 12px 40px -12px rgba(0,0,0,.8);" +
        "border:1px solid rgba(255,255,255,.12);max-width:min(520px,90vw);text-align:center";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.borderColor = tone === "error" ? "rgba(255,107,138,.5)" : "rgba(255,255,255,.12)";
  }

  /* ── Extraction ───────────────────────────────────────────── */

  /**
   * `ytInitialPlayerResponse` is a global on a fresh load, but goes stale
   * across YouTube's client-side navigations, so fall back to the copy still
   * sitting in an inline script. Brace-matched rather than regex-terminated:
   * the JSON contains `};` inside string values.
   */
  function playerResponse() {
    if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.captions) {
      return window.ytInitialPlayerResponse;
    }
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].textContent || "";
      var at = src.indexOf("ytInitialPlayerResponse");
      if (at === -1) continue;
      var open = src.indexOf("{", at);
      if (open === -1) continue;
      var parsed = parseBalanced(src, open);
      if (parsed && parsed.captions) return parsed;
    }
    return null;
  }

  function parseBalanced(src, open) {
    var depth = 0, inStr = false, esc = false;
    for (var i = open; i < src.length; i++) {
      var ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(src.slice(open, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function pickTrack(tracks) {
    var want = (navigator.language || "en").slice(0, 2).toLowerCase();
    var manual = tracks.filter(function (t) { return t.kind !== "asr"; });
    // A human-written track in your language beats an auto-generated one, and
    // any human-written track beats an auto-generated one in your language.
    return (
      first(manual, want) || first(tracks, want) || manual[0] || tracks[0] || null
    );
  }

  function first(list, lang) {
    for (var i = 0; i < list.length; i++) {
      if ((list[i].languageCode || "").slice(0, 2).toLowerCase() === lang) return list[i];
    }
    return null;
  }

  function cuesFromJson3(data) {
    var out = [];
    var events = (data && data.events) || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      // `aAppend` events re-send text the previous event already carried, in
      // order to scroll a caption window. Pure duplication.
      if (ev.aAppend === 1 || !ev.segs || typeof ev.tStartMs !== "number") continue;
      var text = ev.segs.map(function (s) { return s.utf8 || ""; }).join("")
        .replace(/\s+/g, " ").trim();
      if (!text) continue;
      out.push({
        start: ev.tStartMs / 1000,
        end: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000,
        text: text,
      });
    }
    return out;
  }

  /** Last resort: read the transcript panel, which is what the reader sees. */
  function cuesFromPanel() {
    var nodes = document.querySelectorAll("ytd-transcript-segment-renderer");
    var out = [];
    nodes.forEach(function (n) {
      var stamp = n.querySelector(".segment-timestamp");
      var body = n.querySelector(".segment-text");
      if (!body) return;
      var text = (body.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      out.push({ start: toSeconds(stamp ? stamp.textContent : ""), end: 0, text: text });
    });
    for (var i = 0; i < out.length; i++) {
      if (!out[i].end) out[i].end = out[i + 1] ? out[i + 1].start : out[i].start;
    }
    return out;
  }

  function toSeconds(s) {
    var p = String(s || "").trim().split(":").map(Number);
    if (p.some(isNaN)) return 0;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0] || 0;
  }

  /* ── Transport ────────────────────────────────────────────── */

  function toBase64Url(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function encode(payload) {
    var json = new TextEncoder().encode(JSON.stringify(payload));
    var stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
  }

  async function grab(origin) {
    try {
      banner("ReadLoud: reading the transcript…");

      var pr = playerResponse();
      var tracks =
        (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
         pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];

      var cues = [];
      var lang;
      var track = pickTrack(tracks);

      if (track) {
        lang = track.languageCode;
        // json3 first; srv3 is the older shape and is sometimes served when
        // json3 comes back empty.
        for (var fmt of ["json3", "srv3"]) {
          var res = await fetch(track.baseUrl + "&fmt=" + fmt, { credentials: "include" });
          var body = await res.text();
          if (!body) continue;
          if (fmt === "json3") {
            try { cues = cuesFromJson3(JSON.parse(body)); } catch (e) { cues = []; }
          } else {
            var xml = new DOMParser().parseFromString(body, "text/xml");
            xml.querySelectorAll("text, p").forEach(function (n) {
              var t = (n.textContent || "").replace(/\s+/g, " ").trim();
              if (!t) return;
              var start = Number(n.getAttribute("start") || n.getAttribute("t") || 0);
              if (n.getAttribute("t")) start = start / 1000;
              var dur = Number(n.getAttribute("dur") || n.getAttribute("d") || 0);
              if (n.getAttribute("d")) dur = dur / 1000;
              cues.push({ start: start, end: start + dur, text: t });
            });
          }
          if (cues.length) break;
        }
      }

      // Empty body on a stamped URL is the proof-of-origin case. The panel is
      // rendered by the player itself, so it still has the words.
      if (!cues.length) cues = cuesFromPanel();

      if (!cues.length) {
        banner(
          tracks.length
            ? "ReadLoud: this video's captions are locked. Open the transcript panel, select it, and paste into ReadLoud."
            : "ReadLoud: this video has no captions.",
          "error",
        );
        return;
      }

      var details = (pr && pr.videoDetails) || {};
      var encoded = await encode({
        v: 1,
        videoId: details.videoId || new URLSearchParams(location.search).get("v") || "",
        title: details.title || document.title.replace(/ - YouTube$/, ""),
        author: details.author,
        lang: lang,
        cues: cues,
      });

      if (encoded.length > 1500000) {
        banner("ReadLoud: that transcript is too long to hand over. Copy it from the transcript panel instead.", "error");
        return;
      }

      banner("ReadLoud: got " + cues.length.toLocaleString() + " lines. Handing over…");
      location.replace(origin + "/#yt=" + encoded);
    } catch (err) {
      banner("ReadLoud: " + (err && err.message ? err.message : "could not read the transcript."), "error");
    }
  }

  run();
  // YouTube is a single-page app: a hash-carrying navigation may arrive
  // without a document load.
  window.addEventListener("yt-navigate-finish", run);
})();
