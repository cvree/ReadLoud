"use client";

import { useStore } from "@/lib/store";
import { Check, Close, Info, Warning } from "./ui/Icons";

const TONE = {
  success: { icon: Check, color: "text-mint-500", edge: "var(--color-mint-500)" },
  error: { icon: Warning, color: "text-rose-500", edge: "var(--color-rose-500)" },
  warn: { icon: Warning, color: "text-ember-500", edge: "var(--color-ember-500)" },
  info: { icon: Info, color: "text-iris-400", edge: "var(--color-iris-500)" },
} as const;

export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const tone = TONE[t.tone];
        const Icon = tone.icon;
        return (
          <div
            key={t.id}
            className="glass-strong animate-toast pointer-events-auto flex items-start gap-2.5 rounded-xl py-3 pr-2.5 pl-3.5"
            style={{ borderLeft: `2px solid ${tone.edge}` }}
          >
            <Icon width={16} height={16} className={`mt-0.5 shrink-0 ${tone.color}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink-100">{t.title}</div>
              {t.body && (
                <div className="mt-0.5 text-[12px] leading-snug text-ink-400">{t.body}</div>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded-md p-1 text-ink-500 transition-colors hover:text-ink-200"
            >
              <Close width={13} height={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
