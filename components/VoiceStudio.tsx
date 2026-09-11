"use client";
/* ────────────────────────────────────────────────────────────────
   Voice studio — provider, voice, and the pacing controls that turn
   a speech engine into something you can listen to for three hours.
   ──────────────────────────────────────────────────────────────── */

import { useMemo, useState } from "react";
import { useStore, primeAudio } from "@/lib/store";
import { PROVIDERS, getProvider } from "@/lib/tts/registry";
import { useModelState } from "@/lib/tts/use-model-state";
import { CHUNK_PRESETS, type ChunkPreset } from "@/lib/text/chunk";
import { isEnglishVoice, languageLabel } from "@/lib/tts/language";
import { Button, Field, Segmented, Select, Slider, Switch } from "./ui/Primitives";
import { Eye, Mic, Play, Sparkle, Warning } from "./ui/Icons";
import type { ProviderId } from "@/lib/types";

const PREVIEW =
  "The sea is high tonight, and the harbour lights are burning low. Listen closely, and you can hear the whole coast breathing.";

export function VoiceStudio() {
  const providerId = useStore((s) => s.providerId);
  const availableProviders = useStore((s) => s.availableProviders);
  const selectProvider = useStore((s) => s.selectProvider);
  const voices = useStore((s) => s.voices);
  const voiceId = useStore((s) => s.voiceId);
  const selectVoice = useStore((s) => s.selectVoice);
  const rate = useStore((s) => s.rate);
  const setRate = useStore((s) => s.setRate);
  const pitch = useStore((s) => s.pitch);
  const setPitch = useStore((s) => s.setPitch);
  const gapSeconds = useStore((s) => s.gapSeconds);
  const setGap = useStore((s) => s.setGap);
  const stopAtSectionEnd = useStore((s) => s.stopAtSectionEnd);
  const setStopAtSectionEnd = useStore((s) => s.setStopAtSectionEnd);
  const followCursor = useStore((s) => s.followCursor);
  const setFollowCursor = useStore((s) => s.setFollowCursor);
  const focusMode = useStore((s) => s.focusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const fontScale = useStore((s) => s.fontScale);
  const setFontScale = useStore((s) => s.setFontScale);
  const chunkPreset = useStore((s) => s.chunkPreset);
  const setChunkPreset = useStore((s) => s.setChunkPreset);
  const setRsvpEnabled = useStore((s) => s.setRsvpEnabled);
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);

  const [previewing, setPreviewing] = useState(false);
  const provider = getProvider(providerId);
  // Which backend Kokoro settled on — WebGPU or WASM — once it is running.
  const device = useModelState().device;

  const voiceOptions = useMemo(
    () =>
      voices.map((v) => ({
        value: v.id,
        label: v.name,
        // The descriptor is a sentence ("American - warmest, best overall"),
        // so it belongs on the hint line. Rendered as a badge it squeezed the
        // voice's actual name down to nothing.
        hint: v.tag ?? [v.lang, v.local === false ? "network" : "on-device"].join(" - "),
        badge: v.local === false ? "network" : undefined,
      })),
    [voices],
  );

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId),
    [voices, voiceId],
  );
  /** The best English voice this engine has, for the one-click fix below. */
  const englishVoice = useMemo(
    () => voices.find((v) => isEnglishVoice(v.lang)),
    [voices],
  );

  const preview = async () => {
    if (previewing || !voiceId) return;
    setPreviewing(true);
    await primeAudio();
    const handle = provider.speak({
      text: PREVIEW,
      voiceId,
      rate,
      pitch,
      volume: 1,
    });
    try {
      await handle.done;
    } catch (err) {
      toast({
        tone: "error",
        title: "Preview failed",
        body: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="scroll-fine h-full overflow-y-auto px-4 py-4">
      {/* Provider */}
      <div className="mb-1 text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
        Engine
      </div>
      <div className="mt-2 space-y-1.5">
        {PROVIDERS.map((p) => {
          const enabled = availableProviders.includes(p.id);
          const active = p.id === providerId;
          return (
            <button
              key={p.id}
              disabled={!enabled}
              onClick={() => void selectProvider(p.id as ProviderId)}
              className={`ring-focus block w-full rounded-xl border px-3 py-2.5 text-left transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45 ${
                active
                  ? "border-[color-mix(in_oklab,var(--color-iris-500)_55%,transparent)] bg-[color-mix(in_oklab,var(--color-iris-500)_13%,transparent)]"
                  : "border-[var(--hairline)] hover:border-[var(--hairline-strong)] hover:bg-[color-mix(in_oklab,white_5%,transparent)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-[13px] font-medium ${active ? "text-ink-100" : "text-ink-200"}`}>
                  {p.label}
                </span>
                {p.capabilities.synthesize && (
                  <span
                    title="Can render audio files directly — instant MP3 export"
                    className="rounded-md bg-[color-mix(in_oklab,var(--color-mint-500)_18%,transparent)] px-1.5 py-0.5 text-[9.5px] font-bold tracking-wider text-mint-500 uppercase"
                  >
                    MP3
                  </span>
                )}
                {!enabled && (
                  <span className="ml-auto text-[10px] font-medium text-ink-500">
                    unsupported here
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-ink-400">{p.blurb}</p>
            </button>
          );
        })}
      </div>

      {providerId === "kokoro" && <ModelStatus />}

      <div className="my-4 h-px bg-[var(--hairline)]" />

      {/* Voice */}
      <Field label="Voice" value={`${voices.length} available`}>
        <Select
          value={voiceId}
          options={voiceOptions}
          onChange={selectVoice}
          placeholder="Loading voices"
        />
        <Button
          size="sm"
          className="mt-2 w-full"
          onClick={preview}
          disabled={previewing || !voiceId}
        >
          {previewing ? (
            <>
              <span className="eq text-iris-400"><span /><span /><span /><span /><span /></span>
              Speaking
            </>
          ) : (
            <>
              <Play width={12} height={12} />
              Preview this voice
            </>
          )}
        </Button>
      </Field>

      {voices.length === 0 && providerId === "webspeech" && (
        <div className="mt-2 flex gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-ember-500)_28%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_8%,transparent)] px-2.5 py-2">
          <Warning width={13} height={13} className="mt-0.5 shrink-0 text-ember-500" />
          <p className="text-[11px] leading-snug text-ember-400">
            This browser reports no installed speech voices. On Linux install
            speech-dispatcher and a voice package; on Windows and macOS add one in
            the system accessibility settings. Or switch to Kokoro, which brings its
            own voices and needs nothing from the operating system.
          </p>
        </div>
      )}

      {selectedVoice && !isEnglishVoice(selectedVoice.lang) && (
        <div className="mt-2 flex gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-ember-500)_28%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_8%,transparent)] px-2.5 py-2">
          <Warning width={13} height={13} className="mt-0.5 shrink-0 text-ember-500" />
          <p className="text-[11px] leading-snug text-ember-400">
            {selectedVoice.name} is a{" "}
            {languageLabel(selectedVoice.lang)} voice. ReadLoud reads in English, and
            an English sentence spoken with another language&apos;s phonemes is close
            to unintelligible.{" "}
            {englishVoice ? (
              <button
                className="underline decoration-dotted underline-offset-2 hover:text-ember-500"
                onClick={() => selectVoice(englishVoice.id)}
              >
                Switch to {englishVoice.name}
              </button>
            ) : (
              <span className="text-ink-400">
                This browser has no English voice installed — Kokoro brings its own.
              </span>
            )}
          </p>
        </div>
      )}

      {voices.length > 0 && !provider.capabilities.boundaries && (
        <div className="mt-2 flex gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-ember-500)_28%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_8%,transparent)] px-2.5 py-2">
          <Warning width={13} height={13} className="mt-0.5 shrink-0 text-ember-500" />
          <p className="text-[11px] leading-snug text-ember-400">
            This engine reports no word timings, so reading-mode highlighting is
            interpolated from clip duration rather than sample-accurate.
          </p>
        </div>
      )}

      <div className="my-4 h-px bg-[var(--hairline)]" />

      {/* Pacing */}
      <div className="mb-1 text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
        Pacing
      </div>

      <Field label="Speed" value={`${rate.toFixed(2)}x`}>
        <Slider value={rate} min={0.5} max={3} step={0.05} onChange={setRate} aria-label="Speed" />
      </Field>

      <Field
        label="Pitch"
        value={pitch.toFixed(2)}
        hint={
          provider.capabilities.pitch ? undefined : `${provider.label} does not expose pitch control.`
        }
      >
        <Slider
          value={pitch}
          min={0.5}
          max={1.6}
          step={0.05}
          onChange={setPitch}
          aria-label="Pitch"
          className={provider.capabilities.pitch ? "" : "pointer-events-none opacity-40"}
        />
      </Field>

      <Field
        label="Pause between passages"
        value={`${gapSeconds.toFixed(2)}s`}
        hint="A short beat between passages is the difference between narration and a list of sentences."
      >
        <Slider value={gapSeconds} min={0} max={1.2} step={0.02} onChange={setGap} aria-label="Pause" />
      </Field>

      <Field
        label="Passage length"
        hint={
          chunkPreset === "responsive"
            ? "Short passages: tightest highlight sync and fastest seeking."
            : chunkPreset === "economical"
              ? "Long passages: fewest API calls, cheapest on paid voices."
              : "Balanced: natural phrasing with responsive seeking."
        }
      >
        <Segmented<ChunkPreset>
          stretch
          className="w-full"
          value={chunkPreset}
          onChange={setChunkPreset}
          options={(Object.keys(CHUNK_PRESETS) as ChunkPreset[]).map((k) => ({
            value: k,
            label: k === "responsive" ? "Short" : k === "balanced" ? "Balanced" : "Long",
            title: `${CHUNK_PRESETS[k].maxChars} characters max`,
          }))}
        />
      </Field>

      <div className="my-4 h-px bg-[var(--hairline)]" />

      {/* Reading */}
      <div className="mb-1 text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
        Reading
      </div>

      <Field label="Text size" value={`${Math.round(fontScale * 100)}%`}>
        <Slider
          value={fontScale}
          min={0.8}
          max={1.6}
          step={0.05}
          onChange={setFontScale}
          aria-label="Text size"
        />
      </Field>

      <Button
        size="sm"
        className="mt-1 w-full gap-1.5"
        disabled={!doc}
        onClick={() => setRsvpEnabled(true)}
        title="One word at a time, paced by the voice or by a clock (R)"
      >
        <Eye width={13} height={13} />
        Enter reading mode
      </Button>

      <div className="mt-3 divide-y divide-[var(--hairline)]">
        <Switch
          checked={followCursor}
          onChange={setFollowCursor}
          label="Follow the narrator"
          hint="Auto-scroll to keep the spoken passage in view. Pauses for 3 seconds after you scroll."
        />
        <Switch
          checked={focusMode}
          onChange={setFocusMode}
          label="Focus mode"
          hint="Dim everything except the passage being spoken."
        />
        <Switch
          checked={stopAtSectionEnd}
          onChange={setStopAtSectionEnd}
          label="Stop at section end"
          hint="Pause automatically at each chapter or page boundary."
        />
      </div>

      <div className="mt-5 flex items-start gap-2 rounded-xl border border-[var(--hairline)] px-3 py-2.5">
        <Sparkle width={14} height={14} className="mt-0.5 shrink-0 text-iris-400" />
        <p className="text-[11px] leading-snug text-ink-400">
          Every voice here runs on this machine. Nothing you open — and nothing that
          gets spoken — is ever sent anywhere. Preferences persist locally.
        </p>
      </div>

      <div className="mt-3 flex items-start gap-2 px-3 text-[11px] leading-snug text-ink-500">
        <Mic width={13} height={13} className="mt-0.5 shrink-0" />
        <span>
          Engine: <span className="text-ink-300">{provider.label}</span>
          {providerId === "kokoro" && device && (
            <span className="text-ink-500"> · {device}</span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * The state of the on-device model, in the one place a reader would look for it.
 *
 * An 86 MB download that happens silently between pressing play and hearing
 * anything reads as a hang, so the bar is not decoration: it is the difference
 * between "this is broken" and "this is working".
 */
function ModelStatus() {
  const model = useModelState();

  if (model.phase === "ready") {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-mint-500)_28%,transparent)] bg-[color-mix(in_oklab,var(--color-mint-500)_8%,transparent)] px-2.5 py-2">
        <Sparkle width={13} height={13} className="shrink-0 text-mint-500" />
        <p className="text-[11px] leading-snug text-ink-300">
          Voice model loaded and cached. It works offline from here.
        </p>
      </div>
    );
  }

  if (model.phase === "error") {
    return (
      <div className="mt-2 flex gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-ember-500)_28%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_8%,transparent)] px-2.5 py-2">
        <Warning width={13} height={13} className="mt-0.5 shrink-0 text-ember-500" />
        <p className="text-[11px] leading-snug text-ember-400">
          {model.detail || "The voice model could not start."}{" "}
          <span className="text-ink-400">
            System voices still work in the meantime.
          </span>
        </p>
      </div>
    );
  }

  if (model.phase === "loading") {
    return (
      <div className="mt-2 rounded-lg border border-[var(--hairline)] px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-ink-300">{model.detail}</p>
          <span className="shrink-0 text-[10px] tabular-nums text-ink-500">
            {Math.round(model.ratio * 100)}%
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[color-mix(in_oklab,white_8%,transparent)]">
          <div
            className="h-full rounded-full bg-iris-400 transition-[width] duration-300"
            style={{ width: `${Math.max(2, model.ratio * 100)}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <p className="mt-2 px-0.5 text-[11px] leading-snug text-ink-500">
      Downloads once (~86 MB) the first time you press play, then runs offline
      forever. Nothing is sent anywhere.
    </p>
  );
}
