import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { Button, ErrorNote } from './ui'

/**
 * Erasing a customer at their request, which Thailand's PDPA gives them a right to.
 *
 * Offered beside the conversation an agent is reading, because that is where the request
 * arrives, rather than in a settings screen nobody opens while a customer is waiting.
 *
 * A separate step names who is about to be erased and what goes with them, with its own
 * Confirm and Cancel and no timer. It used to be a second click on the same button, which a
 * reflexive double-click satisfied, and a five-second window that a careful reader missed.
 */
export function EraseCustomer({
  conversationId,
  customerName,
  onErased,
}: {
  conversationId: string
  customerName: string
  onErased: () => void
}) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)

  // Hidden from anyone who could not use it. The route checks the role itself; this is a
  // courtesy, not the guard.
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 300_000 })

  const erase = useMutation({
    mutationFn: () => api.conversations.eraseCustomer(conversationId),
    onSuccess: () => {
      setConfirming(false)
      onErased()
    },
  })

  if (me.data?.role !== 'admin') return null

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-2">
      {confirming ? (
        <div
          className="space-y-2 rounded-lg border border-red-300 p-2 dark:border-red-900"
          data-testid="erase-customer-panel"
        >
          <p className="text-[13px] font-medium">{t('sidebar.eraseWho', { name: customerName })}</p>
          <p className="text-[12px] text-[var(--text-muted)]">{t('sidebar.eraseHint')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              data-testid="erase-customer-confirm"
              disabled={erase.isPending}
              onClick={() => erase.mutate()}
            >
              {erase.isPending ? t('sidebar.erasing') : t('sidebar.eraseConfirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="w-full"
          data-testid="erase-customer"
          disabled={erase.isSuccess}
          onClick={() => setConfirming(true)}
        >
          {t('sidebar.erase')}
        </Button>
      )}
      {erase.isError ? (
        <div className="mt-1">
          <ErrorNote
            message={`${t('common.error')}: ${erase.error instanceof Error ? erase.error.message : ''}`}
          />
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-[var(--text-muted)]" role="status">
          {/* Requested, not done: the worker deletes rows and stored files after this. */}
          {erase.isSuccess ? t('sidebar.eraseQueued') : confirming ? '' : t('sidebar.eraseHint')}
        </p>
      )}
    </div>
  )
}
