import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api, type Me } from '../lib/api'
import { setLanguage } from '../lib/i18n'
import { Button, Card, cn } from './ui'

/**
 * The application shell.
 *
 * Navigation sits in a bottom bar on phones and a top bar on wider screens, because agents
 * reply from their phones and a bottom bar is reachable one-handed.
 *
 * What is offered depends on who is looking: an agent has no reason to see the page that
 * changes roles, and almost nobody sees the page that deletes tenants. Hiding either is a
 * courtesy rather than the guard — every route behind them checks for itself — but showing
 * somebody a control that will refuse them is its own kind of rude.
 */
export function Layout() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 60_000 })

  const items = [
    { to: '/', label: t('nav.inbox') },
    { to: '/dashboard', label: t('nav.dashboard') },
    { to: '/knowledge', label: t('nav.knowledge') },
    { to: '/simulator', label: t('nav.simulator') },
    { to: '/settings', label: t('nav.settings') },
    ...(me.data?.role === 'admin' ? [{ to: '/admin', label: t('nav.admin') }] : []),
    ...(me.data?.platformAdmin ? [{ to: '/platform', label: t('nav.platform') }] : []),
  ]

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

  /**
   * A workspace that cannot be worked in replaces the page rather than letting every panel
   * inside it fail one 403 at a time.
   *
   * The platform page is the exception: somebody whose own workspace is suspended may still
   * be the person who has to go and un-suspend it.
   */
  const locked = me.data && me.data.workspace?.status !== 'active'
  const showLock = locked && !pathname.startsWith('/platform')

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
          <WorkspaceSwitcher me={me.data} />

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
              queryClient.clear()
              location.href = '/login'
            }}
          >
            {t('app.signOut')}
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {showLock && me.data ? <WorkspaceLocked me={me.data} /> : <Outlet />}
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

/**
 * Only shown to somebody who belongs to more than one workspace, which until this milestone
 * nobody did. Switching writes the session's active organization, so the choice survives a
 * reload and every request afterwards is about the workspace they picked.
 */
function WorkspaceSwitcher({ me }: { me: Me | undefined }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  if (!me || me.memberships.length < 2) return null

  return (
    <select
      data-testid="workspace-switcher"
      aria-label={t('workspace.switch')}
      value={me.workspace?.id ?? ''}
      onChange={async (event) => {
        await api.auth.setActiveWorkspace(event.target.value)
        // A full reload rather than a refetch: every cached list on screen belongs to the
        // workspace they are leaving.
        queryClient.clear()
        location.href = '/'
      }}
      className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[13px] text-[var(--text)]"
    >
      {me.memberships.map((membership) => (
        <option key={membership.id} value={membership.id}>
          {membership.name}
          {membership.status === 'active'
            ? ''
            : ` (${t(`platform.statuses.${membership.status}`)})`}
        </option>
      ))}
    </select>
  )
}

/** What somebody sees when their workspace is suspended, being deleted, or was never there. */
function WorkspaceLocked({ me }: { me: Me }) {
  const { t } = useTranslation()

  const [title, hint] = !me.workspace
    ? [t('workspace.none'), t('workspace.noneHint')]
    : me.workspace.status === 'suspended'
      ? [t('workspace.suspended'), t('workspace.suspendedHint')]
      : [t('workspace.deleting'), t('workspace.deletingHint')]

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-md space-y-3 text-center" testId="workspace-locked">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="text-sm text-[var(--text-muted)]">{hint}</p>
        {me.workspace ? (
          <p className="text-[13px] text-[var(--text-muted)]">{me.workspace.name}</p>
        ) : null}
        {me.platformAdmin ? (
          <Link to="/platform" className="inline-block text-sm text-[var(--color-brand-600)]">
            {t('nav.platform')}
          </Link>
        ) : null}
      </Card>
    </div>
  )
}
