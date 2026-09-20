import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, EmptyState, Input, Label, Spinner, Textarea } from '../components/ui'
import { api } from '../lib/api'

/**
 * Act as a customer without a platform account.
 *
 * Messages sent here take the same ingestion path a real LINE or Messenger webhook does,
 * so what is being tested is the real pipeline, not a shortcut.
 */
export function Simulator() {
  const { t } = useTranslation()
  const [externalId, setExternalId] = useState('sim-customer-1')
  const [displayName, setDisplayName] = useState('Nok')
  const [text, setText] = useState('')
  const [sentCount, setSentCount] = useState(0)

  const channels = useQuery({
    queryKey: ['simulator-channels'],
    queryFn: () => api.simulator.channels(),
  })

  const channelId = channels.data?.channels[0]?.id

  const send = useMutation({
    mutationFn: async (message: string) => {
      if (!channelId) throw new Error('no test channel')
      return api.simulator.send(channelId, {
        externalId,
        displayName,
        message: { kind: 'text', text: message },
      })
    },
    onSuccess: () => {
      setText('')
      setSentCount((n) => n + 1)
    },
  })

  if (channels.isLoading) {
    return (
      <div className="p-6">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  if (!channelId) return <EmptyState title={t('simulator.noChannel')} />

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="mb-1 text-lg font-semibold">{t('simulator.title')}</h1>
      <p className="mb-4 text-sm text-[var(--text-muted)]">{t('simulator.description')}</p>

      <Card className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="sim-name">{t('simulator.customerName')}</Label>
            <Input
              id="sim-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="sim-id">{t('simulator.customerId')}</Label>
            <Input id="sim-id" value={externalId} onChange={(e) => setExternalId(e.target.value)} />
          </div>
        </div>

        <div>
          <Textarea
            rows={3}
            value={text}
            placeholder={t('conversation.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault()
                send.mutate(text.trim())
              }
            }}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!text.trim() || send.isPending}
            onClick={() => send.mutate(text.trim())}
          >
            {t('simulator.send')}
          </Button>
          {sentCount > 0 ? (
            <span className="text-sm text-[var(--text-muted)]">{sentCount}</span>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
