import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, EmptyState, Input, Label, Spinner } from '../components/ui'
import { ApiError, api } from '../lib/api'

/**
 * The page an invitation link opens.
 *
 * Public, and the only page in the console that is: somebody joining for the first time has
 * no account yet, so there is nothing to sign them in with. The token in the URL is what
 * stands in, and the server reads it without spending it, so a refresh or a mail client
 * prefetching the address does not burn the invitation.
 *
 * Three shapes, decided by the server rather than guessed here: choose a password and join,
 * sign in first because the address already has an account, or set a new password.
 */
export function Invite({ token }: { token: string }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.invitations.get(token),
    retry: false,
  })

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.auth.session() })

  if (invitation.isLoading || session.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  if (invitation.isError || !invitation.data) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-md" testId="invite-invalid">
          <EmptyState title={t('invite.invalid')} hint={t('invite.invalidHint')} />
        </Card>
      </div>
    )
  }

  const info = invitation.data
  const isReset = info.purpose === 'password_reset'
  /** What still has to be filled in before this can be submitted. */
  const blocked =
    (isReset && password.length < 8) ||
    (!isReset && !info.existingAccount && (!name.trim() || password.length < 8))
  const signedInAs = session.data?.user.email?.toLowerCase() ?? null
  const needsSignIn = !isReset && info.existingAccount && signedInAs !== info.email

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.invitations.accept(token, {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(password ? { password } : {}),
      })
      // The response carries a session cookie, so the console is already theirs to open.
      // A full navigation rather than a router push: everything cached belongs to nobody.
      await api.auth.setActiveWorkspace(result.workspaceId).catch(() => {})
      location.href = '/'
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm space-y-3" testId="invite-card">
        <div>
          <h1 className="text-base font-semibold">
            {isReset ? t('invite.resetTitle') : t('invite.joinTitle')}
          </h1>
          <p className="text-sm text-[var(--text-muted)]">{info.workspaceName}</p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
            {t('invite.issuedTo')} {info.email}
          </p>
        </div>

        {needsSignIn ? (
          <>
            <p className="text-sm text-[var(--text-muted)]">{t('invite.signInFirst')}</p>
            <Button
              variant="primary"
              className="w-full"
              data-testid="invite-signin"
              onClick={() => {
                location.href = `/login?next=${encodeURIComponent(`/invite/${token}`)}`
              }}
            >
              {t('invite.signIn')}
            </Button>
          </>
        ) : (
          // A form, so Enter submits. Without one the keyboard did nothing and the only
          // way through was to reach for the mouse.
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!blocked) accept()
            }}
          >
            {/* An account that already exists needs neither: they are signed in as the
                address on the invitation, so joining is one button. */}
            {!isReset && !info.existingAccount ? (
              <div>
                <Label htmlFor="invite-name">{t('invite.name')}</Label>
                <Input
                  id="invite-name"
                  data-testid="invite-name"
                  autoComplete="name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            ) : null}

            {isReset || !info.existingAccount ? (
              <div>
                <Label htmlFor="invite-password">{t('invite.password')}</Label>
                <Input
                  id="invite-password"
                  data-testid="invite-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                  {t('invite.passwordHint')}
                </p>
              </div>
            ) : null}

            {error ? (
              <p className="text-sm text-red-700 dark:text-red-300" data-testid="invite-error">
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              data-testid="invite-submit"
              disabled={busy || blocked}
            >
              {isReset
                ? t('common.save')
                : info.existingAccount
                  ? t('invite.join')
                  : t('invite.accept')}
            </Button>
            {/* Why the button is grey, rather than leaving somebody to guess. */}
            {blocked ? (
              <p className="text-center text-[12px] text-[var(--text-muted)]">
                {!isReset && !info.existingAccount && !name.trim()
                  ? t('invite.needName')
                  : t('invite.passwordHint')}
              </p>
            ) : null}
          </form>
        )}
      </Card>
    </div>
  )
}
