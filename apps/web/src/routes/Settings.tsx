import type { ConversationMode, Language } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, ErrorNote, Input, Label, Spinner, Textarea } from '../components/ui'
import { api, type Provider, type TaskSlot } from '../lib/api'

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

      <CannedResponsesCard />

      <Card className="space-y-2">
        <h2 className="text-sm font-semibold">{t('settings.channels')}</h2>
        {(channels.data?.channels ?? []).map((channel) => (
          <div key={channel.id} className="rounded-lg border border-[var(--border)] p-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{channel.name}</span>
              <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] uppercase text-[var(--text-muted)]">
                {channel.type}
              </span>
            </div>
            <div className="mt-1">
              <Label>{t('settings.webhookUrl')}</Label>
              <code className="block break-all rounded bg-[var(--surface-muted)] px-2 py-1 text-[11px]">
                {channel.webhookUrl}
              </code>
            </div>
          </div>
        ))}
      </Card>
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
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(provider.id)}>
            ✕
          </Button>
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

  const save = useMutation({
    mutationFn: ({ task, body }: { task: string; body: Record<string, unknown> }) =>
      api.settings.setTaskSlot(task, body),
    onSuccess: onChange,
  })

  return (
    <Card className="space-y-2">
      <h2 className="text-sm font-semibold">{t('settings.taskSlots')}</h2>
      <p className="text-[13px] text-[var(--text-muted)]">
        {t('settings.primary')} / {t('settings.fallback')}
      </p>

      {TASKS.map((task) => {
        const slot = slots.find((s) => s.task === task)
        return (
          <div key={task} className="rounded-lg border border-[var(--border)] p-2.5">
            <div className="mb-1.5 font-mono text-[12px] font-medium">{task}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex gap-1.5">
                <select
                  className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[13px]"
                  value={slot?.primaryProviderId ?? ''}
                  onChange={(e) =>
                    save.mutate({
                      task,
                      body: {
                        primaryProviderId: e.target.value || null,
                        primaryModel: slot?.primaryModel ?? null,
                        fallbackProviderId: slot?.fallbackProviderId ?? null,
                        fallbackModel: slot?.fallbackModel ?? null,
                      },
                    })
                  }
                >
                  <option value="">{t('settings.none')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Input
                  className="h-8 flex-1 text-[13px]"
                  placeholder={t('settings.model')}
                  defaultValue={slot?.primaryModel ?? ''}
                  onBlur={(e) =>
                    save.mutate({
                      task,
                      body: {
                        primaryProviderId: slot?.primaryProviderId ?? null,
                        primaryModel: e.target.value || null,
                        fallbackProviderId: slot?.fallbackProviderId ?? null,
                        fallbackModel: slot?.fallbackModel ?? null,
                      },
                    })
                  }
                />
              </div>

              <div className="flex gap-1.5">
                <select
                  className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[13px]"
                  value={slot?.fallbackProviderId ?? ''}
                  onChange={(e) =>
                    save.mutate({
                      task,
                      body: {
                        primaryProviderId: slot?.primaryProviderId ?? null,
                        primaryModel: slot?.primaryModel ?? null,
                        fallbackProviderId: e.target.value || null,
                        fallbackModel: slot?.fallbackModel ?? null,
                      },
                    })
                  }
                >
                  <option value="">{t('settings.none')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Input
                  className="h-8 flex-1 text-[13px]"
                  placeholder={t('settings.model')}
                  defaultValue={slot?.fallbackModel ?? ''}
                  onBlur={(e) =>
                    save.mutate({
                      task,
                      body: {
                        primaryProviderId: slot?.primaryProviderId ?? null,
                        primaryModel: slot?.primaryModel ?? null,
                        fallbackProviderId: slot?.fallbackProviderId ?? null,
                        fallbackModel: e.target.value || null,
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        )
      })}
    </Card>
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
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(response.id)}>
            ✕
          </Button>
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
