import { slugify } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, ConfirmButton, CopyOnce, Input, Spinner, Textarea } from '../components/ui'
import { ApiError, api, type PlatformAdmin, type Tenant } from '../lib/api'

/**
 * The tenants on this installation.
 *
 * Only a platform admin reaches this, and a platform admin is not thereby a member of
 * anything: to read a tenant's conversations they invite themselves into it, and that
 * membership then appears in the tenant's own member list where its admins can see it.
 */
export function Platform() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [freshLink, setFreshLink] = useState<{ link: string; for: string } | null>(null)

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api.platform.tenants() })
  const admins = useQuery({ queryKey: ['platform-admins'], queryFn: () => api.platform.admins() })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenants'] })
    queryClient.invalidateQueries({ queryKey: ['platform-admins'] })
  }

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught))

  if (tenants.isLoading) {
    return (
      <div className="p-4">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-12">
      <div>
        <h1 className="text-sm font-semibold">{t('platform.title')}</h1>
        <p className="text-[13px] text-[var(--text-muted)]">{t('platform.hint')}</p>
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
          testId="platform-invite-link"
        />
      ) : null}

      <TenantsCard
        tenants={tenants.data?.tenants ?? []}
        onChanged={refresh}
        onError={fail}
        onLink={(link, forWhom) => {
          setError(null)
          setFreshLink({ link, for: forWhom })
        }}
      />

      <PlatformAdminsCard admins={admins.data?.admins ?? []} onChanged={refresh} onError={fail} />

      <AccountRecoveryCard
        onError={fail}
        onLink={(link, forWhom) => {
          setError(null)
          setFreshLink({ link, for: forWhom })
        }}
      />
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  suspended: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  deleting: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
}

function TenantsCard({
  tenants,
  onChanged,
  onError,
  onLink,
}: {
  tenants: Tenant[]
  onChanged: () => void
  onError: (error: unknown) => void
  onLink: (link: string, forWhom: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [adminEmail, setAdminEmail] = useState('')
  /** Typed confirmation, per tenant, so two rows cannot arm each other. */
  const [typedSlug, setTypedSlug] = useState<Record<string, string>>({})
  const [showDelete, setShowDelete] = useState<Record<string, boolean>>({})

  const create = useMutation({
    mutationFn: () =>
      api.platform.createTenant({
        name: name.trim(),
        slug: slug.trim(),
        adminEmail: adminEmail.trim(),
      }),
    onSuccess: (result) => {
      onLink(result.inviteLink, adminEmail.trim())
      setName('')
      setSlug('')
      setSlugTouched(false)
      setAdminEmail('')
      onChanged()
    },
    onError,
  })

  const suspend = useMutation({
    mutationFn: (id: string) => api.platform.suspend(id),
    onSuccess: onChanged,
    onError,
  })

  const unsuspend = useMutation({
    mutationFn: (id: string) => api.platform.unsuspend(id),
    onSuccess: onChanged,
    onError,
  })

  const remove = useMutation({
    mutationFn: (input: { id: string; slug: string }) =>
      api.platform.deleteTenant(input.id, input.slug),
    onSuccess: onChanged,
    onError,
  })

  return (
    <Card className="space-y-3" testId="tenants-card">
      <h2 className="text-sm font-semibold">{t('platform.tenants')}</h2>

      {tenants.map((tenant) => (
        <div
          key={tenant.id}
          data-testid={`tenant-row-${tenant.slug}`}
          className="space-y-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{tenant.name}</p>
              <p className="truncate text-[12px] text-[var(--text-muted)]">
                {tenant.slug} · {tenant.memberCount} {t('platform.members')}
              </p>
            </div>

            <span
              data-testid={`tenant-status-${tenant.slug}`}
              className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                STATUS_STYLES[tenant.status] ?? ''
              }`}
            >
              {t(`platform.statuses.${tenant.status}`)}
            </span>

            {tenant.status === 'active' ? (
              <ConfirmButton
                label={t('platform.suspend')}
                armedLabel={t('platform.suspendConfirm')}
                testId={`tenant-suspend-${tenant.slug}`}
                onConfirm={() => suspend.mutate(tenant.id)}
              />
            ) : null}

            {tenant.status === 'suspended' ? (
              <Button
                size="sm"
                data-testid={`tenant-unsuspend-${tenant.slug}`}
                onClick={() => unsuspend.mutate(tenant.id)}
              >
                {t('platform.unsuspend')}
              </Button>
            ) : null}
          </div>

          {tenant.status === 'deleting' ? null : (
            <EgressOrigins tenant={tenant} onChanged={onChanged} onError={onError} />
          )}

          {tenant.status === 'deleting' ? null : showDelete[tenant.id] ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-[12px] text-[var(--text-muted)]">
                {t('platform.deleteHint')}
              </p>
              <Input
                data-testid={`tenant-delete-slug-${tenant.slug}`}
                placeholder={t('platform.typeSlug')}
                value={typedSlug[tenant.id] ?? ''}
                onChange={(event) =>
                  setTypedSlug((current) => ({ ...current, [tenant.id]: event.target.value }))
                }
                className="w-40"
              />
              <Button
                size="sm"
                variant="danger"
                data-testid={`tenant-delete-${tenant.slug}`}
                // Enabled only once the slug matches: the typing is the confirmation, so
                // there is no second dialog to click through by reflex.
                disabled={(typedSlug[tenant.id] ?? '').trim() !== tenant.slug}
                onClick={() => remove.mutate({ id: tenant.id, slug: tenant.slug })}
              >
                {t('platform.delete')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowDelete((current) => ({ ...current, [tenant.id]: false }))}
              >
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            /**
             * Behind one click.
             *
             * The typed-slug box and a red Delete stood open on every row all the time,
             * which doubled each row's height and made the most destructive control on the
             * installation part of the furniture.
             */
            <Button
              size="sm"
              variant="ghost"
              data-testid={`tenant-delete-reveal-${tenant.slug}`}
              onClick={() => setShowDelete((current) => ({ ...current, [tenant.id]: true }))}
            >
              {t('platform.delete')}…
            </Button>
          )}
        </div>
      ))}

      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          data-testid="platform-create-name"
          placeholder={t('platform.name')}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            // Suggested from the name until somebody edits it themselves, using the same
            // slugifier the API validates with, so the suggestion is never one it refuses.
            if (!slugTouched) setSlug(slugify(event.target.value))
          }}
        />
        <Input
          data-testid="platform-create-slug"
          placeholder={t('platform.slug')}
          value={slug}
          onChange={(event) => {
            setSlugTouched(true)
            setSlug(event.target.value)
          }}
        />
        <Input
          data-testid="platform-create-email"
          type="email"
          placeholder={t('platform.adminEmail')}
          value={adminEmail}
          onChange={(event) => setAdminEmail(event.target.value)}
        />
      </div>
      <Button
        variant="primary"
        data-testid="platform-create-submit"
        disabled={!name.trim() || !slug.trim() || !adminEmail.trim() || create.isPending}
        onClick={() => create.mutate()}
      >
        {t('platform.create')}
      </Button>
    </Card>
  )
}

function PlatformAdminsCard({
  admins,
  onChanged,
  onError,
}: {
  admins: PlatformAdmin[]
  onChanged: () => void
  onError: (error: unknown) => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')

  const grant = useMutation({
    mutationFn: () => api.platform.grantAdmin(email.trim()),
    onSuccess: () => {
      setEmail('')
      onChanged()
    },
    onError,
  })

  const revoke = useMutation({
    mutationFn: (userId: string) => api.platform.revokeAdmin(userId),
    onSuccess: onChanged,
    onError,
  })

  return (
    <Card className="space-y-3" testId="platform-admins-card">
      <h2 className="text-sm font-semibold">{t('platform.admins')}</h2>
      <p className="text-[13px] text-[var(--text-muted)]">{t('platform.adminsHint')}</p>

      {admins.map((admin) => (
        <div
          key={admin.userId}
          data-testid={`platform-admin-row-${admin.email}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{admin.name}</p>
            <p className="truncate text-[12px] text-[var(--text-muted)]">{admin.email}</p>
          </div>
          {admin.grantedByUserId ? null : (
            <span className="text-[11px] text-[var(--text-muted)]">
              {t('platform.grantedBySeed')}
            </span>
          )}
          <ConfirmButton
            label={t('platform.revokeAdmin')}
            armedLabel={t('admin.removeConfirm')}
            testId={`platform-admin-revoke-${admin.email}`}
            onConfirm={() => revoke.mutate(admin.userId)}
          />
        </div>
      ))}

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input
          data-testid="platform-admin-email"
          type="email"
          placeholder={t('admin.email')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button
          data-testid="platform-admin-grant"
          disabled={!email.trim() || grant.isPending}
          onClick={() => grant.mutate()}
        >
          {t('platform.grant')}
        </Button>
      </div>
    </Card>
  )
}

/**
 * Resetting a password for somebody a tenant admin may not.
 *
 * `/admin` issues a reset link only for a member whose reach is that one workspace, because
 * the link sets the password on a global account. Everybody else — anyone in two tenants,
 * and every platform admin — is recovered here, where the authority matches the reach.
 */
function AccountRecoveryCard({
  onError,
  onLink,
}: {
  onError: (error: unknown) => void
  onLink: (link: string, forWhom: string) => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')

  const issue = useMutation({
    mutationFn: () => api.platform.resetLink(email.trim()).then((result) => ({ result })),
    onSuccess: ({ result }) => {
      onLink(result.link, email.trim())
      setEmail('')
    },
    onError,
  })

  return (
    <Card className="space-y-3" testId="platform-recovery-card">
      <h2 className="text-sm font-semibold">{t('platform.recovery')}</h2>
      <p className="text-[13px] text-[var(--text-muted)]">{t('platform.recoveryHint')}</p>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input
          data-testid="platform-reset-email"
          type="email"
          placeholder={t('admin.email')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button
          data-testid="platform-reset-submit"
          disabled={!email.trim() || issue.isPending}
          onClick={() => issue.mutate()}
        >
          {t('platform.issueReset')}
        </Button>
      </div>
    </Card>
  )
}

/**
 * The private addresses one tenant's providers may reach.
 *
 * Here and not in the tenant's own settings: a tenant admin types provider URLs, so the
 * exception to the egress rule has to be granted by somebody the tenant is not.
 */
function EgressOrigins({
  tenant,
  onChanged,
  onError,
}: {
  tenant: Tenant
  onChanged: () => void
  onError: (error: unknown) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (origins: string[]) =>
      api.platform.updateTenant(tenant.id, { privateEgressOrigins: origins }),
    onSuccess: () => {
      setDraft(null)
      onChanged()
    },
    onError,
  })

  const origins = tenant.privateEgressOrigins

  return draft === null ? (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-[var(--text-muted)]">{t('platform.egress')}:</span>
      <span
        data-testid={`tenant-egress-${tenant.slug}`}
        className="min-w-0 flex-1 break-all font-mono"
      >
        {origins.length > 0 ? origins.join(', ') : t('platform.egressNone')}
      </span>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`tenant-egress-edit-${tenant.slug}`}
        onClick={() => setDraft(origins.join('\n'))}
      >
        {t('platform.egressEdit')}
      </Button>
    </div>
  ) : (
    <div className="space-y-1.5">
      <p className="text-[12px] text-[var(--text-muted)]">{t('platform.egressHint')}</p>
      <Textarea
        aria-label={t('platform.egress')}
        data-testid={`tenant-egress-input-${tenant.slug}`}
        rows={3}
        className="font-mono text-[12px]"
        placeholder="http://10.0.0.5:8080"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          data-testid={`tenant-egress-save-${tenant.slug}`}
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              draft
                .split(/[\s,]+/)
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        >
          {t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
