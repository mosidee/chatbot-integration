import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { disablePush, enablePush, type PushState, pushState, sendTestPush } from '../lib/push'
import { Button, Card, ErrorNote } from './ui'

/**
 * Notifications on this device (ADR 0010).
 *
 * Per person and per device, so it sits outside the workspace settings and their revision
 * machinery: turning it on here changes nothing anybody else sees.
 */
export function NotificationsCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState<string | null>(null)

  const config = useQuery({ queryKey: ['push-config'], queryFn: () => api.push.config() })
  const publicKey = config.data?.publicKey ?? null
  const state = useQuery({
    queryKey: ['push-state', publicKey],
    queryFn: () => pushState(publicKey),
    enabled: config.isSuccess,
  })

  // An installation without push keys offers nothing, rather than a switch that cannot work.
  if (config.isSuccess && !publicKey) return null

  const set = (next: PushState) => {
    queryClient.setQueryData(['push-state', publicKey], next)
  }

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setTested(null)
    try {
      await work()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const current = state.data

  return (
    <Card className="space-y-3" testId="notifications-card">
      <div>
        <h2 className="text-sm font-semibold">{t('push.title')}</h2>
        <p className="text-[13px] text-[var(--text-muted)]">{t('push.hint')}</p>
      </div>

      {current === 'needs-install' ? (
        <p className="text-sm" data-testid="push-needs-install">
          {t('push.needsInstall')}
        </p>
      ) : current === 'unsupported' ? (
        <p className="text-sm">{t('push.unsupported')}</p>
      ) : current === 'denied' ? (
        <p className="text-sm" data-testid="push-denied">
          {t('push.denied')}
        </p>
      ) : current === 'off' && publicKey ? (
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          data-testid="push-enable"
          // Straight from the click: Safari shows the permission prompt only to a gesture.
          onClick={() => void run(async () => set(await enablePush(publicKey)))}
        >
          {t('push.enable')}
        </Button>
      ) : current === 'on' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm" data-testid="push-on">
            {t('push.on')}
          </span>
          <Button
            size="sm"
            disabled={busy}
            data-testid="push-test"
            onClick={() =>
              void run(async () => {
                const result = await sendTestPush()
                setTested(t(`push.test.${result}`))
                if (result === 'gone' || result === 'not_subscribed') set('off')
              })
            }
          >
            {t('push.sendTest')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="push-disable"
            onClick={() =>
              void run(async () => {
                await disablePush()
                set('off')
              })
            }
          >
            {t('push.disable')}
          </Button>
        </div>
      ) : null}

      {tested ? (
        <p role="status" className="text-[13px] text-[var(--text-muted)]">
          {tested}
        </p>
      ) : null}
      {error || state.isError ? <ErrorNote message={error ?? t('push.checkFailed')} /> : null}
    </Card>
  )
}
