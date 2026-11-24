import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon } from './icons';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* ----------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-fg border-line-strong hover:bg-subtle',
  ghost: 'bg-transparent text-fg border-transparent hover:bg-subtle',
  danger: 'bg-surface text-bad border-line-strong hover:bg-bad-soft',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8.5 px-3 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg disabled:opacity-50', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/* ----------------------------------------------------------------------------
 * Layout
 * ------------------------------------------------------------------------- */

export function Card({ title, actions, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-2 border-b border-line px-3.5 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-[13.5px] font-semibold">{title}</h2>}
            {subtitle && <p className="text-[12.5px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className="px-3.5 py-3">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-[17px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-[12.5px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
const TONES: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  good: 'bg-good-soft text-good border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11.5px] font-medium whitespace-nowrap', TONES[tone])}>
      {children}
    </span>
  );
}

export function Alert({ tone = 'neutral', title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const icon = tone === 'bad' || tone === 'warn' ? <Icon.Alert size={16} /> : <Icon.Info size={16} />;
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('flex gap-2 rounded-md border px-3 py-2 text-[12.5px]', TONES[tone])}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 text-fg">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-fg/85">{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong bg-surface px-6 py-8 text-center">
      {icon && <div className="mb-2 text-muted">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[12.5px] text-muted">{children}</div>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-muted" role="status">
      <Spinner /> {label}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Form controls
 * ------------------------------------------------------------------------- */

const control =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60';

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: (id: string, describedBy?: string) => ReactNode; className?: string }) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12.5px] font-medium">
        {label}
      </label>
      {children(id, hintId)}
      {(hint || error) && (
        <p id={hintId} className={cx('text-[12px]', error ? 'text-bad' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, 'h-8.5', className)} {...rest} />;
});

/** A text input that saves on blur or Enter rather than on every keystroke. */
export function CommitInput({ value, onCommit, type = 'text', ...rest }: { value: string | number; onCommit: (v: string) => void; type?: string; id?: string; min?: number; max?: number; step?: number; placeholder?: string; 'aria-label'?: string; autoComplete?: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <Input
      {...rest}
      type={type}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== String(value) && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(control, 'py-2 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, 'h-8.5 pr-7', className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  // Shown optimistically: many callers persist to storage and re-render a moment later.
  const [shown, setShown] = useState(checked);
  useEffect(() => setShown(checked), [checked]);
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        checked={shown}
        disabled={disabled}
        onChange={(e) => {
          setShown(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <label htmlFor={id} className="text-[13px] leading-snug">
        {label}
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </label>
    </div>
  );
}

/** Comma/newline separated list editor backed by string[]. */
/** Multi-value input. With `rows`, one item per line; `commas` also splits on commas (for skills, not bullets). */
export function ListInput({ value, onChange, placeholder, id, rows, commas }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; id?: string; rows?: number; commas?: boolean }) {
  const [text, setText] = useState(value.join(rows ? '\n' : ', '));
  const last = useRef(value);
  useEffect(() => {
    if (last.current.join('\u0000') !== value.join('\u0000')) {
      setText(value.join(rows ? '\n' : ', '));
      last.current = value;
    }
  }, [value, rows]);
  const commit = (t: string) => {
    const parts = t
      .split(rows && !commas ? /\n/ : /[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    last.current = parts;
    onChange(parts);
  };
  return rows ? (
    <TextArea id={id} rows={rows} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)} />
  ) : (
    <Input id={id} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)} />
  );
}

/* ----------------------------------------------------------------------------
 * Tabs (WAI-ARIA tabs pattern with roving tabindex)
 * ------------------------------------------------------------------------- */

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          onKeyDown={(e) => onKey(e, i)}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px border-b-2 px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap',
            t.id === value ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Dialog (native <dialog>: focus trapping and Escape handling built in)
 * ------------------------------------------------------------------------- */

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      // close() fires its event asynchronously; ignore it if the dialog was meant to close anyway or was reopened since.
      onClose={() => {
        if (open && !ref.current?.open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx('m-auto w-[calc(100%-24px)] rounded-lg border border-line bg-surface p-0 text-fg shadow-xl', wide ? 'max-w-2xl' : 'max-w-md')}
      aria-labelledby={titleId}
    >
      {open && (
        <>
          <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 id={titleId} className="font-semibold">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose}>
              <Icon.X />
            </IconButton>
          </header>
          <div className="max-h-[70vh] overflow-y-auto px-4 py-3">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}

/* ----------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------- */

interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}
const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: Tone = 'neutral') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3">
        {items.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto max-w-sm rounded-md border px-3 py-2 text-[12.5px] shadow-lg', t.tone === 'neutral' ? 'border-line bg-fg text-canvas' : TONES[t.tone])}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ----------------------------------------------------------------------------
 * Score visualisation
 * ------------------------------------------------------------------------- */

export function scoreTone(score: number): Tone {
  return score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';
}

export function ScoreRing({ score, size = 64, label = 'Match score' }: { score: number; size?: number; label?: string }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const tone = scoreTone(score);
  const color = tone === 'good' ? 'var(--color-good)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-bad)';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${score} out of 100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-line)" strokeWidth="6" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="6" fill="none" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums" style={{ fontSize: size * 0.3 }}>
        {score}
      </span>
    </div>
  );
}

export function ScorePill({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <Badge>—</Badge>;
  return (
    <Badge tone={scoreTone(score)} title="Profile match score (not a hiring probability)">
      <span className="tabular-nums">{score}</span>
    </Badge>
  );
}

/** `value` is a fraction from 0 to 1. */
export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = scoreTone(pct);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div className={cx('h-full rounded-full', tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-warn' : 'bg-bad')} style={{ width: `${pct}%` }} />
    </div>
  );
}
