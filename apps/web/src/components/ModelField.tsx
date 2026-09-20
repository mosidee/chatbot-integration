import type { QueryClient } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { Button, Input } from './ui'

/**
 * Choosing a model, once a provider is chosen.
 *
 * The model is offered as a list rather than typed from memory: a gateway can serve dozens
 * of ids and a single typo is only discovered when a customer message fails.
 *
 * It is a select, not an input backed by a datalist. A datalist filters its options by
 * whatever the field already contains, so a slot with a model saved offered only the
 * handful of ids resembling it and there was no way to see the rest. A select always shows
 * everything the provider serves.
 *
 * Free text still has to exist, for two reasons: many OpenAI-compatible gateways do not
 * implement `/models` at all, and a model saved earlier may have since been withdrawn. So
 * the list carries an entry that turns the control into a text box, and a value the
 * provider no longer lists is shown as its own entry rather than silently disappearing.
 *
 * One query per provider, shared by every field pointing at it. There are seven task slots
 * with a primary and a fallback each, so a query per field would mean fourteen calls into
 * the gateway every time settings open.
 */

const MODELS_KEY = 'provider-models'
const FIVE_MINUTES = 5 * 60 * 1000
/** Not a model id any provider would serve, so it cannot collide with a real choice. */
const TYPE_IT_IN = '\u0000custom'

export function useProviderModels(providerId: string | null) {
  return useQuery({
    queryKey: [MODELS_KEY, providerId],
    enabled: Boolean(providerId),
    staleTime: FIVE_MINUTES,
    retry: false,
    queryFn: () => api.settings.providerModels(providerId as string),
  })
}

/** Drop every cached list, so a provider that has just been given a key is asked again. */
export function refreshProviderModels(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [MODELS_KEY] })
}

/**
 * Gateways namespace their models: `ds/…`, `gemini/…`, `cc/…`. Grouping on that prefix
 * turns one run of forty entries into a handful of short, scannable lists.
 */
function groupByVendor(models: string[]): { vendor: string | null; models: string[] }[] {
  const groups: { vendor: string | null; models: string[] }[] = []
  for (const model of models) {
    const slash = model.indexOf('/')
    const vendor = slash > 0 ? model.slice(0, slash) : null
    const last = groups.find((g) => g.vendor === vendor)
    if (last) last.models.push(model)
    else groups.push({ vendor, models: [model] })
  }
  return groups
}

const CONTROL_CLASS =
  'h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[13px] disabled:opacity-50'

export function ModelField({
  providerId,
  value,
  onSave,
  testId,
}: {
  providerId: string | null
  value: string | null
  onSave: (model: string | null) => void
  testId: string
}) {
  const { t } = useTranslation()
  const models = useProviderModels(providerId)
  const known = models.data?.models ?? []
  const [typing, setTyping] = useState(false)

  const committed = useRef(value ?? '')
  const commit = (next: string) => {
    if (next === committed.current) return
    committed.current = next
    onSave(next || null)
  }

  // No provider, so there is nothing to choose from and nothing worth typing.
  if (!providerId) {
    return (
      <Input
        className="h-8 flex-1 text-[13px]"
        disabled
        data-testid={testId}
        placeholder={t('settings.pickProviderFirst')}
        value=""
        readOnly
      />
    )
  }

  // Either the provider serves no list, or the operator asked to type an id by hand.
  if (typing || (!models.isPending && known.length === 0)) {
    return (
      <div className="flex min-w-0 flex-1 gap-1">
        <Input
          className="h-8 min-w-0 flex-1 text-[13px]"
          data-testid={testId}
          placeholder={t('settings.model')}
          defaultValue={value ?? ''}
          autoFocus={typing}
          onBlur={(e) => commit(e.target.value)}
        />
        {known.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="px-1.5"
            data-testid={`${testId}-back-to-list`}
            onClick={() => setTyping(false)}
          >
            {t('settings.backToList')}
          </Button>
        ) : null}
      </div>
    )
  }

  const unlisted = value && !known.includes(value) ? value : null

  return (
    <select
      className={CONTROL_CLASS}
      data-testid={testId}
      disabled={models.isPending}
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === TYPE_IT_IN) setTyping(true)
        else commit(e.target.value)
      }}
    >
      <option value="">
        {models.isPending ? t('settings.loadingModels') : t('settings.none')}
      </option>
      {unlisted ? (
        <option value={unlisted}>
          {unlisted} ({t('settings.unlisted')})
        </option>
      ) : null}
      {groupByVendor(known).map((group) =>
        group.vendor === null ? (
          group.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))
        ) : (
          <optgroup key={group.vendor} label={group.vendor}>
            {group.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </optgroup>
        ),
      )}
      <option value={TYPE_IT_IN}>{t('settings.typeModelIn')}</option>
    </select>
  )
}
