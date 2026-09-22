import type { UserRoleName } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, ConfirmButton, CopyOnce, Input, Spinner } from '../components/ui'
import { ApiError, api, type Member, type PendingInvitation } from '../lib/api'

/**
 * Who is in this workspace, and what they may do.
 *
 * Admin-only, and the server says so too: hiding the page is a courtesy. Nothing here
 * deletes an account — removing somebody takes away their membership of this workspace and
 * no more, because they may belong to other tenants and their name is attached to messages
 * they have already sent.
 */
export function Admin() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  /** A link is shown once and cannot be read back, so it lives here until the page moves on. */
  const [freshLink, setFreshLink] = useState<{ link: string; for: string } | null>(null)

  const people = useQuery({ queryKey: ['members'], queryFn: () => api.admin.members() })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] })

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught))

  if (people.isLoading) {
    return (
      <div className="p-4">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-12">
      <div>
        <h1 className="text-sm font-semibold">{t('admin.title')}</h1>
        <p className="text-[13px] text-[var(--text-muted)]">{t('admin.hint')}</p>
      </div>

      {error ? (
        <Card className="border-red-300 text-sm text-red-800 dark:border-red-900 dark:text-red-200">
          {error}
        </Card>
      ) : null}

      {freshLink ? (
        <CopyOnce
          value={freshLink.link}
          hint={`${t('admin.linkOnce')} — ${freshLink.for}`}
          copyLabel={t('admin.copy')}
          copiedLabel={t('admin.copied')}
          testId="fresh-link"
        />
      ) : null}

      <MembersCard
        members={people.data?.members ?? []}
        onChanged={refresh}
        onError={fail}
        onLink={(link, forWhom) => {
          setError(null)
          setFreshLink({ link, for: forWhom })
        }}
      />

      <InvitationsCard
        invitations={people.data?.invitations ?? []}
        onChanged={refresh}
        onError={fail}
        onLink={(link, forWhom) => {
          setError(null)
          setFreshLink({ link, for: forWhom })
        }}
      />
    </div>
  )
}

const ROLES: UserRoleName[] = ['admin', 'agent', 'viewer']

function MembersCard({
  members,
  onChanged,
  onError,
  onLink,
}: {
  members: Member[]
  onChanged: () => void
  onError: (error: unknown) => void
  onLink: (link: string, forWhom: string) => void
}) {
  const { t } = useTranslation()

  /** The role somebody has asked to give themselves, while they confirm it. */
  const [demoting, setDemoting] = useState<UserRoleName | null>(null)

  const update = useMutation({
    mutationFn: (input: { userId: string; role: UserRoleName }) =>
      api.admin.updateMember(input.userId, { role: input.role }),
    onSuccess: onChanged,
    onError,
  })

  const remove = useMutation({
    mutationFn: (userId: string) => api.admin.removeMember(userId),
    onSuccess: onChanged,
    onError,
  })

  const resetLink = useMutation({
    mutationFn: (member: Member) =>
      api.admin.resetLink(member.userId).then((result) => ({ result, member })),
    onSuccess: ({ result, member }) => onLink(result.link, member.email),
    onError,
  })

  return (
    <Card className="space-y-3" testId="members-card">
      <h2 className="text-sm font-semibold">{t('admin.members')}</h2>

      {members.map((member) => (
        <div
          key={member.userId}
          data-testid={`member-row-${member.email}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">
              {member.name}
              {member.isSelf ? (
                <span className="ml-1.5 text-[12px] text-[var(--text-muted)]">
                  ({t('admin.self')})
                </span>
              ) : null}
            </p>
            <p className="truncate text-[12px] text-[var(--text-muted)]">{member.email}</p>
          </div>

          <select
            data-testid={`member-role-${member.email}`}
            disabled={demoting !== null}
            value={member.role}
            onChange={(event) => {
              const role = event.target.value as UserRoleName
              /**
               * Lowering your own role takes effect at once and cannot be undone by you:
               * the page that would change it back is the one you just lost access to.
               *
               * Asked inline rather than with a browser `confirm`, for the reasons set out
               * on `ConfirmButton`: a native dialog blocks the page and is the one thing
               * people dismiss by reflex.
               */
              if (member.isSelf && role !== 'admin') {
                setDemoting(role)
                event.target.value = member.role
                return
              }
              update.mutate({ userId: member.userId, role })
            }}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[13px]"
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`admin.roles.${role}`)}
              </option>
            ))}
          </select>

          <Button
            size="sm"
            variant="ghost"
            data-testid={`member-reset-${member.email}`}
            onClick={() => resetLink.mutate(member)}
          >
            {t('admin.resetLink')}
          </Button>

          <ConfirmButton
            label={t('admin.remove')}
            armedLabel={t('admin.removeConfirm')}
            testId={`member-remove-${member.email}`}
            onConfirm={() => remove.mutate(member.userId)}
          />

          {demoting && member.isSelf ? (
            <div className="w-full space-y-2 rounded-lg border border-amber-400 bg-amber-50 p-2 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p>{t('admin.demoteSelfConfirm')}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  data-testid="demote-self-confirm"
                  onClick={() => {
                    update.mutate({ userId: member.userId, role: demoting })
                    setDemoting(null)
                  }}
                >
                  {t('common.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDemoting(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </Card>
  )
}

function InvitationsCard({
  invitations,
  onChanged,
  onError,
  onLink,
}: {
  invitations: PendingInvitation[]
  onChanged: () => void
  onError: (error: unknown) => void
  onLink: (link: string, forWhom: string) => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRoleName>('agent')

  const invite = useMutation({
    mutationFn: () => api.admin.createInvitation({ email: email.trim(), role }),
    onSuccess: (result) => {
      onLink(result.link, email.trim())
      setEmail('')
      onChanged()
    },
    onError,
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.admin.revokeInvitation(id),
    onSuccess: onChanged,
    onError,
  })

  return (
    <Card className="space-y-3" testId="invitations-card">
      <h2 className="text-sm font-semibold">{t('admin.invitations')}</h2>
      <p className="text-[13px] text-[var(--text-muted)]">{t('admin.inviteHint')}</p>

      {invitations.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)]">{t('admin.noInvitations')}</p>
      ) : (
        invitations.map((invitation) => (
          <div
            key={invitation.id}
            data-testid={`invitation-row-${invitation.email}`}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">{invitation.email}</span>
            <span className="text-[12px] text-[var(--text-muted)]">
              {invitation.role ? t(`admin.roles.${invitation.role}`) : ''}
            </span>
            <span className="text-[12px] text-[var(--text-muted)]">
              {t('admin.expires')} {new Date(invitation.expiresAt).toLocaleDateString()}
            </span>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`invitation-revoke-${invitation.email}`}
              onClick={() => revoke.mutate(invitation.id)}
            >
              {t('admin.revoke')}
            </Button>
          </div>
        ))
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
        <Input
          data-testid="invite-email"
          type="email"
          placeholder={t('admin.email')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <select
          data-testid="invite-role"
          value={role}
          onChange={(event) => setRole(event.target.value as UserRoleName)}
          className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
        >
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {t(`admin.roles.${value}`)}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          data-testid="invite-submit"
          disabled={!email.trim() || invite.isPending}
          onClick={() => invite.mutate()}
        >
          {t('admin.invite')}
        </Button>
      </div>
    </Card>
  )
}
