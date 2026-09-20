import type { ConversationMode } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DeliveryTicks } from '../components/DeliveryTicks'
import { Lightbox } from '../components/Lightbox'
import {
  Button,
  cn,
  EmptyState,
  ErrorNote,
  formatTime,
  Input,
  Label,
  ModeBadge,
  Spinner,
  Textarea,
  timeAgo,
} from '../components/ui'
import {
  type AiTrace,
  api,
  type ConversationDetail,
  type ConversationListItem,
  type Message,
} from '../lib/api'
import { useRealtime } from '../lib/ws'

/**
 * The inbox: conversation list, thread, and the AI sidebar.
 *
 * On a phone the three panes become one at a time, because an agent replying from their
 * phone needs the thread full-width, not a squeezed column.
 */
export function Inbox() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'open' | 'resolved' | undefined>('open')
  const [modeFilter, setModeFilter] = useState<ConversationMode | undefined>(undefined)

  const conversations = useQuery({
    queryKey: ['conversations', statusFilter, modeFilter],
    queryFn: () => api.conversations.list({ status: statusFilter, mode: modeFilter }),
    refetchInterval: 30_000,
  })

  // Live updates: refresh the list and, when it is the open conversation, the thread.
  useRealtime((event) => {
    if ('conversationId' in event) {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (event.conversationId === selectedId) {
        void queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] })
      }
    }
  })

  const rows = conversations.data?.conversations ?? []
  // Anything waiting on a person belongs at the top; that is the queue agents work from.
  const sorted = [...rows].sort((a, b) => {
    const rank = (c: ConversationListItem) => (c.mode === 'waiting_human' ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
  })

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'flex w-full flex-col border-r border-[var(--border)] bg-[var(--surface)] md:w-80 lg:w-96',
          selectedId ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="flex shrink-0 gap-1 border-b border-[var(--border)] p-2">
          {(
            [
              { key: 'open', label: t('inbox.filters.open') },
              { key: 'waiting', label: t('inbox.waiting') },
              { key: 'resolved', label: t('inbox.filters.resolved') },
            ] as const
          ).map((tab) => {
            const active =
              tab.key === 'waiting'
                ? modeFilter === 'waiting_human'
                : statusFilter === tab.key && modeFilter === undefined
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  if (tab.key === 'waiting') {
                    setModeFilter('waiting_human')
                    setStatusFilter(undefined)
                  } else {
                    setModeFilter(undefined)
                    setStatusFilter(tab.key)
                  }
                }}
                className={cn(
                  'flex-1 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface-muted)] text-[var(--text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]',
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.isLoading ? (
            <div className="p-4">
              <Spinner label={t('common.loading')} />
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState title={t('inbox.empty')} />
          ) : (
            <ul>
              {sorted.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    data-testid="conversation-row"
                    onClick={() => setSelectedId(conversation.id)}
                    className={cn(
                      'flex w-full flex-col gap-1 border-b border-[var(--border)] px-3 py-2.5 text-left transition-colors',
                      selectedId === conversation.id
                        ? 'bg-[var(--surface-muted)]'
                        : 'hover:bg-[var(--surface-muted)]',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {conversation.customer.displayName ?? t('common.customer')}
                      </span>
                      <ModeBadge mode={conversation.mode} label={t(`modes.${conversation.mode}`)} />
                      {conversation.unreadCount > 0 ? (
                        <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-[var(--color-brand-600)] text-[11px] font-semibold text-white">
                          {conversation.unreadCount}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] text-[var(--text-muted)]">
                        {conversation.lastMessage?.text ?? ''}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-[var(--text-muted)]">
                        {timeAgo(conversation.lastMessageAt, i18n.language)}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section
        className={cn('min-w-0 flex-1', selectedId ? 'flex' : 'hidden md:flex')}
        data-testid="composer-or-empty-inbox"
      >
        {selectedId ? (
          <ConversationPane conversationId={selectedId} onBack={() => setSelectedId(null)} />
        ) : (
          <EmptyState title={t('conversation.selectPrompt')} />
        )}
      </section>
    </div>
  )
}

function ConversationPane({
  conversationId,
  onBack,
}: {
  conversationId: string
  onBack: () => void
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [showSidebar, setShowSidebar] = useState(false)
  const [promoting, setPromoting] = useState<Message | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversations.detail(conversationId),
  })

  const canned = useQuery({
    queryKey: ['canned-responses'],
    queryFn: () => api.settings.cannedResponses(),
    staleTime: 300_000,
  })

  // `/shortcut ` expands as the agent types, so a saved reply costs no clicks.
  const expandShortcut = (value: string): string => {
    const match = value.match(/^\/(\S+)\s$/)
    if (!match) return value
    const found = canned.data?.responses.find((r) => r.shortcut === match[1])
    return found ? `${found.body} ` : value
  }

  // Follow the thread as messages arrive. Nothing to scroll to while it is empty.
  const messageCount = detail.data?.messages.length ?? 0
  useEffect(() => {
    if (messageCount === 0) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messageCount])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
  }

  const send = useMutation({
    mutationFn: ({ text, suggestionId }: { text: string; suggestionId?: string }) =>
      api.conversations.send(conversationId, { kind: 'text', text }, suggestionId),
    onSuccess: () => {
      setDraft('')
      invalidate()
    },
  })

  const takeOver = useMutation({
    mutationFn: () => api.conversations.takeOver(conversationId),
    onSuccess: invalidate,
  })

  const returnToAi = useMutation({
    mutationFn: (note: string) => api.conversations.returnToAi(conversationId, note || undefined),
    onSuccess: invalidate,
  })

  const setStatus = useMutation({
    mutationFn: (status: 'open' | 'resolved') =>
      api.conversations.setStatus(conversationId, status),
    onSuccess: invalidate,
  })

  if (detail.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  const data = detail.data
  if (!data) return <EmptyState title={t('common.error')} />

  const mode = data.conversation.mode
  const isHumanOwned = mode === 'human'

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3">
          <Button size="sm" variant="ghost" className="md:hidden" onClick={onBack}>
            ←
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {data.customer?.displayName ?? t('common.customer')}
              </span>
              <ModeBadge mode={mode} label={t(`modes.${mode}`)} />
            </div>
            {data.conversation.handoffReason ? (
              <span className="text-[11px] text-[var(--text-muted)]">
                {t('conversation.handoffReason')}: {data.conversation.handoffReason}
              </span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {isHumanOwned ? (
              <Button size="sm" data-testid="return-to-ai" onClick={() => returnToAi.mutate('')}>
                {t('conversation.returnToAi')}
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid="take-over"
                variant="primary"
                onClick={() => takeOver.mutate()}
              >
                {t('conversation.takeOver')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setStatus.mutate(data.conversation.status === 'resolved' ? 'open' : 'resolved')
              }
            >
              {data.conversation.status === 'resolved'
                ? t('conversation.reopen')
                : t('conversation.resolve')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="lg:hidden"
              onClick={() => setShowSidebar((v) => !v)}
            >
              AI
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="message-thread">
          {data.messages.length === 0 ? (
            <EmptyState title={t('conversation.noMessages')} />
          ) : (
            data.messages.map((message) => (
              <Bubble
                key={message.id}
                message={message}
                onPromote={
                  message.direction === 'outbound' && message.text
                    ? () => setPromoting(message)
                    : undefined
                }
              />
            ))
          )}
          {data.notes.map((note) => (
            <div
              key={note.id}
              className="mx-auto max-w-lg rounded-lg border border-dashed border-amber-400 bg-amber-50 px-3 py-1.5 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <span className="font-medium">{t('conversation.internalNote')}: </span>
              {note.body}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <footer className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] p-2">
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              data-testid="composer"
              value={draft}
              placeholder={t('conversation.placeholder')}
              onChange={(e) => setDraft(expandShortcut(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                  e.preventDefault()
                  send.mutate({ text: draft.trim() })
                }
              }}
            />
            <Button
              variant="primary"
              data-testid="send"
              disabled={!draft.trim() || send.isPending}
              onClick={() => send.mutate({ text: draft.trim() })}
            >
              {t('conversation.send')}
            </Button>
          </div>
        </footer>
      </div>

      {promoting ? (
        <PromoteToKnowledge message={promoting} onClose={() => setPromoting(null)} />
      ) : null}

      <AiSidebar
        detail={data}
        className={cn(showSidebar ? 'flex' : 'hidden', 'lg:flex')}
        language={i18n.language}
        onInsert={(text) => setDraft(text)}
        onInsertAndSend={(text, suggestionId) => send.mutate({ text, suggestionId })}
        onDiscard={(suggestionId) => {
          void api.conversations.discardSuggestion(conversationId, suggestionId).then(invalidate)
        }}
      />
    </div>
  )
}

/** Attachments that made it into storage. Anything still uploading has no key yet. */
function attachmentsOf(
  message: Message,
): { storageKey: string; mime: string; fileName: string | null }[] {
  const content = message.content
  if (
    content.kind !== 'image' &&
    content.kind !== 'file' &&
    content.kind !== 'audio' &&
    content.kind !== 'video'
  ) {
    return []
  }
  return content.attachments
    .filter((a): a is typeof a & { storageKey: string } => Boolean(a.storageKey))
    .map((a) => ({ storageKey: a.storageKey, mime: a.mime, fileName: a.fileName }))
}

function Bubble({
  message,
  onPromote,
}: {
  message: Message
  onPromote?: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation()
  const isCustomer = message.senderType === 'customer'
  const isAi = message.senderType === 'ai'
  // Held per bubble rather than by the thread: only one picture can be open at a time
  // anyway, and this keeps the state next to the thing that opens it.
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null)

  return (
    <div
      className={cn('flex', isCustomer ? 'justify-start' : 'justify-end')}
      data-sender={message.senderType}
    >
      {zoomed ? (
        <Lightbox src={zoomed.src} alt={zoomed.alt} onClose={() => setZoomed(null)} />
      ) : null}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm sm:max-w-[70%]',
          isCustomer
            ? 'rounded-bl-sm bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]'
            : isAi
              ? 'rounded-br-sm bg-[var(--color-brand-600)] text-white'
              : 'rounded-br-sm bg-emerald-600 text-white',
        )}
      >
        {attachmentsOf(message).map((attachment) =>
          attachment.mime.startsWith('image/') ? (
            <button
              key={attachment.storageKey}
              type="button"
              data-testid="message-image"
              className="mb-1 block cursor-zoom-in"
              title={t('inbox.openImage')}
              onClick={() =>
                setZoomed({
                  src: api.uploads.urlFor(attachment.storageKey),
                  alt: attachment.fileName ?? '',
                })
              }
            >
              <img
                src={api.uploads.urlFor(attachment.storageKey)}
                alt={attachment.fileName ?? ''}
                className="max-h-64 rounded-lg object-contain"
              />
            </button>
          ) : (
            <a
              key={attachment.storageKey}
              href={api.uploads.urlFor(attachment.storageKey)}
              target="_blank"
              rel="noreferrer"
              className="mb-1 block underline"
            >
              {attachment.fileName ?? attachment.mime}
            </a>
          ),
        )}
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        <div
          className={cn(
            'mt-0.5 flex items-center gap-1.5 text-[10px]',
            isCustomer ? 'text-[var(--text-muted)]' : 'text-white/70',
          )}
        >
          <span>{formatTime(message.createdAt, i18n.language)}</span>
          {isCustomer ? null : <DeliveryTicks status={message.status} />}
          {isAi ? <span>AI</span> : null}
          {onPromote ? (
            <button
              type="button"
              onClick={onPromote}
              className="ml-1 underline decoration-dotted underline-offset-2"
            >
              {t('knowledge.saveAsKnowledge')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AiSidebar({
  detail,
  className,
  language,
  onInsert,
  onInsertAndSend,
  onDiscard,
}: {
  detail: ConversationDetail
  className?: string
  language: string
  onInsert: (text: string) => void
  onInsertAndSend: (text: string, suggestionId: string) => void
  onDiscard: (suggestionId: string) => void
}) {
  const { t } = useTranslation()
  const [openTrace, setOpenTrace] = useState<AiTrace | null>(null)
  const suggestion = detail.suggestions[0]

  const traces = useQuery({
    queryKey: ['traces', detail.conversation.id],
    queryFn: () => api.traces.list(detail.conversation.id),
  })
  const lastTrace = traces.data?.traces[0]
  const totalCost = (traces.data?.traces ?? []).reduce(
    (sum, trace) => sum + Number(trace.costEstimate ?? 0),
    0,
  )

  return (
    <aside
      className={cn(
        'w-full shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-3 lg:w-80',
        className,
      )}
    >
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('sidebar.suggestion')}
        </h3>
        {suggestion ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-2.5">
            <p className="whitespace-pre-wrap text-[13px]">{suggestion.messageText}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => onInsert(suggestion.messageText)}>
                {t('sidebar.insert')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => onInsertAndSend(suggestion.messageText, suggestion.id)}
              >
                {t('sidebar.insertAndSend')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDiscard(suggestion.id)}>
                {t('sidebar.discard')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-[var(--text-muted)]">{t('sidebar.noSuggestion')}</p>
        )}
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('sidebar.customer')}
        </h3>
        <dl className="space-y-1 text-[13px]">
          {Object.entries(detail.customer?.fields ?? {}).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-[var(--text-muted)]">{key}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
          {detail.identity ? (
            <div className="flex gap-2">
              <dt className="text-[var(--text-muted)]">id</dt>
              <dd className="truncate font-mono text-[11px]">{detail.identity.externalId}</dd>
            </div>
          ) : null}
        </dl>
        {detail.customer?.summary ? (
          <p className="mt-2 text-[13px] text-[var(--text-muted)]">{detail.customer.summary}</p>
        ) : null}
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('sidebar.lastTrace')}
        </h3>
        {lastTrace ? (
          <div className="space-y-1 text-[13px]">
            <div className="flex justify-between gap-2">
              <span className="text-[var(--text-muted)]">{t('settings.model')}</span>
              <span className="truncate font-mono text-[11px]">{lastTrace.model}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--text-muted)]">tokens</span>
              <span>
                {lastTrace.tokensIn ?? 0} / {lastTrace.tokensOut ?? 0}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--text-muted)]">latency</span>
              <span>{lastTrace.latencyMs ?? 0} ms</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--text-muted)]">{t('sidebar.cost')}</span>
              <span>
                {new Intl.NumberFormat(language, {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 4,
                }).format(totalCost)}
              </span>
            </div>
            {lastTrace.usedFallback ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                {t('sidebar.fallbackUsed')}
              </p>
            ) : null}
            {lastTrace.error ? (
              <p className="text-[11px] text-red-600 dark:text-red-400">{lastTrace.error}</p>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setOpenTrace(lastTrace)}>
              {t('sidebar.viewTrace')}
            </Button>
          </div>
        ) : (
          <p className="text-[13px] text-[var(--text-muted)]">—</p>
        )}
      </section>

      {openTrace ? <TraceDetail trace={openTrace} onClose={() => setOpenTrace(null)} /> : null}
    </aside>
  )
}

/**
 * The full record of one AI run: the exact prompt, the knowledge it was given, the tools it
 * called and what it cost. This is the answer to "why did it say that", and the reason a
 * wrong answer is a debugging task rather than a mystery.
 */
function TraceDetail({ trace, onClose }: { trace: AiTrace; onClose: () => void }) {
  const { t } = useTranslation()
  const prompt = trace.prompt as {
    system?: string
    messages?: { role: string; content: string }[]
  } | null
  const retrieved = (trace.retrieved ?? []) as { sourceTitle?: string; text?: string }[]
  const toolCalls = (trace.toolCalls ?? []) as { toolName?: string; input?: unknown }[]

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-center gap-2 border-b border-[var(--border)] p-3">
          <h2 className="text-sm font-semibold">{t('trace.title')}</h2>
          <span className="font-mono text-[11px] text-[var(--text-muted)]">{trace.task}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
            {t('common.close')}
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            {(
              [
                [t('settings.model'), trace.model ?? '—'],
                ['provider', trace.providerName ?? '—'],
                ['tokens', `${trace.tokensIn ?? 0} / ${trace.tokensOut ?? 0}`],
                ['latency', `${trace.latencyMs ?? 0} ms`],
                [t('sidebar.cost'), trace.costEstimate ?? '—'],
                ['outcome', trace.outcome],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-[var(--text-muted)]">{label}</dt>
                <dd className="truncate font-mono text-[11px]">{String(value)}</dd>
              </div>
            ))}
          </dl>

          {trace.usedFallback ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              {t('sidebar.fallbackUsed')}
            </p>
          ) : null}
          {trace.error ? <ErrorNote message={trace.error} /> : null}

          <TraceSection title={t('trace.knowledge')}>
            {retrieved.length === 0 ? (
              <p className="text-[var(--text-muted)]">{t('knowledge.noHits')}</p>
            ) : (
              <ul className="space-y-1">
                {retrieved.map((chunk) => (
                  <li
                    key={`${chunk.sourceTitle}-${(chunk.text ?? '').slice(0, 40)}`}
                    className="rounded border border-[var(--border)] p-1.5"
                  >
                    <span className="text-[11px] font-medium">{chunk.sourceTitle}</span>
                    <p className="whitespace-pre-wrap">{chunk.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </TraceSection>

          {toolCalls.length > 0 ? (
            <TraceSection title={t('trace.tools')}>
              <ul className="space-y-1">
                {toolCalls.map((call) => (
                  <li
                    key={`${call.toolName}-${JSON.stringify(call.input)}`}
                    className="font-mono text-[11px]"
                  >
                    {call.toolName}({JSON.stringify(call.input)})
                  </li>
                ))}
              </ul>
            </TraceSection>
          ) : null}

          <TraceSection title={t('trace.systemPrompt')}>
            <pre className="whitespace-pre-wrap break-words rounded bg-[var(--surface-muted)] p-2 text-[11px]">
              {prompt?.system ?? '—'}
            </pre>
          </TraceSection>

          <TraceSection title={t('trace.messages')}>
            <ul className="space-y-1">
              {(prompt?.messages ?? []).map((m) => (
                <li key={`${m.role}-${String(m.content).slice(0, 60)}`}>
                  <span className="text-[11px] font-medium text-[var(--text-muted)]">{m.role}</span>
                  <p className="whitespace-pre-wrap break-words">{String(m.content)}</p>
                </li>
              ))}
            </ul>
          </TraceSection>
        </div>
      </div>
    </div>
  )
}

function TraceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * Promote a reply into the knowledge base.
 *
 * The agent edits before saving. Redaction masks card and ID numbers but deliberately keeps
 * names, phone numbers and order references, because those are the identifiers the product
 * extracts on purpose. A reply that helped one customer often names them, and that must not
 * become a permanent answer given to everyone.
 */
function PromoteToKnowledge({ message, onClose }: { message: Message; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const [question, setQuestion] = useState('')
  const [body, setBody] = useState(message.text)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api.knowledge.fromMessage({
        messageId: message.id,
        title: question.slice(0, 80) || t('knowledge.untitled'),
        question,
        body,
        language: i18n.language === 'th' ? 'th' : 'en',
      }),
    onSuccess: onClose,
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="mb-1 text-sm font-semibold">{t('knowledge.saveAsKnowledge')}</h2>
        <p className="mb-3 text-[13px] text-[var(--text-muted)]">{t('knowledge.promoteHint')}</p>

        <div className="space-y-3">
          <div>
            <Label htmlFor="promote-question">{t('knowledge.question')}</Label>
            <Input
              id="promote-question"
              value={question}
              placeholder={t('knowledge.questionPlaceholder')}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="promote-body">{t('knowledge.answer')}</Label>
            <Textarea
              id="promote-body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {error ? <ErrorNote message={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!question.trim() || !body.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {t('knowledge.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
