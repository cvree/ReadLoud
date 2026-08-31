"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Check, Chevron, Close } from "./Icons";

/* ── Button ─────────────────────────────────────────────────── */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "bare";
  size?: "sm" | "md" | "lg" | "icon";
};

const SIZES: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
  icon: "h-10 w-10",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", className = "", ...rest },
  ref,
) {
  const variantClass =
    variant === "primary"
      ? "btn-primary"
      : variant === "ghost"
        ? "btn-ghost"
        : "text-ink-300 hover:text-ink-100";
  return (
    <button
      ref={ref}
      className={`btn ring-focus ${SIZES[size]} ${variantClass} ${className}`}
      {...rest}
    />
  );
});

/* ── Slider ─────────────────────────────────────────────────── */

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  label?: string;
  "aria-label"?: string;
  className?: string;
}

/**
 * The webkit track paints its filled portion from a `--fill` custom property,
 * which has to be recomputed on every value change — there is no CSS-only way
 * to express "colour the track up to the thumb" cross-engine.
 */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  className = "",
  ...rest
}: SliderProps) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={`range ring-focus ${className}`}
      style={{ ["--fill" as string]: `${pct}%` }}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={() => onCommit?.(value)}
      onKeyUp={() => onCommit?.(value)}
      {...rest}
    />
  );
}

/* ── Switch ─────────────────────────────────────────────────── */

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
        <div className="text-[13px] font-medium text-ink-100">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-400">{hint}</div>}
      </label>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`ring-focus relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ${
          checked
            ? "bg-gradient-to-r from-iris-500 to-aqua-500"
            : "bg-[color-mix(in_oklab,white_12%,transparent)]"
        }`}
      >
        <span
          className="absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-200"
          style={{
            transform: checked ? "translateX(16px)" : "none",
            transitionTimingFunction: "var(--ease-out-soft)",
          }}
        />
      </button>
    </div>
  );
}

/* ── Segmented control ──────────────────────────────────────── */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = "",
  stretch = false,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  className?: string;
  /** Distribute the options across the full width instead of hugging content. */
  stretch?: boolean;
}) {
  return (
    <div
      role="tablist"
      className={`${stretch ? "flex" : "inline-flex"} items-center gap-1 rounded-xl border border-[var(--hairline)] bg-[var(--field)] p-1 ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`ring-focus flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-200 ${
              stretch ? "min-w-0 flex-1" : ""
            } ${
              active
                ? "bg-[color-mix(in_oklab,white_11%,transparent)] text-ink-100 shadow-sm"
                : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Select ─────────────────────────────────────────────────── */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  badge?: string;
  disabled?: boolean;
}

/**
 * A listbox rather than a native <select>: we need two lines of content and a
 * badge per row, which no browser lets you put inside an <option>. Keyboard
 * behaviour (arrows, Home/End, Escape, type-ahead-free) is implemented to
 * match the native control.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select",
  className = "",
  maxHeight = 320,
}: {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (v: T) => void;
  placeholder?: string;
  className?: string;
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="ring-focus flex w-full items-center gap-2 rounded-xl border border-[var(--hairline)] bg-[color-mix(in_oklab,white_4%,transparent)] px-3 py-2.5 text-left transition-colors duration-[160ms] hover:border-[var(--hairline-strong)] hover:bg-[color-mix(in_oklab,white_8%,transparent)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink-100">
            {selected?.label ?? placeholder}
          </span>
          {selected?.hint && (
            <span className="mt-0.5 block truncate text-[11px] text-ink-400">{selected.hint}</span>
          )}
        </span>
        {selected?.badge && (
          <span className="shrink-0 rounded-md bg-[color-mix(in_oklab,var(--color-iris-500)_22%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-iris-400 uppercase">
            {selected.badge}
          </span>
        )}
        <Chevron
          width={15}
          height={15}
          className="shrink-0 text-ink-400 transition-transform duration-200"
          style={{ transform: open ? "rotate(-90deg)" : "rotate(90deg)" }}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            if (e.key === "Home") { e.preventDefault(); setActive(0); }
            if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
            if (e.key === "Enter") { e.preventDefault(); commit(active); }
          }}
          className="glass-strong scroll-fine animate-fade absolute z-50 mt-2 w-full overflow-y-auto rounded-xl p-1"
          style={{ maxHeight }}
        >
          {options.length === 0 && (
            <div className="px-3 py-4 text-center text-[12.5px] text-ink-400">
              No voices available
            </div>
          )}
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                data-index={i}
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-[120ms] disabled:opacity-40 ${
                  i === active ? "bg-[color-mix(in_oklab,white_9%,transparent)]" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink-100">{opt.label}</span>
                  {opt.hint && (
                    <span className="mt-0.5 block truncate text-[11px] text-ink-400">{opt.hint}</span>
                  )}
                </span>
                {opt.badge && (
                  <span className="shrink-0 rounded-md border border-[var(--hairline)] px-1.5 py-0.5 text-[10px] font-medium text-ink-300">
                    {opt.badge}
                  </span>
                )}
                {isSelected && <Check width={15} height={15} className="shrink-0 text-iris-400" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Dialog ─────────────────────────────────────────────────── */

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 640,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="animate-fade absolute inset-0 bg-black/65 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="glass-strong animate-rise relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl"
        style={{ maxWidth: width }}
      >
        <header className="hairline-b flex items-start gap-4 px-6 py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold tracking-tight text-ink-100">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-ink-400">{subtitle}</p>}
          </div>
          <Button variant="bare" size="icon" onClick={onClose} aria-label="Close">
            <Close width={18} height={18} />
          </Button>
        </header>
        <div className="scroll-fine min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="hairline-t flex items-center justify-end gap-3 px-6 py-4">{footer}</footer>}
      </div>
    </div>
  );
}

/* ── Progress ───────────────────────────────────────────────── */

export function Progress({
  value,
  indeterminate = false,
  className = "",
}: {
  value: number;
  indeterminate?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,white_10%,transparent)] ${className}`}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full bg-gradient-to-r from-iris-500 to-aqua-500 ${indeterminate ? "shimmer w-1/3" : ""}`}
        style={
          indeterminate
            ? undefined
            : { width: `${Math.min(100, Math.max(0, value * 100))}%`, transition: "width 220ms var(--ease-out-soft)" }
        }
      />
    </div>
  );
}

/* ── Field wrapper ──────────────────────────────────────────── */

export function Field({
  label,
  value,
  children,
  hint,
}: {
  label: string;
  value?: ReactNode;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="py-2.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-[0.07em] text-ink-400 uppercase">
          {label}
        </span>
        {value !== undefined && (
          <span className="tabular text-[12.5px] font-medium text-ink-200">{value}</span>
        )}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-[11.5px] leading-snug text-ink-400">{hint}</p>}
    </div>
  );
}
