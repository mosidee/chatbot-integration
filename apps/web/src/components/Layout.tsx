import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Me } from '../lib/api'
import { can } from '../lib/capabilities'
import { setLanguage } from '../lib/i18n'
import { RealtimeProvider, useRealtimeStatus } from '../lib/ws'
import { Button, Card, cn, Dialog } from './ui'

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

  /**
   * The badges on the Inbox: how many conversations are open, and how many are waiting for
   * a person.
   *
   * Shown on every page, because the agent who most needs to know a customer is sitting in
   * the inbox is the one looking at Settings or the dashboard. Polled here; the inbox also
   * refreshes them the moment its own socket hears about a change.
   */
  const counts = useQuery({
    queryKey: ['inbox-counts'],
    queryFn: () => api.conversations.counts(),
    refetchInterval: 20_000,
  })

  const items: NavItem[] = [
    {
      to: '/',
      label: t('nav.inbox'),
      badges: [
        {
          count: counts.data?.open ?? 0,
          tone: 'open',
          label: t('nav.openCount', { count: counts.data?.open ?? 0 }),
          testId: 'nav-inbox-badge',
        },
        {
          count: counts.data?.waiting ?? 0,
          tone: 'waiting',
          label: t('nav.waitingCount', { count: counts.data?.waiting ?? 0 }),
          testId: 'nav-inbox-waiting-badge',
        },
      ],
    },
    { to: '/dashboard', label: t('nav.dashboard') },
    { to: '/knowledge', label: t('nav.knowledge') },
    // The simulator sends as a customer, which a viewer's role does not allow.
    ...(can(me.data, 'simulate') ? [{ to: '/simulator', label: t('nav.simulator') }] : []),
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
    <RealtimeProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-4">
          <span className="font-semibold tracking-tight">{t('app.name')}</span>

          {/* From md: seven destinations and the controls beside them do not fit at 640px. */}
          <nav className="hidden gap-1 md:flex">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                  isActive(item.to)
                    ? 'bg-[var(--surface-muted)] font-medium text-[var(--text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]',
                )}
              >
                {item.label}
                <NavBadges badges={item.badges} />
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ConnectionStatus />
            <WorkspaceSwitcher me={me.data} />

            <div className="flex rounded-lg border border-[var(--border)] p-0.5">
              {(['th', 'en'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={i18n.language === code}
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

        <BottomNav items={items} isActive={isActive} />
      </div>
    </RealtimeProvider>
  )
}

/**
 * Whether the live feed is up. Nothing is shown while it is: a green dot on every page is
 * noise. When it drops, an agent is told the page may be behind, rather than trusting a
 * thread that stopped updating.
 */
function ConnectionStatus() {
  const { t } = useTranslation()
  const status = useRealtimeStatus()
  if (status === 'open' || status === 'connecting') return null
  return (
    <span
      role="status"
      data-testid="connection-status"
      className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {status === 'reconnecting' ? t('app.reconnecting') : t('app.disconnected')}
    </span>
  )
}

/**
 * A count beside a navigation item.
 *
 * Blue for open, red for waiting on a person. The colours carry the difference in urgency:
 * an open conversation the AI is answering needs nobody, a waiting one needs somebody now,
 * and two numbers in the same colour would make an agent read both to find out which.
 */
type NavBadgeSpec = {
  count: number
  tone: 'open' | 'waiting'
  /** What a screen reader hears, since a bare digit after "Inbox" says nothing. */
  label: string
  testId: string
}

/** A destination in the navigation, with counts of what is waiting there. */
type NavItem = { to: string; label: string; badges?: NavBadgeSpec[] }

const BADGE_TONES: Record<NavBadgeSpec['tone'], string> = {
  open: 'bg-[var(--color-brand-600)]',
  waiting: 'bg-red-600',
}

/** Nothing at all for a count of zero, so a badge means something when it appears. */
function NavBadges({ badges }: { badges: NavBadgeSpec[] | undefined }) {
  const shown = (badges ?? []).filter((badge) => badge.count > 0)
  if (shown.length === 0) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {shown.map((badge) => (
        <span key={badge.testId} className="inline-flex">
          <span
            data-testid={badge.testId}
            aria-hidden="true"
            className={cn(
              'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-none text-white tabular-nums',
              BADGE_TONES[badge.tone],
            )}
          >
            {badge.count > 99 ? '99+' : badge.count}
          </span>
          <span className="sr-only">{badge.label}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * Navigation on a phone.
 *
 * Every destination used to get an equal share of the bar. An admin who is also a platform
 * admin has seven, which at 390px left each one about 55 pixels: the labels were clipped,
 * and the first — the inbox, the reason anybody opens this — ran off the left edge.
 *
 * Four fit comfortably, so four are shown and the rest go behind "More". A workspace where
 * somebody has fewer destinations than that never sees the extra control at all.
 */
const BOTTOM_NAV_SLOTS = 4

function BottomNav({ items, isActive }: { items: NavItem[]; isActive: (to: string) => boolean }) {
  const { t } = useTranslation()
  const [showMore, setShowMore] = useState(false)

  const needsMore = items.length > BOTTOM_NAV_SLOTS + 1
  const shown = needsMore ? items.slice(0, BOTTOM_NAV_SLOTS) : items
  const hidden = needsMore ? items.slice(BOTTOM_NAV_SLOTS) : []
  const hiddenIsActive = hidden.some((item) => isActive(item.to))

  return (
    <>
      {showMore ? (
        // A dialog: focus moves into the sheet, Escape closes it, and the page behind is
        // inert until it does.
        <Dialog label={t('nav.more')} onClose={() => setShowMore(false)} className="md:hidden">
          {/* A real button rather than a div that listens for clicks: it is dismissible by
              keyboard and announced as something you can press. */}
          <button
            type="button"
            className="absolute inset-0 h-full w-full bg-black/40"
            aria-label={t('common.close')}
            onClick={() => setShowMore(false)}
          />
          <nav
            className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-[var(--border)] bg-[var(--surface)] p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
            data-testid="nav-more-sheet"
          >
            {hidden.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setShowMore(false)}
                className={cn(
                  'block rounded-lg px-3 py-3 text-sm font-medium',
                  isActive(item.to)
                    ? 'bg-[var(--surface-muted)] text-[var(--color-brand-600)]'
                    : 'text-[var(--text)]',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </Dialog>
      ) : null}

      <nav className="flex shrink-0 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden">
        {shown.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1 px-1 py-3 text-xs font-medium transition-colors',
              isActive(item.to) ? 'text-[var(--color-brand-600)]' : 'text-[var(--text-muted)]',
            )}
          >
            {/* The label truncates and the badge does not: a clipped count is worse than a
                clipped word, because the word is already known and the count is the news. */}
            <span className="min-w-0 truncate">{item.label}</span>
            <NavBadges badges={item.badges} />
          </Link>
        ))}
        {needsMore ? (
          <button
            type="button"
            data-testid="nav-more"
            aria-expanded={showMore}
            onClick={() => setShowMore((open) => !open)}
            className={cn(
              'min-w-0 flex-1 truncate px-1 py-3 text-center text-xs font-medium transition-colors',
              hiddenIsActive ? 'text-[var(--color-brand-600)]' : 'text-[var(--text-muted)]',
            )}
          >
            {t('nav.more')}
          </button>
        ) : null}
      </nav>
    </>
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
