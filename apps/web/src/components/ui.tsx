import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Small presentational primitives.
 *
 * Hand-written rather than pulled from a component library: the agent console needs a
 * dozen dense elements, and owning them keeps the bundle small and the styling coherent.
 */

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-500)]'
  const sizes = { sm: 'h-8 px-2.5 text-[13px]', md: 'h-9 px-3.5 text-sm' }
  const variants = {
    primary: 'bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)]',
    secondary:
      'border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)]',
    ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-brand-500)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-brand-500)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
      {children}
    </label>
  )
}

export function Card({
  children,
  className,
  testId,
}: {
  children: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      className={cn('rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4', className)}
    >
      {children}
    </div>
  )
}

const MODE_STYLES: Record<string, string> = {
  ai: 'bg-[var(--color-brand-100)] text-[var(--color-brand-700)]',
  ai_supervised: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  human: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  waiting_human: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
}

export function ModeBadge({ mode, label }: { mode: string; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        MODE_STYLES[mode] ?? 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
      )}
    >
      {label}
    </span>
  )
}

/**
 * Which channel a conversation is on.
 *
 * Worth showing on every row since a customer reaching us on LINE and on the widget has two
 * threads that are otherwise identical at a glance. Coloured by the platform's own colour
 * where it has one, because that is what an agent recognises before they read the word.
 */
const CHANNEL_STYLES: Record<string, string> = {
  line: 'bg-[#06C755]/15 text-[#069340] dark:text-[#4ade80]',
  messenger: 'bg-[#0084FF]/15 text-[#0068cc] dark:text-[#60a5fa]',
  web: 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
  test: 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
}

export function ChannelBadge({
  type,
  label,
  testId,
}: {
  type: string
  label: string
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        CHANNEL_STYLES[type] ?? 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
      )}
    >
      {label}
    </span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <span
        className="size-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--color-brand-500)]"
        aria-hidden
      />
      {label}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm font-medium text-[var(--text)]">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-[var(--text-muted)]">{hint}</p> : null}
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return (
    // `alert`, so a failure announces itself. Several of these render far from whatever the
    // person just pressed, and somebody using a screen reader would otherwise press Save
    // and hear nothing at all.
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {message}
    </div>
  )
}

/**
 * The few glyphs this console needs, drawn inline.
 *
 * No icon library: seven shapes do not justify a dependency, and these inherit `currentColor`
 * so they follow whatever text colour they sit in. Every one of them is decorative — the
 * button around it carries the name — hence `aria-hidden` throughout.
 */
const ICON_PATHS: Record<string, string> = {
  back: 'M10 4 4 10l6 6M4 10h12',
  close: 'M5 5l10 10M15 5 5 15',
  attach: 'M13 7.5 8.6 12a2 2 0 0 0 2.8 2.8l4.6-4.6a3.5 3.5 0 0 0-5-5l-5 5a5 5 0 0 0 7 7',
  sparkle: 'M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z',
  check: 'M4 10.5 8 14.5 16 5.5',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
}

export function Icon({ name, className }: { name: keyof typeof ICON_PATHS; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn('size-4 shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/**
 * The day a run of messages belongs to.
 *
 * A thread can run for months, and every bubble showed only a clock time — so a reply from
 * March and one from this morning were indistinguishable at a glance. "Today" and
 * "Yesterday" rather than a date for the two days an agent is usually reading.
 */
export function dayLabel(iso: string, language: string): string {
  const date = new Date(iso)
  const midnight = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000)

  if (days === 0 || days === 1) {
    return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-days, 'day')
  }
  return new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
}

/** True when two instants fall on different calendar days, in the reader's own timezone. */
export function isNewDay(previous: string | null, current: string): boolean {
  if (!previous) return true
  return new Date(previous).toDateString() !== new Date(current).toDateString()
}

/** Relative time that stays readable in a dense list. */
export function timeAgo(iso: string | null, language: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const seconds = Math.round((Date.now() - then) / 1000)
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (seconds < 60) return rtf.format(-seconds, 'second')
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour')
  return rtf.format(-Math.round(seconds / 86400), 'day')
}

export function formatTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

/**
 * A destructive action that takes two clicks.
 *
 * The same idiom as `EraseCustomer`, extracted because removing a member, suspending a
 * tenant and revoking a platform admin all want it. A browser `confirm` was rejected for
 * these: it blocks the page, cannot be translated, and is the one dialog people dismiss by
 * reflex. The armed state expires on its own, so a button left armed by accident stops
 * being dangerous without anybody noticing it was.
 */
export function ConfirmButton({
  label,
  armedLabel,
  onConfirm,
  disabled,
  size = 'sm',
  testId,
  armedForMs = 5000,
}: {
  label: string
  armedLabel: string
  onConfirm: () => void
  disabled?: boolean
  size?: 'sm' | 'md'
  testId?: string
  armedForMs?: number
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), armedForMs)
    return () => clearTimeout(timer)
  }, [armed, armedForMs])

  return (
    <Button
      size={size}
      variant={armed ? 'danger' : 'ghost'}
      disabled={disabled}
      data-testid={testId}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? armedLabel : label}
    </Button>
  )
}

/**
 * A secret shown once, with a button to copy it.
 *
 * Invitation and reset links cannot be read back: only their hash is stored. So the one
 * moment they exist in the console is this one, and the affordance has to make that
 * obvious rather than letting somebody navigate away and come back for it.
 */
export function CopyOnce({
  value,
  hint,
  copyLabel,
  copiedLabel,
  testId,
}: {
  value: string
  hint: string
  copyLabel: string
  copiedLabel: string
  testId?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="space-y-1.5 rounded-lg border border-[var(--color-brand-500)] bg-[var(--surface-muted)] p-2.5">
      <p className="text-[12px] text-[var(--text-muted)]">{hint}</p>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} data-testid={testId} className="font-mono text-[12px]" />
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            } catch {
              // A browser that refuses the clipboard still shows the link to select by hand.
            }
          }}
        >
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * Whether the last thing somebody changed was saved, said where they changed it.
 *
 * The console autosaves on blur and on change, so there is no Save button to watch. The
 * only confirmation used to be one word beside the page heading for two seconds: editing a
 * channel at the bottom of a long page, nobody ever saw it, and a failure showed nothing at
 * all — the box kept the typed text while the server kept the old value.
 *
 * `role="status"` rather than a toast, so it is announced and so it sits next to the thing
 * it is talking about.
 */
export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: number }
  | { status: 'failed'; message: string }

export function useSaveState(): {
  state: SaveState
  /** Hand these to `useMutation` to have it drive the line. */
  handlers: {
    onMutate: () => void
    onSuccess: () => void
    onError: (error: unknown) => void
  }
} {
  const [state, setState] = useState<SaveState>({ status: 'idle' })

  return {
    state,
    handlers: {
      onMutate: () => setState({ status: 'saving' }),
      onSuccess: () => setState({ status: 'saved', at: Date.now() }),
      onError: (error: unknown) =>
        setState({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
    },
  }
}

export function SaveStatus({ state, className }: { state: SaveState; className?: string }) {
  const { t, i18n } = useTranslation()
  if (state.status === 'idle') return null

  if (state.status === 'failed') {
    // A failure is not a status line. It stays until something else happens, and it says
    // what went wrong rather than only that something did.
    return (
      <p role="alert" className={cn('text-[12px] text-red-700 dark:text-red-300', className)}>
        {t('settings.saveFailed')}: {state.message}
      </p>
    )
  }

  return (
    <p role="status" className={cn('text-[12px] text-[var(--text-muted)]', className)}>
      {state.status === 'saving'
        ? t('common.saving')
        : `${t('settings.saved')} ${formatTime(new Date(state.at).toISOString(), i18n.language)}`}
    </p>
  )
}
