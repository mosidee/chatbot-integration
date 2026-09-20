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
      location.href = '/'
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('auth.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-4 text-lg font-semibold">{t('auth.title')}</h1>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <ErrorNote message={error} /> : null}
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {t('auth.signIn')}
          </Button>
        </form>
      </Card>
    </div>
  )
}
