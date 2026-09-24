import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { useCan } from '../lib/capabilities'
import { Card, cn } from './ui'

/**
 * What stands between a new workspace and its first answered customer.
 *
 * The pieces live on four pages — a provider and a model, a channel, knowledge, a test
 * message — and nothing said which were missing. Each step here is read from the real
 * configuration and links to the one place that fixes it. Knowledge is optional: an AI with
 * none still answers from its persona, so it is marked as such rather than as a blocker.
 * The card goes away once the essentials are done.
 */
export function SetupChecklist({ answered }: { answered: number }) {
  const { t } = useTranslation()
  const isAdmin = useCan('admin')

  const slots = useQuery({
    queryKey: ['task-slots'],
    queryFn: () => api.settings.taskSlots(),
    enabled: isAdmin,
  })
  const channels = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.settings.channels(),
    enabled: isAdmin,
  })
  const sources = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => api.knowledge.sources(),
    enabled: isAdmin,
  })

  if (!isAdmin || !slots.data || !channels.data) return null

  const answering = slots.data.slots.some(
    (slot) => slot.task === 'agent_chat' && slot.primaryProviderId && slot.primaryModel,
  )
  const connected = channels.data.channels.some(
    (channel) =>
      channel.enabled &&
      (channel.type === 'line' || channel.type === 'messenger'
        ? channel.hasConfig
        : channel.type === 'web'),
  )
  const knowledge = (sources.data?.sources ?? []).some((source) => source.status === 'ready')
  const tried = answered > 0

  const steps = [
    { key: 'model', done: answering, to: '/settings', search: { tab: 'models' } },
    { key: 'channel', done: connected, to: '/settings', search: { tab: 'channels' } },
    { key: 'knowledge', done: knowledge, optional: true, to: '/knowledge' },
    { key: 'tryIt', done: tried, to: '/simulator' },
  ] as const

  if (answering && connected && tried) return null

  return (
    <Card className="space-y-2" testId="setup-checklist">
      <h2 className="text-sm font-semibold">{t('setup.title')}</h2>
      <ol className="space-y-1.5">
        {steps.map((step) => (
          <li
            key={step.key}
            className="flex items-center gap-2 text-[13px]"
            data-testid={`setup-${step.key}`}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]',
                step.done
                  ? 'bg-emerald-500 text-white'
                  : 'border border-[var(--border)] text-[var(--text-muted)]',
              )}
            >
              {step.done ? '✓' : ''}
            </span>
            <span className={step.done ? 'text-[var(--text-muted)] line-through' : ''}>
              {t(`setup.steps.${step.key}`)}
              {'optional' in step && step.optional ? ` (${t('setup.optional')})` : ''}
            </span>
            <span className="sr-only">{step.done ? t('setup.done') : t('setup.todo')}</span>
            {step.done ? null : (
              <Link
                to={step.to}
                {...('search' in step ? { search: step.search } : {})}
                className="ml-auto text-[12px] font-medium text-[var(--color-brand-600)] underline underline-offset-2"
              >
                {t('setup.go')}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}
