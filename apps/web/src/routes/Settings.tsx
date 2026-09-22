import type {
  ConversationMode,
  HttpToolArg,
  HttpToolConfig,
  Language,
  ToolBindingSource,
  ToolSummary,
} from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ModelField,
  refreshProviderModels,
  useModelVerification,
  useProviderModels,
  VerifyButton,
  VerifyMessage,
} from '../components/ModelField'
import {
  Button,
  Card,
  ConfirmButton,
  cn,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  Spinner,
  Textarea,
} from '../components/ui'
import { WidgetPanel } from '../components/WidgetPanel'
import {
  api,
  type Channel,
  type CredentialCheck,
  type Provider,
  type TaskSlot,
  type ToolTestResult,
  type WorkspaceSettings,
} from '../lib/api'

const TASKS = [
  'agent_chat',
  'vision',
  'suggestion_for_human',
  'summarize',
  'classify_intent_and_handoff',
  'embed',
  'rerank',
] as const

export function Settings() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const workspace = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: () => api.settings.workspace(),
  })
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.settings.providers() })
  const slots = useQuery({ queryKey: ['task-slots'], queryFn: () => api.settings.taskSlots() })
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api.settings.channels() })

  const flash = () => {
    setSavedNote(t('settings.saved'))
    setTimeout(() => setSavedNote(null), 2000)
  }

  const saveWorkspace = useMutation({
    mutationFn: (patch: Parameters<typeof api.settings.updateWorkspace>[0]) =>
      api.settings.updateWorkspace(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] })
      flash()
    },
  })

  if (workspace.isLoading) {
    return (
      <div className="p-6">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  const settings = workspace.data?.settings
  if (!settings) return <ErrorNote message={t('common.error')} />

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-12">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
        {savedNote ? (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">{savedNote}</span>
        ) : null}
      </div>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold">{t('settings.workspace')}</h2>

        <div>
          <Label htmlFor="persona">{t('settings.persona')}</Label>
          <Textarea
            id="persona"
            rows={5}
            defaultValue={settings.persona}
            onBlur={(e) => {
              if (e.target.value !== settings.persona) {
                saveWorkspace.mutate({ persona: e.target.value })
              }
            }}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="default-mode">{t('settings.defaultMode')}</Label>
            <select
              id="default-mode"
              className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
              value={settings.defaultMode}
              onChange={(e) =>
                saveWorkspace.mutate({ defaultMode: e.target.value as ConversationMode })
              }
            >
              {(['ai', 'ai_supervised', 'human'] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {t(`modes.${mode}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="default-language">{t('settings.defaultLanguage')}</Label>
            <select
              id="default-language"
              className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
              value={settings.defaultLanguage}
              onChange={(e) =>
                saveWorkspace.mutate({ defaultLanguage: e.target.value as Language })
              }
            >
              <option value="th">ไทย</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>

        <HoldingMessages settings={settings} onSave={(patch) => saveWorkspace.mutate(patch)} />

        <fieldset>
          <legend className="mb-1 text-xs font-medium text-[var(--text-muted)]">
            {t('settings.redaction')}
          </legend>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ['cardNumbers', t('settings.cardNumbers')],
                ['thaiNationalId', t('settings.thaiNationalId')],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.redaction[key]}
                  onChange={(e) =>
                    saveWorkspace.mutate({
                      redaction: { ...settings.redaction, [key]: e.target.checked },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </Card>

      <ProvidersCard
        providers={providers.data?.providers ?? []}
        onChange={() => {
          void queryClient.invalidateQueries({ queryKey: ['providers'] })
          flash()
        }}
      />

      <TaskSlotsCard
        slots={slots.data?.slots ?? []}
        providers={providers.data?.providers ?? []}
        onChange={() => {
          void queryClient.invalidateQueries({ queryKey: ['task-slots'] })
          flash()
        }}
      />

      <IdentityCard settings={settings} onSave={(patch) => saveWorkspace.mutate(patch as never)} />

      <ToolsCard />

      <CannedResponsesCard />

      <ChannelsCard
        channels={channels.data?.channels ?? []}
        onChange={() => {
          void queryClient.invalidateQueries({ queryKey: ['channels'] })
          flash()
        }}
      />
    </div>
  )
}

/**
 * What a customer reads while they wait for a person.
 *
 * Two sentences the AI never writes: one sent the moment it stops answering, one sent if
 * nobody has picked the conversation up by the deadline below them. They were settings the
 * API accepted and no screen offered, which meant every tenant shipped with the defaults
 * and the operator had no way to sound like themselves at the one moment the AI has
 * admitted it cannot help.
 */
function HoldingMessages({
  settings,
  onSave,
}: {
  settings: WorkspaceSettings
  onSave: (patch: Partial<WorkspaceSettings>) => void
}) {
  const { t } = useTranslation()

  const field = (
    key: 'acknowledgementText' | 'stillWaitingText',
    language: 'th' | 'en',
  ): ReactNode => {
    const current = settings[key][language] ?? ''
    return (
      <div>
        <Label htmlFor={`${key}-${language}`}>{language === 'th' ? 'ไทย' : 'English'}</Label>
        <Textarea
          id={`${key}-${language}`}
          data-testid={`${key}-${language}`}
          rows={2}
          maxLength={1000}
          defaultValue={current}
          onBlur={(event) => {
            if (event.target.value === current) return
            onSave({ [key]: { ...settings[key], [language]: event.target.value } })
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
      <div>
        <h3 className="text-[13px] font-semibold">{t('settings.holdingMessages')}</h3>
        <p className="text-[12px] text-[var(--text-muted)]">{t('settings.holdingHint')}</p>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium">{t('settings.acknowledgementText')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {field('acknowledgementText', 'th')}
          {field('acknowledgementText', 'en')}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium">{t('settings.stillWaitingText')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {field('stillWaitingText', 'th')}
          {field('stillWaitingText', 'en')}
        </div>
      </div>

      <div className="max-w-xs">
        <Label htmlFor="waiting-fallback">{t('settings.waitingHumanFallback')}</Label>
        <Input
          id="waiting-fallback"
          data-testid="waiting-human-minutes"
          type="number"
          min={1}
          max={1440}
          placeholder={t('settings.waitingHumanFallbackOff')}
          defaultValue={settings.waitingHumanFallbackMinutes ?? ''}
          onBlur={(event) => {
            const raw = event.target.value.trim()
            // An empty box switches the second message off rather than meaning zero: there
            // is no such thing as apologising for a wait that has not happened yet.
            const next = raw === '' ? null : Number(raw)
            if (next !== null && (!Number.isInteger(next) || next < 1 || next > 1440)) return
            if (next === settings.waitingHumanFallbackMinutes) return
            onSave({ waitingHumanFallbackMinutes: next })
          }}
        />
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          {t('settings.waitingHumanFallbackHint')}
        </p>
      </div>
    </div>
  )
}

function ProvidersCard({ providers, onChange }: { providers: Provider[]; onChange: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.settings.createProvider({ name, baseUrl, apiKey: apiKey || undefined }),
    onSuccess: () => {
      setName('')
      setBaseUrl('')
      setApiKey('')
      setError(null)
      onChange()
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.settings.deleteProvider(id),
    onSuccess: onChange,
  })

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">{t('settings.providers')}</h2>

      {providers.map((provider) => (
        <div
          key={provider.id}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">{provider.name}</div>
            <div className="truncate text-[11px] text-[var(--text-muted)]">{provider.baseUrl}</div>
          </div>
          {provider.hasKey ? (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              {t('settings.keySet')}
            </span>
          ) : null}
          <ConfirmButton
            testId={`provider-remove-${provider.id}`}
            label={t('common.remove')}
            armedLabel={t('common.removeConfirm')}
            onConfirm={() => remove.mutate(provider.id)}
          />
        </div>
      ))}

      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          placeholder={t('settings.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder={t('settings.baseUrl')}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Input
          type="password"
          placeholder={t('settings.apiKey')}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      {error ? <ErrorNote message={error} /> : null}
      <Button
        variant="primary"
        size="sm"
        disabled={!name || !baseUrl || create.isPending}
        onClick={() => create.mutate()}
      >
        {t('settings.addProvider')}
      </Button>
    </Card>
  )
}

type SlotBody = {
  primaryProviderId: string | null
  primaryModel: string | null
  fallbackProviderId: string | null
  fallbackModel: string | null
  /** Merged by the API rather than replacing what the slot holds. */
  params?: Record<string, unknown>
}

/**
 * One target of a task slot: the provider, the model, and a button that tests exactly that
 * pair. Primary and fallback each get their own line, which is what leaves room for the
 * test button beside the model rather than stranded below it.
 */
function SlotTargetRow({
  testId,
  task,
  label,
  providers,
  providerId,
  model,
  sendDimensions,
  onProviderChange,
  onModelChange,
}: {
  testId: string
  task: string
  label: string
  providers: Provider[]
  providerId: string | null
  model: string | null
  sendDimensions: boolean
  onProviderChange: (id: string | null) => void
  onModelChange: (model: string | null) => void
}) {
  const { t } = useTranslation()
  const verification = useModelVerification({ providerId, model, task, sendDimensions })

  return (
    <div className="mt-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <select
          className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[13px]"
          data-testid={`${testId}-provider`}
          aria-label={label}
          value={providerId ?? ''}
          onChange={(e) => onProviderChange(e.target.value || null)}
        >
          <option value="">{t('settings.none')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ModelField
          testId={`${testId}-model`}
          providerId={providerId}
          value={model}
          onSave={onModelChange}
        />
        <VerifyButton verification={verification} label={label} testId={`${testId}-model`} />
      </div>
      <VerifyMessage verification={verification} testId={`${testId}-model`} />
    </div>
  )
}

function TaskSlotsCard({
  slots,
  providers,
  onChange,
}: {
  slots: TaskSlot[]
  providers: Provider[]
  onChange: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: ({ task, body }: { task: string; body: SlotBody }) =>
      api.settings.setTaskSlot(task, body),
    onSuccess: onChange,
  })

  /** A slot is stored whole, so every edit resends the fields it did not touch. */
  const patchSlot = (task: string, slot: TaskSlot | undefined, patch: Partial<SlotBody>) =>
    save.mutate({
      task,
      body: {
        primaryProviderId: slot?.primaryProviderId ?? null,
        primaryModel: slot?.primaryModel ?? null,
        fallbackProviderId: slot?.fallbackProviderId ?? null,
        fallbackModel: slot?.fallbackModel ?? null,
        ...patch,
      },
    })

  // Only the providers a slot actually points at are asked for their model list.
  const usedProviderIds = [
    ...new Set(
      slots.flatMap((s) => [s.primaryProviderId, s.fallbackProviderId]).filter((id) => id !== null),
    ),
  ]

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('settings.taskSlots')}</h2>
        <Button
          size="sm"
          variant="ghost"
          data-testid="refresh-models"
          onClick={() => refreshProviderModels(queryClient)}
        >
          {t('settings.refreshModels')}
        </Button>
      </div>
      <p className="text-[13px] text-[var(--text-muted)]">
        {t('settings.primary')} / {t('settings.fallback')}
      </p>

      {usedProviderIds.map((id) => (
        <ModelListNote key={id} providerId={id} providers={providers} />
      ))}

      {TASKS.map((task) => {
        const slot = slots.find((s) => s.task === task)
        return (
          <div key={task} className="rounded-lg border border-[var(--border)] p-2.5">
            <div className="mb-1.5 font-mono text-[12px] font-medium">{task}</div>
            <SlotTargetRow
              testId={`slot-${task}-primary`}
              task={task}
              label={t('settings.primary')}
              providers={providers}
              providerId={slot?.primaryProviderId ?? null}
              model={slot?.primaryModel ?? null}
              sendDimensions={slot?.params.sendDimensions !== false}
              onProviderChange={(id) => patchSlot(task, slot, { primaryProviderId: id })}
              onModelChange={(model) => patchSlot(task, slot, { primaryModel: model })}
            />
            <SlotTargetRow
              testId={`slot-${task}-fallback`}
              task={task}
              label={t('settings.fallback')}
              providers={providers}
              providerId={slot?.fallbackProviderId ?? null}
              model={slot?.fallbackModel ?? null}
              sendDimensions={slot?.params.sendDimensions !== false}
              onProviderChange={(id) => patchSlot(task, slot, { fallbackProviderId: id })}
              onModelChange={(model) => patchSlot(task, slot, { fallbackModel: model })}
            />

            {task === 'embed' ? (
              <label className="mt-2 flex items-start gap-2 text-[12px] text-[var(--text-muted)]">
                {/*
                  Uncontrolled, and remounted by its key when the saved value changes. A
                  controlled checkbox here would snap back on click and only settle once the
                  save returned, which reads as a control that does not work. The key also
                  restores the box if the save fails.
                */}
                <input
                  key={String(slot?.params.sendDimensions !== false)}
                  type="checkbox"
                  className="mt-0.5"
                  data-testid="slot-embed-send-dimensions"
                  defaultChecked={slot?.params.sendDimensions !== false}
                  onChange={(e) =>
                    patchSlot(task, slot, { params: { sendDimensions: e.target.checked } })
                  }
                />
                <span>
                  {t('settings.sendDimensions')}
                  <span className="block">{t('settings.sendDimensionsHint')}</span>
                </span>
              </label>
            ) : null}
          </div>
        )
      })}
    </Card>
  )
}

/**
 * Said once per provider rather than under every field: a gateway either serves `/models`
 * or it does not, and fourteen copies of the same sentence would drown the card.
 */
function ModelListNote({ providerId, providers }: { providerId: string; providers: Provider[] }) {
  const { t } = useTranslation()
  const models = useProviderModels(providerId)
  const name = providers.find((p) => p.id === providerId)?.name ?? providerId

  if (models.isPending) return null
  const count = models.data?.models.length ?? 0
  if (count > 0) return null

  return (
    <p
      className="text-[12px] text-[var(--text-muted)]"
      data-testid={`model-list-note-${providerId}`}
    >
      {name}: {t('settings.noModelList')}
    </p>
  )
}

/**
 * Reusable replies. An agent types `/shortcut` followed by a space in the composer and the
 * body expands in place, so a saved answer costs no clicks.
 */
function CannedResponsesCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [shortcut, setShortcut] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  const responses = useQuery({
    queryKey: ['canned-responses'],
    queryFn: () => api.settings.cannedResponses(),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['canned-responses'] })

  const create = useMutation({
    mutationFn: () => api.settings.createCannedResponse({ shortcut, body }),
    onSuccess: () => {
      setShortcut('')
      setBody('')
      setError(null)
      refresh()
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.settings.deleteCannedResponse(id),
    onSuccess: refresh,
  })

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">{t('settings.cannedResponses')}</h2>
      <p className="text-[13px] text-[var(--text-muted)]">{t('settings.cannedHint')}</p>

      {(responses.data?.responses ?? []).map((response) => (
        <div
          key={response.id}
          className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <code className="shrink-0 rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[12px]">
            /{response.shortcut}
          </code>
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px]">{response.body}</p>
          <ConfirmButton
            testId={`canned-remove-${response.id}`}
            label={t('common.remove')}
            armedLabel={t('common.removeConfirm')}
            onConfirm={() => remove.mutate(response.id)}
          />
        </div>
      ))}

      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <Input
          placeholder={t('settings.shortcut')}
          value={shortcut}
          onChange={(e) => setShortcut(e.target.value)}
        />
        <Textarea
          rows={2}
          placeholder={t('settings.cannedBody')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      {error ? <ErrorNote message={error} /> : null}
      <Button
        size="sm"
        variant="primary"
        disabled={!shortcut.trim() || !body.trim() || create.isPending}
        onClick={() => create.mutate()}
      >
        {t('settings.addCanned')}
      </Button>
    </Card>
  )
}

/**
 * Channel credentials.
 *
 * Connecting LINE or Messenger is a two-way paste: the platform's secrets come in here, and
 * the webhook URL, plus Meta's verify token, goes back there. Both sides are shown together
 * so an operator is not hunting between browser tabs, and a check button asks the platform
 * whether the credentials work rather than waiting for a customer's first message to reveal
 * that they do not.
 */
function ChannelsCard({ channels, onChange }: { channels: Channel[]; onChange: () => void }) {
  const { t } = useTranslation()
  const [addingType, setAddingType] = useState<Channel['type'] | null>(null)

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">{t('settings.channels')}</h2>

      {channels.map((channel) => (
        <ChannelRow key={channel.id} channel={channel} onChange={onChange} />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {(['line', 'messenger'] as const)
          .filter((type) => !channels.some((c) => c.type === type))
          .map((type) => (
            <Button key={type} size="sm" onClick={() => setAddingType(type)}>
              {type === 'line' ? t('settings.connectLine') : t('settings.connectMessenger')}
            </Button>
          ))}
      </div>

      {addingType ? (
        <AddChannel
          type={addingType}
          onClose={() => setAddingType(null)}
          onDone={() => {
            setAddingType(null)
            onChange()
          }}
        />
      ) : null}
    </Card>
  )
}

function ChannelRow({ channel, onChange }: { channel: Channel; onChange: () => void }) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})
  const [check, setCheck] = useState<CredentialCheck | null>(null)
  const [expanded, setExpanded] = useState(false)

  const save = useMutation({
    mutationFn: () => api.settings.updateChannel(channel.id, { config: values }),
    onSuccess: () => {
      setValues({})
      onChange()
    },
  })

  const runCheck = useMutation({
    mutationFn: () => api.settings.checkChannel(channel.id),
    onSuccess: setCheck,
  })

  const needsCredentials = channel.requiredFields.length > 0

  return (
    <div className="rounded-lg border border-[var(--border)] p-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{channel.name}</span>
        <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] uppercase text-[var(--text-muted)]">
          {channel.type}
        </span>
        {needsCredentials ? (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-medium',
              channel.hasConfig
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
            )}
          >
            {channel.hasConfig ? t('settings.credentialsSet') : t('settings.credentialsMissing')}
          </span>
        ) : null}
        <div className="ml-auto flex gap-1.5">
          {needsCredentials && channel.hasConfig ? (
            <Button size="sm" variant="ghost" onClick={() => runCheck.mutate()}>
              {runCheck.isPending ? t('common.loading') : t('settings.checkConnection')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t('common.close') : t('settings.configure')}
          </Button>
        </div>
      </div>

      {check ? (
        <p
          className={cn(
            'mt-2 rounded-lg px-2 py-1.5 text-[13px]',
            check.ok
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
          )}
        >
          {check.detail}
        </p>
      ) : null}

      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          <div>
            <Label>{t('settings.webhookUrl')}</Label>
            <code className="block break-all rounded bg-[var(--surface-muted)] px-2 py-1 text-[11px]">
              {channel.webhookUrl}
            </code>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('settings.webhookHint')}</p>
          </div>

          {channel.verifyToken ? (
            <div>
              <Label>{t('settings.verifyToken')}</Label>
              <code className="block break-all rounded bg-[var(--surface-muted)] px-2 py-1 text-[11px]">
                {channel.verifyToken}
              </code>
            </div>
          ) : null}

          {channel.type === 'web' ? <WidgetPanel channel={channel} onChange={onChange} /> : null}

          {channel.requiredFields.map((field) => (
            <div key={field.key}>
              <Label htmlFor={`${channel.id}-${field.key}`}>{field.label}</Label>
              <Input
                id={`${channel.id}-${field.key}`}
                type={field.secret ? 'password' : 'text'}
                placeholder={channel.hasConfig ? t('settings.unchanged') : ''}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              />
            </div>
          ))}

          {needsCredentials ? (
            <Button
              size="sm"
              variant="primary"
              disabled={Object.keys(values).length === 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {t('settings.save')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function AddChannel({
  type,
  onClose,
  onDone,
}: {
  type: Channel['type']
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(type === 'line' ? 'LINE Official Account' : 'Facebook Page')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    // Created without credentials on purpose: the webhook URL has to exist before the
    // platform will accept it, and the secrets are pasted afterwards.
    mutationFn: () => api.settings.createChannel({ type, name }),
    onSuccess: onDone,
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] p-2.5">
      <p className="mb-2 text-[13px] text-[var(--text-muted)]">{t('settings.connectHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.name')}
        />
        <Button
          variant="primary"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {t('settings.save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
      {error ? (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Tools a workspace defines against its own API.
 *
 * Admin-only, because defining one stores a credential and points our infrastructure at a
 * host of the tenant's choosing. The test button matters more than it looks: it calls the
 * endpoint through the same code a real turn uses, so a wrong URL is found here rather
 * than in front of a customer.
 */
function ToolsCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api.settings.tools() })
  const [editing, setEditing] = useState<ToolSummary | 'new' | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tools'] })
    setEditing(null)
  }

  const remove = useMutation({
    mutationFn: (id: string) => api.settings.deleteTool(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tools'] }),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.settings.updateTool(id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tools'] }),
  })

  const list = tools.data?.tools ?? []

  return (
    <Card className="space-y-3" data-testid="tools-card">
      <h2 className="text-sm font-semibold">{t('settings.tools')}</h2>
      <p className="text-[11px] text-[var(--text-muted)]">{t('settings.toolsHint')}</p>

      {list.length === 0 && editing === null ? (
        <EmptyState title={t('settings.toolNoTools')} />
      ) : null}

      {list.map((tool) => (
        <div
          key={tool.id}
          data-testid={`tool-row-${tool.name}`}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[12px] font-medium">{tool.name}</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px]',
                  tool.config.effect === 'write'
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                    : 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
                )}
              >
                {tool.config.effect === 'write'
                  ? t('settings.toolEffectWrite')
                  : t('settings.toolEffectRead')}
              </span>
              {tool.hasCredential ? (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  {t('settings.toolCredentialSet')}
                </span>
              ) : null}
            </div>
            <div className="truncate text-[11px] text-[var(--text-muted)]">
              {tool.config.method} {tool.config.url}
            </div>
          </div>
          <label className="flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={tool.enabled}
              onChange={(e) => toggle.mutate({ id: tool.id, enabled: e.target.checked })}
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            data-testid="tool-edit"
            onClick={() => setEditing(tool)}
          >
            {t('common.edit')}
          </Button>
          <ConfirmButton
            testId={`tool-remove-${tool.name}`}
            label={t('common.remove')}
            armedLabel={t('common.removeConfirm')}
            onConfirm={() => remove.mutate(tool.id)}
          />
        </div>
      ))}

      {editing ? (
        <ToolEditor
          tool={editing === 'new' ? null : editing}
          onSaved={refresh}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <Button
          size="sm"
          variant="primary"
          data-testid="tool-add"
          onClick={() => setEditing('new')}
        >
          {t('settings.addTool')}
        </Button>
      )}
    </Card>
  )
}

const BINDING_SOURCES: ToolBindingSource[] = [
  'subject',
  'customer_id',
  'conversation_id',
  'workspace_id',
]

function emptyConfig(): HttpToolConfig {
  return {
    method: 'GET',
    url: '',
    headers: {},
    auth: 'none',
    args: [],
    bindings: [],
    effect: 'read',
    timeoutMs: 8000,
  }
}

/**
 * The editor for one tool.
 *
 * The two lists are kept visually apart on purpose: what the model fills in, and what we
 * fill in. That distinction is the whole security model, and a form that mixed them would
 * make it look like a matter of taste.
 */
function ToolEditor({
  tool,
  onSaved,
  onCancel,
}: {
  tool: ToolSummary | null
  onSaved: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(tool?.name ?? '')
  const [description, setDescription] = useState(tool?.description ?? '')
  const [config, setConfig] = useState<HttpToolConfig>(tool?.config ?? emptyConfig())
  const [credential, setCredential] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [testArgs, setTestArgs] = useState<Record<string, string>>({})
  const [testSubject, setTestSubject] = useState('')
  const [testResult, setTestResult] = useState<ToolTestResult | null>(null)
  /**
   * Stable keys for the argument rows.
   *
   * The index will not do: an argument's name changes on every keystroke, and removing a
   * row above would re-key the ones below it, remounting the input the person is typing in
   * and losing their cursor.
   */
  const [argKeys, setArgKeys] = useState<string[]>(() =>
    (tool?.config.args ?? []).map(() => crypto.randomUUID()),
  )

  const patchConfig = (patch: Partial<HttpToolConfig>) =>
    setConfig((current) => ({ ...current, ...patch }))

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, description, config }
      if (tool) {
        return api.settings.updateTool(tool.id, {
          ...body,
          ...(credential ? { credential } : {}),
        })
      }
      return api.settings.createTool({ ...body, ...(credential ? { credential } : {}) })
    },
    onSuccess: () => {
      setError(null)
      onSaved()
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  const test = useMutation({
    mutationFn: () => {
      if (!tool) throw new Error('Save the tool before testing it')
      return api.settings.testTool(tool.id, {
        args: testArgs,
        ...(testSubject ? { subject: testSubject } : {}),
      })
    },
    onSuccess: (result) => setTestResult(result),
    onError: (caught) =>
      setTestResult({
        ok: false,
        durationMs: 0,
        error: caught instanceof Error ? caught.message : String(caught),
      }),
  })

  const bindingNameFor = (source: ToolBindingSource) =>
    config.bindings.find((b) => b.source === source)?.name ?? ''

  const setBinding = (source: ToolBindingSource, on: boolean, paramName: string) => {
    patchConfig({
      bindings: on
        ? [...config.bindings.filter((b) => b.source !== source), { name: paramName, source }]
        : config.bindings.filter((b) => b.source !== source),
    })
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t('settings.toolName')}</Label>
          <Input
            data-testid="tool-name"
            placeholder="check_plan"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-[11px] text-[var(--text-muted)]">{t('settings.toolNameHint')}</p>
        </div>
        <div className="space-y-1">
          <Label>{t('settings.toolDescription')}</Label>
          <Input
            data-testid="tool-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[100px_1fr]">
        <div className="space-y-1">
          <Label>{t('settings.toolMethod')}</Label>
          <select
            data-testid="tool-method"
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            value={config.method}
            onChange={(e) => patchConfig({ method: e.target.value as 'GET' | 'POST' })}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t('settings.toolUrl')}</Label>
          <Input
            data-testid="tool-url"
            placeholder="https://api.example.com/accounts/{{account_id}}/plan"
            value={config.url}
            onChange={(e) => patchConfig({ url: e.target.value })}
          />
          <p className="text-[11px] text-[var(--text-muted)]">{t('settings.toolUrlHint')}</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>{t('settings.toolEffect')}</Label>
          <select
            data-testid="tool-effect"
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            value={config.effect}
            onChange={(e) => patchConfig({ effect: e.target.value as 'read' | 'write' })}
          >
            <option value="read">{t('settings.toolEffectRead')}</option>
            <option value="write">{t('settings.toolEffectWrite')}</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t('settings.toolAuth')}</Label>
          <select
            data-testid="tool-auth"
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            value={config.auth}
            onChange={(e) => patchConfig({ auth: e.target.value as HttpToolConfig['auth'] })}
          >
            <option value="none">{t('settings.toolAuthNone')}</option>
            <option value="bearer">{t('settings.toolAuthBearer')}</option>
            <option value="header">{t('settings.toolAuthHeader')}</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t('settings.toolTimeout')}</Label>
          <Input
            type="number"
            value={config.timeoutMs}
            onChange={(e) => patchConfig({ timeoutMs: Number(e.target.value) })}
          />
        </div>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{t('settings.toolEffectHint')}</p>

      {config.auth !== 'none' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {config.auth === 'header' ? (
            <div className="space-y-1">
              <Label>{t('settings.toolAuthHeaderName')}</Label>
              <Input
                placeholder="X-Api-Key"
                value={config.authHeaderName ?? ''}
                onChange={(e) => patchConfig({ authHeaderName: e.target.value })}
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label>{t('settings.toolCredential')}</Label>
            <Input
              type="password"
              data-testid="tool-credential"
              placeholder={tool?.hasCredential ? '••••••••' : ''}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-2.5">
        <legend className="px-1 text-[11px] font-medium">{t('settings.toolArgs')}</legend>
        <p className="text-[11px] text-[var(--text-muted)]">{t('settings.toolArgsHint')}</p>
        {config.args.map((arg, index) => (
          <div
            key={argKeys[index] ?? `arg-${index}`}
            className="grid gap-1.5 sm:grid-cols-[1fr_90px_1fr_auto_auto]"
          >
            <Input
              placeholder={t('settings.toolArgName')}
              value={arg.name}
              onChange={(e) =>
                patchConfig({
                  args: config.args.map((a, i) =>
                    i === index ? { ...a, name: e.target.value } : a,
                  ),
                })
              }
            />
            <select
              aria-label={t('settings.toolArgType')}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
              value={arg.type}
              onChange={(e) =>
                patchConfig({
                  args: config.args.map((a, i) =>
                    i === index ? { ...a, type: e.target.value as HttpToolArg['type'] } : a,
                  ),
                })
              }
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
            <Input
              placeholder={t('settings.toolArgDescription')}
              value={arg.description}
              onChange={(e) =>
                patchConfig({
                  args: config.args.map((a, i) =>
                    i === index ? { ...a, description: e.target.value } : a,
                  ),
                })
              }
            />
            <label className="flex items-center gap-1 text-[11px] whitespace-nowrap">
              <input
                type="checkbox"
                data-testid={`tool-arg-required-${index}`}
                checked={arg.required}
                onChange={(e) =>
                  patchConfig({
                    args: config.args.map((a, i) =>
                      i === index ? { ...a, required: e.target.checked } : a,
                    ),
                  })
                }
              />
              {t('settings.toolArgRequired')}
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('common.remove')}
              onClick={() => {
                patchConfig({ args: config.args.filter((_, i) => i !== index) })
                setArgKeys((keys) => keys.filter((_, i) => i !== index))
              }}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            patchConfig({
              args: [...config.args, { name: '', type: 'string', description: '', required: true }],
            })
          }
        >
          {t('settings.addArg')}
        </Button>
      </fieldset>

      <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-2.5">
        <legend className="px-1 text-[11px] font-medium">{t('settings.toolBindings')}</legend>
        <p className="text-[11px] text-[var(--text-muted)]">{t('settings.toolBindingsHint')}</p>
        {BINDING_SOURCES.map((source) => {
          const active = config.bindings.some((b) => b.source === source)
          const label =
            source === 'subject'
              ? t('settings.bindingSubject')
              : source === 'customer_id'
                ? t('settings.bindingCustomer')
                : source === 'conversation_id'
                  ? t('settings.bindingConversation')
                  : t('settings.bindingWorkspace')
          return (
            <div key={source} className="flex items-center gap-2">
              <label className="flex w-48 items-center gap-1.5 text-[12px]">
                <input
                  type="checkbox"
                  data-testid={`tool-binding-${source}`}
                  checked={active}
                  onChange={(e) => setBinding(source, e.target.checked, source)}
                />
                {label}
              </label>
              {active ? (
                <Input
                  className="max-w-[220px]"
                  value={bindingNameFor(source)}
                  onChange={(e) => setBinding(source, true, e.target.value)}
                />
              ) : null}
            </div>
          )
        })}
      </fieldset>

      {error ? <ErrorNote message={error} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          data-testid="tool-save"
          disabled={!name || !description || !config.url || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('settings.saveTool')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>

      {tool ? (
        <div className="space-y-2 rounded-lg border border-dashed border-[var(--border)] p-2.5">
          {config.args.length > 0 ? (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {config.args.map((arg) => (
                <Input
                  key={`test-${arg.name}`}
                  placeholder={arg.name}
                  value={testArgs[arg.name] ?? ''}
                  onChange={(e) =>
                    setTestArgs((current) => ({ ...current, [arg.name]: e.target.value }))
                  }
                />
              ))}
            </div>
          ) : null}
          {config.bindings.some((b) => b.source === 'subject') ? (
            <Input
              placeholder={t('settings.testSubject')}
              value={testSubject}
              onChange={(e) => setTestSubject(e.target.value)}
            />
          ) : null}
          <Button
            size="sm"
            data-testid="tool-test"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {t('settings.testTool')}
          </Button>
          {testResult ? (
            <pre
              data-testid="tool-test-result"
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-muted)] p-2 text-[11px]"
            >
              {testResult.ok
                ? `${testResult.status} · ${testResult.durationMs}ms\n${JSON.stringify(testResult.body, null, 2)}`
                : testResult.error}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Which proofs of identity this workspace accepts.
 *
 * Two switches rather than one, because the proofs are not equivalent: a token your own
 * application signed is worth what that application is worth, and a link is worth whatever
 * login sits behind it.
 */
function IdentityCard({
  settings,
  onSave,
}: {
  settings: WorkspaceSettings
  onSave: (patch: { identity: Record<string, unknown> }) => void
}) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(settings.identity.verificationLink.url ?? '')
  const [secret, setSecret] = useState('')
  const [ttl, setTtl] = useState(settings.identity.verificationLink.ttlMinutes)

  return (
    <Card className="space-y-3" data-testid="identity-card">
      <h2 className="text-sm font-semibold">{t('settings.identity')}</h2>
      <p className="text-[11px] text-[var(--text-muted)]">{t('settings.identityHint')}</p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="identity-widget-token"
          className="mt-1"
          checked={settings.identity.widgetToken.enabled}
          onChange={(e) => onSave({ identity: { widgetToken: { enabled: e.target.checked } } })}
        />
        <span>
          {t('settings.identityWidgetToken')}
          <span className="block text-[11px] text-[var(--text-muted)]">
            {t('settings.identityWidgetTokenHint')}
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="identity-verification-link"
          className="mt-1"
          checked={settings.identity.verificationLink.enabled}
          onChange={(e) =>
            onSave({ identity: { verificationLink: { enabled: e.target.checked } } })
          }
        />
        <span>
          {t('settings.identityLink')}
          <span className="block text-[11px] text-[var(--text-muted)]">
            {t('settings.identityLinkHint')}
          </span>
        </span>
      </label>

      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_100px]">
        <div className="space-y-1">
          <Label>{t('settings.identityLinkUrl')}</Label>
          <Input
            data-testid="identity-link-url"
            placeholder="https://salon.example.com/verify"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => onSave({ identity: { verificationLink: { url: url.trim() || null } } })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('settings.identityLinkSecret')}</Label>
          <Input
            type="password"
            data-testid="identity-link-secret"
            placeholder={settings.identity.verificationLink.hasSecret ? '••••••••' : ''}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onBlur={() => {
              if (!secret) return
              onSave({ identity: { verificationLink: { secret } } })
              setSecret('')
            }}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('settings.identityLinkTtl')}</Label>
          <Input
            type="number"
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            onBlur={() => onSave({ identity: { verificationLink: { ttlMinutes: ttl } } })}
          />
        </div>
      </div>
    </Card>
  )
}
