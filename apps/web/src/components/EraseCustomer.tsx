import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * Erasing a customer at their request, which Thailand's PDPA gives them a right to.
 *
 * Offered beside the conversation an agent is reading, because that is where the request
 * arrives, rather than in a settings screen nobody opens while a customer is waiting.
 *
 * Confirmation is a second click on the same button rather than a browser dialog. A native
 * confirm blocks the page, cannot be styled or translated, and is the one thing a person
 * dismisses by reflex. The armed state also expires on its own, so a button left armed by
 * accident does not stay dangerous.
 */

const ARMED_FOR_MS = 5000

export function EraseCustomer({
  conversationId,
  onErased,
}: {
  conversationId: string
  onErased: () => void
}) {
  const { t } = useTranslation()
  const [armed, setArmed] = useState(false)

  // Hidden from anyone who could not use it. The route checks the role itself; this is a
  // courtesy, not the guard.
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 300_000 })

  const erase = useMutation({
    mutationFn: () => api.conversations.eraseCustomer(conversationId),
    onSuccess: () => {
      setArmed(false)
      onErased()
    },
  })

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), ARMED_FOR_MS)
    return () => clearTimeout(timer)
  }, [armed])

  if (me.data?.role !== 'admin') return null

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-2">
      <Button
        size="sm"
        variant={armed ? 'danger' : 'ghost'}
        className="w-full"
        data-testid="erase-customer"
        disabled={erase.isPending}
        onClick={() => (armed ? erase.mutate() : setArmed(true))}
      >
        {erase.isPending
          ? t('sidebar.erasing')
          : armed
            ? t('sidebar.eraseConfirm')
            : t('sidebar.erase')}
      </Button>
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
        {erase.isError
          ? t('common.error')
          : erase.isSuccess
            ? t('sidebar.eraseQueued')
            : t('sidebar.eraseHint')}
      </p>
    </div>
  )
}
