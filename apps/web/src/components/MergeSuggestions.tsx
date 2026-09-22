import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type MergeParty } from '../lib/api'
import { Button, ConfirmButton } from './ui'

/**
 * "These two might be the same person."
 *
 * Every channel identity gets its own customer record, because guessing when a stranger
 * first writes is how one person's history ends up in front of another. The cost is
 * duplicates, and this is where a human clears them up.
 *
 * Accepting is irreversible and moves someone's entire history, so it asks twice: the
 * first click arms the button, the second performs it. Rejecting is also permanent, in the
 * kinder direction — the pair is never raised again, so the panel cannot nag.
 */

function Party({ party, label }: { party: MergeParty | null; label: string }) {
  const { t } = useTranslation()
  if (!party) return null

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-1.5">
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="truncate text-[13px] font-medium">
        {party.displayName ?? party.identities[0]?.displayName ?? party.id.slice(0, 8)}
      </p>
      <p className="text-[11px] text-[var(--text-muted)]">
        {party.conversations} {t('merge.conversations')}
      </p>
      {party.identities.map((identity) => (
        <p
          key={identity.externalId}
          className="truncate font-mono text-[10px] text-[var(--text-muted)]"
        >
          {identity.externalId}
        </p>
      ))}
    </div>
  )
}

export function MergeSuggestions({
  customerId,
  canWrite,
  onMerged,
}: {
  customerId: string
  canWrite: boolean
  onMerged: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const suggestions = useQuery({
    queryKey: ['merge-suggestions', customerId],
    queryFn: () => api.customers.mergeSuggestions(customerId),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['merge-suggestions', customerId] })
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
  }

  const accept = useMutation({
    mutationFn: (suggestionId: string) => api.customers.acceptMerge(customerId, suggestionId),
    onSuccess: () => {
      invalidate()
      onMerged()
    },
  })

  const reject = useMutation({
    mutationFn: (suggestionId: string) => api.customers.rejectMerge(customerId, suggestionId),
    onSuccess: invalidate,
  })

  const rows = suggestions.data?.suggestions ?? []
  if (rows.length === 0) return null

  return (
    <section data-testid="merge-suggestions" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {t('merge.title')}
      </h3>

      {rows.map((suggestion) => (
        <div
          key={suggestion.id}
          data-testid="merge-suggestion"
          className="space-y-1.5 rounded-lg border border-sky-400/60 bg-sky-50 p-2 dark:bg-sky-950/30"
        >
          <p className="text-[12px] text-sky-900 dark:text-sky-200">
            {t('merge.matchedOn')} {t(`merge.keys.${suggestion.matchKey}`)}:{' '}
            <span className="font-mono" data-testid="merge-match-value">
              {suggestion.matchValue}
            </span>
          </p>

          <div className="grid gap-1.5 sm:grid-cols-2">
            <Party party={suggestion.survivor} label={t('merge.keeps')} />
            <Party party={suggestion.absorbed} label={t('merge.absorbs')} />
          </div>

          {canWrite ? (
            <div className="flex flex-wrap gap-1.5">
              {/* Arming expires here as it does everywhere else in the console: a red
                  "confirm" left standing for minutes is a trap for the next person to
                  pick up the laptop. */}
              <ConfirmButton
                testId="merge-accept"
                label={accept.isPending ? t('merge.merging') : t('merge.accept')}
                armedLabel={t('merge.confirm')}
                disabled={accept.isPending}
                onConfirm={() => accept.mutate(suggestion.id)}
              />
              <Button
                size="sm"
                variant="ghost"
                data-testid="merge-reject"
                disabled={reject.isPending}
                onClick={() => reject.mutate(suggestion.id)}
              >
                {t('merge.reject')}
              </Button>
            </div>
          ) : null}

          {/* Always stated plainly rather than only once the button is armed: somebody
              deciding whether these are the same person should read what it costs to be
              wrong before they reach for the control, not after. */}
          <p className="text-[11px] text-[var(--text-muted)]">{t('merge.hint')}</p>
        </div>
      ))}
    </section>
  )
}
