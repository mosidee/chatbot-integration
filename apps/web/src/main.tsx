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
import { api } from './lib/api'
import './lib/i18n'
import './styles.css'
import { Layout } from './components/Layout'
import { Inbox } from './routes/Inbox'
import { Knowledge } from './routes/Knowledge'
import { Login } from './routes/Login'
import { Settings } from './routes/Settings'
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

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    createRoute({ getParentRoute: () => appRoute, path: '/', component: Inbox }),
    createRoute({ getParentRoute: () => appRoute, path: '/knowledge', component: Knowledge }),
    createRoute({ getParentRoute: () => appRoute, path: '/simulator', component: Simulator }),
    createRoute({ getParentRoute: () => appRoute, path: '/settings', component: Settings }),
  ]),
])

const router = createRouter({ routeTree })

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
