import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Card } from './ui'

/**
 * What a mistyped address looks like.
 *
 * Without this the router shows two bare words and no way back, which is the worst version
 * of being lost: it reads like the application has broken rather than like the address was
 * wrong. Every case here offers the inbox, because that is where somebody wanted to be.
 */
export function NotFound({ title, hint }: { title?: string; hint?: string }) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-md space-y-3 text-center" testId="not-found">
        <h1 className="text-base font-semibold">{title ?? t('notFound.title')}</h1>
        <p className="text-sm text-[var(--text-muted)]">{hint ?? t('notFound.hint')}</p>
        <Link to="/" className="inline-block text-sm text-[var(--color-brand-600)]">
          {t('notFound.backToInbox')}
        </Link>
      </Card>
    </div>
  )
}
