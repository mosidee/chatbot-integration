import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { setLanguage } from '../lib/i18n'
import { Button, cn } from './ui'

/**
 * The application shell.
 *
 * Navigation sits in a bottom bar on phones and a top bar on wider screens, because agents
 * reply from their phones and a bottom bar is reachable one-handed.
 */
export function Layout() {
  const { t, i18n } = useTranslation()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const items = [
    { to: '/', label: t('nav.inbox') },
    { to: '/simulator', label: t('nav.simulator') },
    { to: '/settings', label: t('nav.settings') },
  ]

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-4">
        <span className="font-semibold tracking-tight">{t('app.name')}</span>

        <nav className="hidden gap-1 sm:flex">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm transition-colors',
                isActive(item.to)
                  ? 'bg-[var(--surface-muted)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-[var(--border)] p-0.5">
            {(['th', 'en'] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLanguage(code)}
                className={cn(
                  'rounded px-2 py-0.5 text-xs font-medium uppercase transition-colors',
                  i18n.language === code
                    ? 'bg-[var(--surface-muted)] text-[var(--text)]'
                    : 'text-[var(--text-muted)]',
                )}
              >
                {code}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.auth.signOut()
              location.href = '/login'
            }}
          >
            {t('app.signOut')}
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Outlet />
      </main>

      <nav className="flex shrink-0 border-t border-[var(--border)] bg-[var(--surface)] sm:hidden">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              'flex-1 py-3 text-center text-xs font-medium transition-colors',
              isActive(item.to) ? 'text-[var(--color-brand-600)]' : 'text-[var(--text-muted)]',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
