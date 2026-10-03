import type {
  McpAllowedTool,
  McpServerSummary,
  McpToolSnapshot,
  ToolBindingSource,
  ToolEffect,
} from '@ci/shared'
import { exposedMcpToolName } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import {
  Button,
  Card,
  ConfirmButton,
  cn,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  SaveStatus,
  Textarea,
  useSaveState,
} from './ui'

/**
 * MCP servers (ADR 0011): connect one, fetch what it offers, approve what the AI may use.
 *
 * Nothing a server lists reaches the AI until it is ticked here, and every ticked tool says
 * whether it only reads or changes something. A tool the server itself marks read-only may
 * be a read; one it marks as changing things may only be a write; for anything it does not
 * say, the admin chooses — there is no default to fall into.
 */

const BINDING_SOURCES: ToolBindingSource[] = [
  'subject',
  'customer_id',
  'conversation_id',
  'workspace_id',
]
const BINDING_LABELS: Record<ToolBindingSource, string> = {
  subject: 'settings.bindingSubject',
  customer_id: 'settings.bindingCustomer',
  conversation_id: 'settings.bindingConversation',
  workspace_id: 'settings.bindingWorkspace',
}

export function McpCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const servers = useQuery({ queryKey: ['mcp-servers'], queryFn: () => api.mcp.list() })
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const save = useSaveState()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })

  const remove = useMutation({
    mutationFn: (id: string) => api.mcp.remove(id),
    ...save.handlers,
    onSuccess: () => {
      save.handlers.onSuccess()
      refresh()
    },
  })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.mcp.update(id, { enabled }),
    ...save.handlers,
    onSuccess: () => {
      save.handlers.onSuccess()
      refresh()
    },
  })

  const list = servers.data?.servers ?? []

  return (
    <Card className="space-y-3" testId="mcp-card">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold">{t('mcp.title')}</h2>
        <SaveStatus state={save.state} />
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{t('mcp.hint')}</p>

      {servers.isError ? <ErrorNote message={t('mcp.loadFailed')} /> : null}
      {list.length === 0 && !adding && servers.isSuccess ? (
        <EmptyState title={t('mcp.none')} />
      ) : null}

      {list.map((server) => (
        <div
          key={server.id}
          data-testid={`mcp-row-${server.name}`}
          className="space-y-2 rounded-lg border border-[var(--border)] p-2.5 text-sm"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              aria-expanded={open === server.id}
              data-testid={`mcp-open-${server.name}`}
              onClick={() => setOpen((current) => (current === server.id ? null : server.id))}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[12px] font-medium">{server.name}</span>
                <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                  {t('mcp.allowedCount', { count: server.allowed.length })}
                </span>
                {server.status === 'needs_reconnect' ? (
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                    {t('mcp.needsReconnect')}
                  </span>
                ) : null}
              </div>
              <div className="truncate text-[11px] text-[var(--text-muted)]">{server.url}</div>
            </button>
            <label className="flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                aria-label={t('mcp.enabled')}
                checked={server.enabled}
                onChange={(e) => toggle.mutate({ id: server.id, enabled: e.target.checked })}
              />
            </label>
            <ConfirmButton
              testId={`mcp-remove-${server.name}`}
              label={t('common.remove')}
              armedLabel={t('common.removeConfirm')}
              onConfirm={() => remove.mutate(server.id)}
            />
          </div>
          {server.lastError ? <ErrorNote message={server.lastError} /> : null}
          {open === server.id ? <ServerTools server={server} onChange={refresh} /> : null}
        </div>
      ))}

      {adding ? (
        <AddServer
          onDone={() => {
            setAdding(false)
            refresh()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button size="sm" variant="primary" data-testid="mcp-add" onClick={() => setAdding(true)}>
          {t('mcp.add')}
        </Button>
      )}
    </Card>
  )
}

function AddServer({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const id = useId()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<'none' | 'header'>('header')
  const [headerName, setHeaderName] = useState('Authorization')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api.mcp.create({
        name,
        url,
        auth,
        ...(auth === 'header' ? { headerName, credential: token } : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: onDone,
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  return (
    <form
      className="space-y-2 rounded-lg border border-[var(--border)] p-3"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>{t('mcp.name')}</Label>
          <Input
            id={`${id}-name`}
            data-testid="mcp-name"
            value={name}
            placeholder="shop"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-url`}>{t('mcp.url')}</Label>
          <Input
            id={`${id}-url`}
            data-testid="mcp-url"
            value={url}
            placeholder="https://mcp.example.com/mcp"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-auth`}>{t('mcp.auth')}</Label>
          <select
            id={`${id}-auth`}
            data-testid="mcp-auth"
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            value={auth}
            onChange={(e) => setAuth(e.target.value as 'none' | 'header')}
          >
            <option value="header">{t('mcp.authHeader')}</option>
            <option value="none">{t('mcp.authNone')}</option>
          </select>
        </div>
        {auth === 'header' ? (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${id}-header`}>{t('mcp.headerName')}</Label>
              <Input
                id={`${id}-header`}
                data-testid="mcp-header-name"
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${id}-token`}>{t('mcp.token')}</Label>
              <Input
                id={`${id}-token`}
                data-testid="mcp-token"
                type="password"
                autoComplete="off"
                value={token}
                placeholder={headerName.toLowerCase() === 'authorization' ? 'Bearer …' : ''}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          </>
        ) : null}
      </div>
      {error ? <ErrorNote message={error} /> : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          type="submit"
          data-testid="mcp-save"
          disabled={create.isPending || !name || !url}
        >
          {t('mcp.connect')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

/** Roughly what a tool adds to every turn's prompt: its name, description and schema. */
function promptCost(tool: McpToolSnapshot): number {
  return Math.ceil(
    (tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length) / 4,
  )
}

type Draft = { effect: ToolEffect | null; bindings: Record<string, ToolBindingSource> }

function ServerTools({ server, onChange }: { server: McpServerSummary; onChange: () => void }) {
  const { t } = useTranslation()
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      server.allowed.map((entry) => [
        entry.name,
        {
          effect: entry.effect,
          bindings: Object.fromEntries(entry.bindings.map((b) => [b.name, b.source])),
        },
      ]),
    ),
  )
  const save = useSaveState()

  const fetchTools = useMutation({
    mutationFn: () => api.mcp.fetchTools(server.id),
    onMutate: () => setFetchError(null),
    onSuccess: (result) => {
      if (!result.ok) setFetchError(result.error)
      onChange()
    },
    onError: (caught) => setFetchError(caught instanceof Error ? caught.message : String(caught)),
  })

  const allowed: McpAllowedTool[] = Object.entries(draft).flatMap(([name, entry]) =>
    entry.effect
      ? [
          {
            name,
            effect: entry.effect,
            bindings: Object.entries(entry.bindings).map(([arg, source]) => ({
              name: arg,
              source,
            })),
          },
        ]
      : [],
  )
  const undecided = Object.values(draft).some((entry) => entry.effect === null)

  const saveAllowed = useMutation({
    mutationFn: () => api.mcp.update(server.id, { allowed }),
    ...save.handlers,
    onSuccess: (data, variables, context) => {
      save.handlers.onSuccess(data, variables, context)
      onChange()
    },
  })

  const toggleTool = (tool: McpToolSnapshot, on: boolean) =>
    setDraft((current) => {
      const next = { ...current }
      if (!on) delete next[tool.name]
      else
        next[tool.name] = {
          // The server's own word decides where it can; otherwise nobody chose yet.
          effect: tool.readOnly === true ? 'read' : tool.readOnly === false ? 'write' : null,
          bindings: {},
        }
      return next
    })

  const cost = server.snapshot
    .filter((tool) => draft[tool.name])
    .reduce((sum, tool) => sum + promptCost(tool), 0)

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-testid={`mcp-fetch-${server.name}`}
          disabled={fetchTools.isPending}
          onClick={() => fetchTools.mutate()}
        >
          {server.fetchedAt ? t('mcp.refetch') : t('mcp.fetch')}
        </Button>
        <span className="text-[11px] text-[var(--text-muted)]">
          {t('mcp.cost', { tokens: cost })}
        </span>
      </div>
      {fetchError ? <ErrorNote message={fetchError} /> : null}

      {server.snapshot.length > 0 ? (
        <ul className="space-y-1.5">
          {server.snapshot.map((tool) => {
            const entry = draft[tool.name]
            const properties = Object.keys(
              (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
            )
            return (
              <li
                key={tool.name}
                className="space-y-1 rounded border border-[var(--border)] p-2"
                data-testid={`mcp-tool-${tool.name}`}
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    data-testid={`mcp-allow-${tool.name}`}
                    disabled={tool.tooLarge}
                    checked={Boolean(entry)}
                    onChange={(e) => toggleTool(tool, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[12px]">
                      {exposedMcpToolName(server.name, tool.name)}
                    </span>
                    <span className="block text-[12px] text-[var(--text-muted)]">
                      {tool.tooLarge ? t('mcp.tooLarge') : tool.description}
                    </span>
                  </span>
                </label>
                {entry ? (
                  <div className="flex flex-wrap items-center gap-2 pl-6 text-[12px]">
                    <select
                      aria-label={t('mcp.effect')}
                      data-testid={`mcp-effect-${tool.name}`}
                      className={cn(
                        'h-8 rounded border bg-[var(--surface)] px-1.5',
                        entry.effect === null ? 'border-amber-500' : 'border-[var(--border)]',
                      )}
                      value={entry.effect ?? ''}
                      onChange={(e) =>
                        setDraft((current) => ({
                          ...current,
                          [tool.name]: {
                            ...entry,
                            effect: (e.target.value || null) as ToolEffect | null,
                          },
                        }))
                      }
                    >
                      <option value="">{t('mcp.chooseEffect')}</option>
                      <option value="read" disabled={tool.readOnly === false}>
                        {t('settings.toolEffectRead')}
                      </option>
                      <option value="write">{t('settings.toolEffectWrite')}</option>
                    </select>
                    {properties.map((property) => (
                      <label key={property} className="flex items-center gap-1">
                        <span className="font-mono">{property}</span>
                        <select
                          aria-label={t('mcp.binding', { name: property })}
                          className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5"
                          value={entry.bindings[property] ?? ''}
                          onChange={(e) =>
                            setDraft((current) => {
                              const bindings = { ...entry.bindings }
                              if (e.target.value) {
                                bindings[property] = e.target.value as ToolBindingSource
                              } else delete bindings[property]
                              return { ...current, [tool.name]: { ...entry, bindings } }
                            })
                          }
                        >
                          <option value="">{t('mcp.modelFills')}</option>
                          {BINDING_SOURCES.map((source) => (
                            <option key={source} value={source}>
                              {t(BINDING_LABELS[source])}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {server.snapshot.length > 0 ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            data-testid={`mcp-allow-save-${server.name}`}
            disabled={undecided || saveAllowed.isPending}
            onClick={() => saveAllowed.mutate()}
          >
            {t('mcp.saveAllowed')}
          </Button>
          {undecided ? (
            <span className="text-[11px] text-amber-700 dark:text-amber-300">
              {t('mcp.undecided')}
            </span>
          ) : null}
          <SaveStatus state={save.state} />
        </div>
      ) : null}

      {server.allowed.length > 0 ? <TestTool server={server} /> : null}
    </div>
  )
}

function TestTool({ server }: { server: McpServerSummary }) {
  const { t } = useTranslation()
  const id = useId()
  const [tool, setTool] = useState(server.allowed[0]?.name ?? '')
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const writes = server.allowed.find((entry) => entry.name === tool)?.effect === 'write'

  const run = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(args || '{}') as Record<string, unknown>
      return api.mcp.test(server.id, { tool, args: parsed })
    },
    onMutate: () => {
      setError(null)
      setResult(null)
    },
    onSuccess: (outcome) =>
      outcome.ok ? setResult(outcome.body ?? '') : setError(outcome.error ?? outcome.body ?? ''),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  return (
    <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
      <Label htmlFor={`${id}-tool`}>{t('mcp.test')}</Label>
      <select
        id={`${id}-tool`}
        data-testid="mcp-test-tool"
        className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
        value={tool}
        onChange={(e) => setTool(e.target.value)}
      >
        {server.allowed.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {exposedMcpToolName(server.name, entry.name)}
          </option>
        ))}
      </select>
      <Textarea
        aria-label={t('mcp.testArgs')}
        data-testid="mcp-test-args"
        rows={3}
        className="font-mono text-[12px]"
        value={args}
        onChange={(e) => setArgs(e.target.value)}
      />
      {writes ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">{t('mcp.testWrites')}</p>
      ) : null}
      <Button
        size="sm"
        data-testid="mcp-test-run"
        disabled={run.isPending}
        onClick={() => run.mutate()}
      >
        {t('mcp.testRun')}
      </Button>
      {error ? <ErrorNote message={error} /> : null}
      {result !== null ? (
        <pre
          data-testid="mcp-test-result"
          className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-muted)] p-2 text-[12px]"
        >
          {result}
        </pre>
      ) : null}
    </div>
  )
}
