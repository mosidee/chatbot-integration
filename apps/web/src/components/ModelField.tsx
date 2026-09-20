import { type QueryClient, useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { Input } from './ui'

/**
 * Choosing a model, once a provider is chosen.
 *
 * The model is offered as a list rather than typed from memory: a gateway can serve dozens
 * of ids and a single typo is only discovered when a customer message fails. The control is
 * still an input, not a select, for two reasons. Many OpenAI-compatible gateways do not
 * implement `/models` at all, so free text has to keep working; and a model saved earlier
 * may no longer appear in the list, which a select would render as an empty box that lies
 * about what is stored.
 *
 * One query per provider, shared by every field pointing at it. There are seven task slots
 * with a primary and a fallback each, so a query per field would mean fourteen calls into
 * the gateway every time settings open.
 */

const MODELS_KEY = 'provider-models'
const FIVE_MINUTES = 5 * 60 * 1000

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

function listElementId(providerId: string): string {
  return `provider-models-${providerId}`
}

/**
 * The options for one provider, rendered once per provider rather than once per field so
 * the same list is not duplicated fourteen times in the document.
 */
export function ProviderModelList({ providerId }: { providerId: string }) {
  const { data } = useProviderModels(providerId)
  return (
    <datalist id={listElementId(providerId)}>
      {(data?.models ?? []).map((model) => (
        <option key={model} value={model} />
      ))}
    </datalist>
  )
}

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

  // Picking from the list commits immediately; blur catches a model typed by hand. Both can
  // fire for one change, so the last committed value is remembered to avoid a second PUT.
  const committed = useRef(value ?? '')
  const commit = (next: string) => {
    if (next === committed.current) return
    committed.current = next
    onSave(next || null)
  }

  return (
    <Input
      className="h-8 flex-1 text-[13px]"
      list={providerId ? listElementId(providerId) : undefined}
      disabled={!providerId}
      data-testid={testId}
      placeholder={providerId ? t('settings.model') : t('settings.pickProviderFirst')}
      defaultValue={value ?? ''}
      onChange={(e) => {
        if (known.includes(e.target.value)) commit(e.target.value)
      }}
      onBlur={(e) => commit(e.target.value)}
    />
  )
}
