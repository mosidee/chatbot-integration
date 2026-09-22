import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, ErrorNote, Input, Label } from '../components/ui'
import { ApiError, api } from '../lib/api'

export function Login() {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.auth.signIn(email, password)
      // Return to whatever was being asked for before the guard intervened.
      const next = new URLSearchParams(location.search).get('next')
      location.href = next?.startsWith('/') && !next.startsWith('//') ? next : '/'
    } catch (caught) {
      /**
       * A refusal and an unreachable server are different problems.
       *
       * Both used to read "Sign in failed", which sent people hunting for a password that
       * was fine while the API was down.
       */
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof TypeError
            ? t('auth.unreachable')
            : t('auth.failed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <div className="mb-4">
          <p className="text-sm text-[var(--text-muted)]">{t('app.name')}</p>
          <h1 className="text-lg font-semibold">{t('auth.title')}</h1>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input
              id="email"
              data-testid="login-email"
              type="email"
              autoComplete="username"
              // The only field on the page, and somebody signing in is here to type in it.
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input
              id="password"
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <ErrorNote message={error} /> : null}
          <Button
            type="submit"
            data-testid="login-submit"
            variant="primary"
            className="w-full"
            disabled={busy}
          >
            {t('auth.signIn')}
          </Button>
          {/* There is no self-service reset: a link is issued by an admin. Saying so beats
              leaving somebody looking for a "forgot password" that will never be there. */}
          <p className="text-center text-[12px] text-[var(--text-muted)]">{t('auth.forgotHint')}</p>
        </form>
      </Card>
    </div>
  )
}
