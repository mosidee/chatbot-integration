import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SetupChecklist } from '../components/SetupChecklist'
import { Card, cn, EmptyState, ErrorNote, Spinner } from '../components/ui'
import { api, type Dashboard as DashboardData } from '../lib/api'

/**
 * The pilot's numbers.
 *
 * Few on purpose. Volume says whether anyone is using it, the answered share says whether
 * the AI is carrying its weight, the handoff reasons say what to write next in the
 * knowledge base, and first response time says what a customer actually experienced.
 *
 * The chart is drawn with divs rather than a charting library. Fourteen bars do not justify
 * a dependency, and this way the page weighs nothing.
 */

const WINDOWS = [7, 14, 30] as const

function formatDuration(seconds: number | null, t: (key: string) => string): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${Math.round(seconds)} ${t('dashboard.seconds')}`
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${t('dashboard.minutes')}`
  return `${(seconds / 3600).toFixed(1)} ${t('dashboard.hours')}`
}

function Figure({
  label,
  value,
  hint,
  definition,
  testId,
}: {
  label: string
  value: string
  hint?: string
  /**
   * Exactly what is counted, over what and when. "Answered" and "first response" read as
   * obvious and are not: they count delivered replies only, in the workspace's own days.
   */
  definition?: string
  testId: string
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-[var(--border)] p-3" data-testid={testId}>
      <div className="text-[12px] text-[var(--text-muted)]">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{hint}</div> : null}
      {definition ? (
        <details className="mt-1 text-[11px] text-[var(--text-muted)]">
          <summary className="cursor-pointer">{t('dashboard.whatIsCounted')}</summary>
          <p className="mt-1">{definition}</p>
        </details>
      ) : null}
    </div>
  )
}

/** A short day label, in the reader's own locale. */
function labelFor(day: string, language: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(language, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

function Volume({ data, language }: { data: DashboardData; language: string }) {
  const { t } = useTranslation()
  const peak = Math.max(1, ...data.days.map((day) => day.conversations))
  const total = data.days.reduce((sum, day) => sum + day.conversations, 0)

  /**
   * How many day labels the axis can carry.
   *
   * Thirty of them at 375px is about eleven pixels each, which truncates to nothing. Every
   * Nth instead, so the axis stays a timeline somebody can read rather than a row of
   * smudges.
   */
  const step = Math.ceil(data.days.length / 7)

  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('dashboard.volume')}</h2>
        {/* The tallest bar's value. It was only ever in a `title`, which a phone has no
            way to show and a screen reader does not announce. */}
        <span className="text-[11px] text-[var(--text-muted)]">
          {t('dashboard.peak')} {peak}
        </span>
      </div>
      {/*
        Bars and labels are separate rows on purpose. A percentage height resolves against
        the parent's height, and a column that also held its own label had no height of its
        own, so every bar rendered at zero.
      */}
      <div
        className="flex h-36 items-end gap-1"
        data-testid="volume-chart"
        role="img"
        aria-label={t('dashboard.volumeSummary', { total, peak, days: data.days.length })}
      >
        {data.days.map((day) => (
          <div
            key={day.day}
            className={cn(
              'min-w-0 flex-1 rounded-t',
              day.conversations > 0 ? 'bg-[var(--color-brand-600)]' : 'bg-[var(--surface-muted)]',
            )}
            // A quiet day still gets a sliver, so the axis reads as a timeline rather than
            // as missing data.
            style={{ height: `${Math.max(2, (day.conversations / peak) * 100)}%` }}
            title={`${labelFor(day.day, language)}: ${day.conversations}`}
          />
        ))}
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {data.days.map((day, index) => (
          <span
            key={day.day}
            className="min-w-0 flex-1 truncate text-center text-[10px] text-[var(--text-muted)]"
          >
            {index % step === 0 ? labelFor(day.day, language).split(' ')[0] : ''}
          </span>
        ))}
      </div>
      {/* The numbers themselves, for anybody who cannot hover a bar. */}
      <table className="sr-only">
        <caption>{t('dashboard.volume')}</caption>
        <tbody>
          {data.days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{labelFor(day.day, language)}</th>
              <td>{day.conversations}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export function Dashboard() {
  const { t, i18n } = useTranslation()
  const [days, setDays] = useState<number>(14)

  const dashboard = useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => api.dashboard.load(days),
    refetchInterval: 60_000,
  })

  if (dashboard.isPending) {
    return (
      <div className="p-6">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }
  if (!dashboard.data) return <ErrorNote message={t('common.error')} />

  const data = dashboard.data
  const handled = data.totals.answered + data.totals.handoffs
  const answeredShare = handled === 0 ? null : Math.round((data.totals.answered / handled) * 100)

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-12">
      <SetupChecklist answered={data.totals.answered} />

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t('dashboard.title')}</h1>
        <span className="text-[11px] text-[var(--text-muted)]" data-testid="dashboard-timezone">
          {t('dashboard.inTimezone', { timezone: data.timezone })}
        </span>
        <div className="ml-auto flex gap-1">
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`window-${option}`}
              onClick={() => setDays(option)}
              className={cn(
                'rounded-lg px-2.5 py-1 text-[13px]',
                option === days
                  ? 'bg-[var(--color-brand-600)] text-white'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]',
              )}
            >
              {option} {t('dashboard.days')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          testId="figure-conversations"
          label={t('dashboard.conversations')}
          value={String(data.totals.conversations)}
          hint={`${data.totals.customerMessages} ${t('dashboard.customerMessages')}`}
          definition={t('dashboard.definitions.conversations')}
        />
        <Figure
          testId="figure-answered"
          label={t('dashboard.answeredShare')}
          value={answeredShare === null ? '—' : `${answeredShare}%`}
          hint={`${data.totals.answered} / ${handled} ${t('dashboard.turns')}`}
          definition={t('dashboard.definitions.answered')}
        />
        {/*
          The wait for a person, not the wait for a reply.
          The AI answers in seconds, so the first-reply median reads "four seconds" on a
          week where three customers waited overnight for a colleague. That number is still
          here, underneath, where it is true and not misleading.
        */}
        <Figure
          testId="figure-handoff-wait"
          label={t('dashboard.handoffWait')}
          value={formatDuration(data.handoffWait.medianSeconds, t)}
          // Answered waits give the median; unanswered ones are said beside it, because they
          // are the longest waits of all and leaving them out flatters the number.
          hint={[
            data.handoffWait.events > 0
              ? `${data.handoffWait.events} ${t('dashboard.handoffs')}`
              : data.handoffWait.unanswered > 0
                ? t('dashboard.noneAnswered')
                : t('dashboard.noHandoffs'),
            data.handoffWait.unanswered > 0
              ? t('dashboard.stillUnanswered', { count: data.handoffWait.unanswered })
              : null,
            `${t('dashboard.firstResponse')} ${formatDuration(data.firstResponse.medianSeconds, t)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          definition={t('dashboard.definitions.handoffWait')}
        />
        <Figure
          testId="figure-cost"
          label={t('dashboard.cost')}
          // A gateway that reports no price contributes zero, so a total of zero means
          // "nothing is priced" far more often than it means "this was free".
          value={
            data.totals.cost > 0
              ? new Intl.NumberFormat(i18n.language, {
                  style: 'currency',
                  currency: 'USD',
                }).format(data.totals.cost)
              : t('dashboard.notPriced')
          }
          hint={`${data.totals.tokensIn + data.totals.tokensOut} ${t('dashboard.tokens')}`}
          definition={t('dashboard.definitions.cost')}
        />
      </div>

      {/* Both of these name something somebody should go and do, so both are the way to
          go and do it. They used to be text you had to act on by navigating yourself. */}
      {data.waitingNow > 0 ? (
        <Link to="/" search={{ tab: 'waiting' }} className="block">
          <Card className="border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-400 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <p className="text-sm" data-testid="waiting-now">
              {data.waitingNow} {t('dashboard.waitingNow')}
            </p>
          </Card>
        </Link>
      ) : null}

      {data.reviewQueueNow > 0 ? (
        <Link to="/" search={{ tab: 'review' }} className="block">
          <Card className="border-sky-300 bg-sky-50 text-sky-900 hover:border-sky-400 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
            <p className="text-sm" data-testid="review-queue-now">
              {data.reviewQueueNow} {t('dashboard.reviewQueueNow')}
            </p>
          </Card>
        </Link>
      ) : null}

      <Volume data={data} language={i18n.language} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold">{t('dashboard.handoffReasons')}</h2>
          {data.handoffReasons.length === 0 ? (
            <EmptyState title={t('dashboard.noHandoffs')} />
          ) : (
            <ul className="space-y-1 text-[13px]" data-testid="handoff-reasons">
              {data.handoffReasons.map((row) => (
                <li key={row.reason} className="flex justify-between gap-2">
                  {/* The key itself in the title: this list is what somebody takes to the
                      knowledge base, and the raw name is what the logs call it. */}
                  <span className="min-w-0 flex-1" title={row.reason}>
                    {t(`conversation.handoffReasons.${row.reason}`)}
                  </span>
                  <span className="tabular-nums">{row.conversations}</span>
                </li>
              ))}
            </ul>
          )}
          {data.handoffReasons.length > 0 ? (
            <p className="text-[11px] text-[var(--text-muted)]">{t('dashboard.handoffHint')}</p>
          ) : null}
        </Card>

        {/* The other half of "what to fix next": where the AI answered but answered badly. */}
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold">{t('dashboard.feedback')}</h2>
          <div className="flex gap-4 text-[13px]" data-testid="feedback-summary">
            <span className="flex items-center gap-1">
              <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {data.feedback.up}
              </span>
              <span className="text-[var(--text-muted)]">{t('dashboard.feedbackUp')}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">
                {data.feedback.down}
              </span>
              <span className="text-[var(--text-muted)]">{t('dashboard.feedbackDown')}</span>
            </span>
          </div>
          {data.feedback.up === 0 && data.feedback.down === 0 ? (
            <EmptyState title={t('dashboard.noFeedback')} />
          ) : data.feedback.reasons.length > 0 ? (
            <>
              <h3 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {t('dashboard.downReasons')}
              </h3>
              <ul className="space-y-1 text-[13px]" data-testid="feedback-reasons">
                {data.feedback.reasons.map((row) => (
                  <li key={row.reason} className="flex justify-between gap-2">
                    <span className="min-w-0 flex-1" title={row.reason}>
                      {t(`feedback.reasons.${row.reason}`)}
                    </span>
                    <span className="tabular-nums">{row.count}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {data.feedback.reasons.length > 0 ? (
            <p className="text-[11px] text-[var(--text-muted)]">{t('dashboard.feedbackHint')}</p>
          ) : null}
        </Card>

        <Card className="space-y-2">
          <h2 className="text-sm font-semibold">{t('dashboard.channels')}</h2>
          {data.channels.length === 0 ? (
            <EmptyState title={t('dashboard.noTraffic')} />
          ) : (
            <ul className="space-y-1 text-[13px]" data-testid="channel-breakdown">
              {data.channels.map((row) => (
                <li key={`${row.type}-${row.channel}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    {row.channel}{' '}
                    <span className="text-[11px] uppercase text-[var(--text-muted)]">
                      {t(`channels.${row.type}`)}
                    </span>
                  </span>
                  <span className="tabular-nums">{row.conversations}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
