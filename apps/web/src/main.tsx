import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { api } from './lib/api'
import './lib/i18n'
import './styles.css'
import { Layout } from './components/Layout'
import { NotFound } from './components/NotFound'
import { Admin } from './routes/Admin'
import { Dashboard } from './routes/Dashboard'
import { INBOX_TABS, Inbox, type InboxTab } from './routes/Inbox'
import { Invite } from './routes/Invite'
import { Knowledge } from './routes/Knowledge'
import { Login } from './routes/Login'
import { Platform } from './routes/Platform'
import { SETTINGS_TABS, Settings, type SettingsTab } from './routes/Settings'
import { Simulator } from './routes/Simulator'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (failureCount, error) => {
        // Never retry an auth failure: it will not succeed and it delays the redirect.
        if (error instanceof Error && error.message.includes('Not signed in')) return false
        return failureCount < 2
      },
    },
  },
})

const rootRoute = createRootRoute({ component: () => <Outlet /> })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Login,
  // Somebody already signed in has no business on the sign-in page.
  beforeLoad: async () => {
    const session = await api.auth.session()
    if (session) throw redirect({ to: '/' })
  },
})

/**
 * Accepting an invitation, which is the one page that must work with no session.
 *
 * Deliberately a sibling of the sign-in page rather than a child of the app shell: the
 * person opening it may have no account at all yet, and the shell's guard would bounce them
 * to a sign-in form they cannot use.
 */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: function InviteRoute() {
    const { token } = inviteRoute.useParams()
    return <Invite token={token} />
  },
})

/**
 * Everything inside the console requires a session.
 *
 * Without this the shell rendered for anyone who opened the address: the navigation and an
 * empty inbox appeared, and every request behind it failed with 401. No data was exposed,
 * but it looked like being signed in, which is its own kind of wrong.
 */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: Layout,
  beforeLoad: async ({ location }) => {
    const session = await api.auth.session()
    if (!session) {
      throw redirect({
        to: '/login',
        search: location.pathname === '/' ? undefined : { next: location.pathname },
      })
    }
  },
})

/**
 * A bare workspace slug in the address bar opens that workspace.
 *
 * This is how a link to a tenant is shared: `/salon-saas` switches the session to it and
 * lands on the inbox. It is deliberately a redirect rather than a prefix on every route —
 * the workspace still comes from the session, so nothing else in the console has to learn
 * about the URL, and there is exactly one place that decides which tenant you are in.
 *
 * The lookup is over the caller's own memberships, which `/settings/me` already returns. A
 * slug they do not belong to is indistinguishable from one that does not exist, so this
 * cannot be used to discover which tenants are on the installation.
 *
 * Static routes outrank a parameter, so `/settings` is the settings page rather than a
 * tenant. That is also why those names are refused as slugs: see RESERVED_SLUGS.
 */
const workspaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/$slug',
  beforeLoad: async ({ params }) => {
    const me = await api.settings.me()
    const match = me.memberships.find((membership) => membership.slug === params.slug)

    // Not one of theirs: fall through and let the component explain.
    if (!match) return

    if (me.workspace?.id !== match.id) {
      await api.auth.setActiveWorkspace(match.id)
      // Everything held belongs to the workspace being left.
      queryClient.clear()
    }
    throw redirect({ to: '/' })
  },
  component: function UnknownWorkspace() {
    const { t } = useTranslation()
    return <NotFound title={t('notFound.noWorkspace')} hint={t('notFound.noWorkspaceHint')} />
  },
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  appRoute.addChildren([
    createRoute({
      getParentRoute: () => appRoute,
      path: '/',
      component: Inbox,
      // Which queue is showing, so the dashboard can link straight into one.
      validateSearch: (search: Record<string, unknown>): { tab: InboxTab } => ({
        tab: INBOX_TABS.includes(search.tab as InboxTab) ? (search.tab as InboxTab) : 'open',
      }),
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/dashboard', component: Dashboard }),
    createRoute({ getParentRoute: () => appRoute, path: '/knowledge', component: Knowledge }),
    createRoute({ getParentRoute: () => appRoute, path: '/simulator', component: Simulator }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/settings',
      component: Settings,
      /**
       * Which group of settings is open, in the address bar.
       *
       * So a link to "the model for each task" is a link somebody can send, and a reload
       * stays where they were rather than throwing them back to the top of a page they had
       * scrolled halfway down. An unknown value falls back rather than erroring: this comes
       * from a URL somebody may have typed.
       */
      validateSearch: (search: Record<string, unknown>): { tab: SettingsTab } => ({
        tab: SETTINGS_TABS.includes(search.tab as SettingsTab)
          ? (search.tab as SettingsTab)
          : 'general',
      }),
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/admin', component: Admin }),
    createRoute({ getParentRoute: () => appRoute, path: '/platform', component: Platform }),
    workspaceRoute,
  ]),
])

const router = createRouter({
  routeTree,
  // Anything with more segments than a slug, which the route above cannot catch. Wrapped
  // because the router passes its own props and this component takes overrides.
  defaultNotFoundComponent: () => <NotFound />,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
