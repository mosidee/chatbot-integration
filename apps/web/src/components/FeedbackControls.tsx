import type { FeedbackRating, FeedbackReason } from '@ci/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Feedback } from '../lib/api'
import { Button, cn } from './ui'

/**
 * A thumb up or down on something the AI wrote, with a reason when it is down.
 *
 * The rating is one click because that is all an agent mid-shift will spend, and the vote
 * is recorded the moment the thumb is pressed: the reason popover that follows is an
 * invitation, not a form to complete. Dismissing it leaves a plain thumbs-down, which is
 * still worth more than nothing.
 *
 * Reasons come from a fixed list so they can be counted. Five named failures rank on the
 * dashboard into an ordered list of what to fix; five hundred sentences rank into nothing.
 *
 * The reason panel sits in the normal flow rather than floating over the thread. A floating
 * one is clipped by the scrolling message list, so for a message near the top its buttons
 * land underneath the header and cannot be pressed at all. In flow the list simply grows
 * and scrolls, which also leaves the panel usable on a phone.
 */

const REASONS: FeedbackReason[] = [
  'wrong_answer',
  'fabricated',
  'missing_knowledge',
  'wrong_tone_or_language',
  'should_have_handed_off',
]

function ThumbIcon({ down }: { down?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('h-3.5 w-3.5', down && 'rotate-180')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 14V6.5l3.2-4.3a1.4 1.4 0 0 1 2.4 1.2L9.5 6h3.4a1.4 1.4 0 0 1 1.35 1.8l-1.4 5A1.4 1.4 0 0 1 11.5 14H4.5Z" />
      <path d="M4.5 6.5H2.4A.9.9 0 0 0 1.5 7.4v5.7a.9.9 0 0 0 .9.9h2.1" />
    </svg>
  )
}

export function FeedbackControls({
  mine,
  canWrite,
  testIdPrefix,
  tone = 'light',
  onRate,
  onRemove,
}: {
  mine: Feedback | null
  canWrite: boolean
  testIdPrefix: string
  /** Bubbles are coloured, so the thumbs there need light ink; panels need dark. */
  tone?: 'light' | 'dark'
  onRate: (rating: FeedbackRating, reason?: FeedbackReason | null, note?: string | null) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState<FeedbackReason | null>(null)
  const [note, setNote] = useState('')

  const press = (rating: FeedbackRating) => {
    if (!canWrite) return
    // Pressing the thumb that is already lit withdraws the opinion rather than repeating it.
    if (mine?.rating === rating) {
      setAsking(false)
      onRemove()
      return
    }
    onRate(rating)
    if (rating === 'down') {
      setReason(mine?.reason ?? null)
      setNote(mine?.note ?? '')
      setAsking(true)
    } else {
      setAsking(false)
    }
  }

  const save = () => {
    onRate('down', reason, note)
    setAsking(false)
  }

  const idle = tone === 'dark' ? 'text-[var(--text-muted)]' : 'text-white/60'
  const hover = canWrite ? (tone === 'dark' ? 'hover:text-[var(--text)]' : 'hover:text-white') : ''

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          data-testid={`${testIdPrefix}-up`}
          aria-pressed={mine?.rating === 'up'}
          disabled={!canWrite}
          title={t('feedback.up')}
          aria-label={t('feedback.up')}
          onClick={() => press('up')}
          className={cn(
            'p-0.5 transition-colors',
            hover,
            mine?.rating === 'up' ? 'text-emerald-400' : idle,
          )}
        >
          <ThumbIcon />
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-down`}
          aria-pressed={mine?.rating === 'down'}
          disabled={!canWrite}
          title={t('feedback.down')}
          aria-label={t('feedback.down')}
          onClick={() => press('down')}
          className={cn(
            'p-0.5 transition-colors',
            hover,
            mine?.rating === 'down' ? 'text-red-400' : idle,
          )}
        >
          <ThumbIcon down />
        </button>
      </div>

      {asking ? (
        <div
          data-testid={`${testIdPrefix}-popover`}
          className="w-full min-w-[12rem] rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-left text-[12px] text-[var(--text)] shadow-sm"
        >
          <p className="mb-1.5 font-medium">{t('feedback.why')}</p>
          <div className="space-y-0.5">
            {REASONS.map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`${testIdPrefix}-reason-${value}`}
                aria-pressed={reason === value}
                onClick={() => setReason(value)}
                className={cn(
                  'block w-full rounded px-1.5 py-1 text-left transition-colors',
                  reason === value
                    ? 'bg-[var(--surface-muted)] font-medium'
                    : 'hover:bg-[var(--surface-muted)]',
                )}
              >
                {t(`feedback.reasons.${value}`)}
              </button>
            ))}
          </div>
          <input
            data-testid={`${testIdPrefix}-note`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('feedback.notePlaceholder')}
            maxLength={1000}
            className="mt-1.5 w-full rounded border border-[var(--border)] bg-[var(--surface-muted)] px-1.5 py-1 text-[12px] outline-none"
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button size="sm" variant="primary" data-testid={`${testIdPrefix}-save`} onClick={save}>
              {t('feedback.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`${testIdPrefix}-skip`}
              onClick={() => setAsking(false)}
            >
              {t('feedback.skip')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
