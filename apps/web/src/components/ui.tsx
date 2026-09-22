import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useState,
} from 'react'

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

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
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
    <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {message}
    </div>
  )
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
