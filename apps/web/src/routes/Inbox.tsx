import type {
  ConversationMode,
  FeedbackRating,
  FeedbackReason,
  FeedbackTargetType,
} from '@ci/shared'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomerAssignee } from '../components/CustomerAssignee'
import { DeliveryTicks } from '../components/DeliveryTicks'
import { EraseCustomer } from '../components/EraseCustomer'
import { FeedbackControls } from '../components/FeedbackControls'
import { Lightbox } from '../components/Lightbox'
import { MergeSuggestions } from '../components/MergeSuggestions'
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
import { type AiTrace, api, type ConversationDetail, type Feedback, type Message } from '../lib/api'
import { useRealtime } from '../lib/ws'

/**
 * The inbox: conversation list, thread, and the AI sidebar.
 *
 * On a phone the three panes become one at a time, because an agent replying from their
 * phone needs the thread full-width, not a squeezed column.
 */
/** How many messages the thread asks for at a time, and grows by on scroll. */
const MESSAGE_PAGE = 30

/**
 * The most the thread will ever show, matching the cap the endpoint enforces.
 *
 * Held here as well so the button disappears on reaching it rather than going dead: without
 * the clamp the window would keep growing past what the server honours, and pressing would
 * quietly do nothing. A conversation longer than this is a different feature, not a bigger
 * number, and one that only matters now that a thread is never closed for good.
 */
const MAX_MESSAGE_WINDOW = 500

export function Inbox() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'open' | 'resolved' | undefined>('open')
  const [modeFilter, setModeFilter] = useState<ConversationMode | undefined>(undefined)
  const [reviewFilter, setReviewFilter] = useState(false)

  /**
   * Who owns each customer, so a row can say so.
   *
   * The order already groups the list, but an inbox that silently reads differently for two
   * people sitting next to each other is worth explaining on the rows themselves.
   */
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 300_000 })
  const members = useQuery({
    queryKey: ['members-list'],
    queryFn: () => api.settings.members(),
    staleTime: 300_000,
  })
  const ownerName = (userId: string | null): string | null => {
    if (!userId) return null
    if (userId === me.data?.userId) return t('sidebar.mine')
    return members.data?.members.find((member) => member.userId === userId)?.name ?? null
  }

  const conversations = useQuery({
    queryKey: ['conversations', statusFilter, modeFilter, reviewFilter],
    queryFn: () =>
      api.conversations.list({
        status: statusFilter,
        mode: modeFilter,
        ...(reviewFilter ? { review: 'true' as const } : {}),
      }),
    refetchInterval: 30_000,
  })

  /**
   * How much is waiting to be reviewed. Its own query rather than a count off the list,
   * because the badge has to be right on every tab, not only while the review tab is open.
   */
  const reviewCount = useQuery({
    queryKey: ['review-count'],
    queryFn: () => api.conversations.reviewCount(),
    refetchInterval: 30_000,
  })

  // Live updates: refresh the list and, when it is the open conversation, the thread.
  useRealtime((event) => {
    if ('conversationId' in event) {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['review-count'] })
      if (event.conversationId === selectedId) {
        void queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] })
      }
    }
  })

  /**
   * The server decides the order, and nothing re-sorts it here.
   *
   * It used to lift `waiting_human` to the top in the browser, which was right when the
   * whole queue arrived in one page. The queue is now ordered by who owns the customer and
   * then by how long each has been waiting, and only the database knows the first of those
   * — re-sorting a page of fifty here would quietly contradict it.
   */
  const rows = conversations.data?.conversations ?? []

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
              { key: 'review', label: t('inbox.review') },
              { key: 'resolved', label: t('inbox.filters.resolved') },
            ] as const
          ).map((tab) => {
            const active = reviewFilter
              ? tab.key === 'review'
              : tab.key === 'waiting'
                ? modeFilter === 'waiting_human'
                : tab.key !== 'review' && statusFilter === tab.key && modeFilter === undefined
            const waitingToReview = reviewCount.data?.count ?? 0
            return (
              <button
                key={tab.key}
                type="button"
                data-testid={`inbox-tab-${tab.key}`}
                onClick={() => {
                  if (tab.key === 'waiting') {
                    setReviewFilter(false)
                    setModeFilter('waiting_human')
                    setStatusFilter(undefined)
                  } else if (tab.key === 'review') {
                    // Review cuts across status: a resolved conversation still needs reading.
                    setReviewFilter(true)
                    setModeFilter(undefined)
                    setStatusFilter(undefined)
                  } else {
                    setReviewFilter(false)
                    setModeFilter(undefined)
                    setStatusFilter(tab.key)
                  }
                }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface-muted)] text-[var(--text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]',
                )}
              >
                {tab.label}
                {tab.key === 'review' && waitingToReview > 0 ? (
                  <span
                    data-testid="review-tab-count"
                    className="rounded-full bg-amber-500/20 px-1.5 text-[11px] font-semibold tabular-nums text-amber-600 dark:text-amber-300"
                  >
                    {waitingToReview}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.isLoading ? (
            <div className="p-4">
              <Spinner label={t('common.loading')} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title={t('inbox.empty')} />
          ) : (
            <ul>
              {rows.map((conversation) => (
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
                      {ownerName(conversation.customer.assigneeUserId) ? (
                        <span
                          data-testid="conversation-owner"
                          className="ml-auto shrink-0 rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
                        >
                          {ownerName(conversation.customer.assigneeUserId)}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          'shrink-0 text-[11px] text-[var(--text-muted)]',
                          ownerName(conversation.customer.assigneeUserId) ? '' : 'ml-auto',
                        )}
                      >
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
          /* Keyed: the draft and the suggestion it came from belong to one conversation,
             and remounting is what guarantees they never follow the agent to the next. */
          <ConversationPane
            key={selectedId}
            conversationId={selectedId}
            onBack={() => setSelectedId(null)}
          />
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
  /**
   * The draft in the composer came from this suggestion, if it came from one.
   *
   * Carried so that inserting a draft, editing it and sending it still records which
   * suggestion it was. That pairing is the only honest measure of how good the drafts are:
   * it says whether the agent trusted one or rewrote it, without asking them.
   */
  const [insertedSuggestionId, setInsertedSuggestionId] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(false)
  const [promoting, setPromoting] = useState<Message | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  /**
   * How much of the thread to ask for. Raised as somebody scrolls up.
   *
   * A window rather than the whole conversation: a customer coming back reopens their
   * conversation now, so a thread can run for months, and the panel needs the last page of
   * it rather than the first. Asking for a bigger window keeps the newest message at the
   * end, so a reply arriving while somebody reads history cannot leave a hole in the middle.
   */
  const [messageWindow, setMessageWindow] = useState(MESSAGE_PAGE)
  /**
   * Set while a larger window is in flight, so scrolling does not ask again on every pixel.
   *
   * Its own state rather than the query's `isFetching`, which is also true for the ordinary
   * background refetch that happens whenever a message arrives: the button would flicker
   * disabled under somebody trying to press it.
   */
  const [loadingOlder, setLoadingOlder] = useState(false)
  const restoreScrollRef = useRef<number | null>(null)

  // A different conversation starts at the bottom of its own thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting is the point
  useEffect(() => {
    setMessageWindow(MESSAGE_PAGE)
    setLoadingOlder(false)
  }, [conversationId])

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 300_000 })
  // Viewers see every opinion and hold none. The routes enforce this; here it is courtesy.
  const canWrite = me.data?.role === 'admin' || me.data?.role === 'agent'

  const detail = useQuery({
    queryKey: ['conversation', conversationId, messageWindow],
    queryFn: () => api.conversations.detail(conversationId, messageWindow),
    // Without this the thread empties while a larger window is fetched, which reads as the
    // conversation vanishing under the person reading it.
    placeholderData: keepPreviousData,
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

  /**
   * Follow the thread as messages arrive, keyed on the newest message rather than on how
   * many there are. Counting would also fire when older ones are loaded above, yanking
   * somebody back to the bottom the moment they scrolled up to read.
   */
  const newestMessageId = detail.data?.messages.at(-1)?.id ?? null
  useEffect(() => {
    if (!newestMessageId) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [newestMessageId])

  /**
   * Put the reader back where they were after older messages are added above them.
   *
   * Prepending content moves everything down by however tall it is, so without this the
   * thread jumps and the message they were reading is somewhere off screen.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the wider window lands
  useEffect(() => {
    setLoadingOlder(false)
    const thread = threadRef.current
    const previousHeight = restoreScrollRef.current
    if (!thread || previousHeight === null) return
    restoreScrollRef.current = null
    thread.scrollTop = thread.scrollHeight - previousHeight
  }, [detail.data?.messages.length])

  const canLoadOlder = Boolean(detail.data?.hasMoreMessages) && messageWindow < MAX_MESSAGE_WINDOW

  const loadOlder = () => {
    if (!canLoadOlder || loadingOlder) return
    const thread = threadRef.current
    if (thread) restoreScrollRef.current = thread.scrollHeight
    setLoadingOlder(true)
    setMessageWindow((current) => Math.min(current + MESSAGE_PAGE, MAX_MESSAGE_WINDOW))
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    void queryClient.invalidateQueries({ queryKey: ['review-count'] })
  }

  const send = useMutation({
    mutationFn: ({ text, suggestionId }: { text: string; suggestionId?: string }) =>
      api.conversations.send(conversationId, { kind: 'text', text }, suggestionId),
    onSuccess: () => {
      setDraft('')
      setInsertedSuggestionId(null)
      invalidate()
    },
  })

  const rate = useMutation({
    mutationFn: (input: {
      targetType: FeedbackTargetType
      targetId: string
      rating: FeedbackRating
      reason?: FeedbackReason | null
      note?: string | null
    }) => api.conversations.giveFeedback(conversationId, input),
    onSuccess: invalidate,
  })

  const unrate = useMutation({
    mutationFn: (feedbackId: string) =>
      api.conversations.removeFeedback(conversationId, feedbackId),
    onSuccess: invalidate,
  })

  const markReviewed = useMutation({
    mutationFn: () => api.conversations.markReviewed(conversationId),
    onSuccess: invalidate,
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

  /** This person's own opinion of one thing, out of everybody's. */
  const mineFor = (targetType: FeedbackTargetType, targetId: string): Feedback | null =>
    detail.data?.feedback.find(
      (row) =>
        row.targetType === targetType &&
        row.targetId === targetId &&
        row.userId === me.data?.userId,
    ) ?? null

  const fromSuggestion = () => (insertedSuggestionId ? { suggestionId: insertedSuggestionId } : {})

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

        <div
          ref={threadRef}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
          data-testid="message-thread"
          onScroll={(event) => {
            // Near the top rather than exactly at it: a thread that only loads at zero never
            // loads at all on a trackpad that stops a pixel short.
            if (event.currentTarget.scrollTop < 80) loadOlder()
          }}
        >
          {canLoadOlder ? (
            <div className="flex justify-center py-1">
              <Button
                size="sm"
                variant="ghost"
                data-testid="load-older-messages"
                disabled={loadingOlder}
                onClick={loadOlder}
              >
                {loadingOlder ? t('common.loading') : t('conversation.loadOlder')}
              </Button>
            </div>
          ) : null}
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
                feedback={{
                  mine: mineFor('message', message.id),
                  canWrite,
                  onRate: (rating, reason, note) =>
                    rate.mutate({
                      targetType: 'message',
                      targetId: message.id,
                      rating,
                      reason,
                      note,
                    }),
                  onRemove: () => {
                    const mine = mineFor('message', message.id)
                    if (mine) unrate.mutate(mine.id)
                  },
                }}
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
              onChange={(e) => {
                const next = expandShortcut(e.target.value)
                setDraft(next)
                // Cleared the box: whatever draft was inserted is no longer what is being sent.
                if (!next.trim()) setInsertedSuggestionId(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                  e.preventDefault()
                  send.mutate({ text: draft.trim(), ...fromSuggestion() })
                }
              }}
            />
            <Button
              variant="primary"
              data-testid="send"
              disabled={!draft.trim() || send.isPending}
              onClick={() => send.mutate({ text: draft.trim(), ...fromSuggestion() })}
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
        canWrite={canWrite}
        feedbackFor={(suggestionId) => mineFor('suggestion', suggestionId)}
        onRefresh={invalidate}
        onInsert={(text, suggestionId) => {
          setDraft(text)
          setInsertedSuggestionId(suggestionId)
        }}
        onInsertAndSend={(text, suggestionId) => send.mutate({ text, suggestionId })}
        onDiscard={(suggestionId) => {
          void api.conversations.discardSuggestion(conversationId, suggestionId).then(invalidate)
        }}
        onRate={(suggestionId, rating, reason, note) =>
          rate.mutate({ targetType: 'suggestion', targetId: suggestionId, rating, reason, note })
        }
        onRemoveRating={(suggestionId) => {
          const mine = mineFor('suggestion', suggestionId)
          if (mine) unrate.mutate(mine.id)
        }}
        onMarkReviewed={() => markReviewed.mutate()}
        onErased={invalidate}
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
  feedback,
}: {
  message: Message
  onPromote?: (() => void) | undefined
  /**
   * Rating lives on the bubble because that is where the answer is. The conversation id
   * never comes down here: the pane binds it into these callbacks, so a bubble cannot rate
   * anything outside the thread it is drawn in.
   */
  feedback?: {
    mine: Feedback | null
    canWrite: boolean
    onRate: (rating: FeedbackRating, reason?: FeedbackReason | null, note?: string | null) => void
    onRemove: () => void
  }
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
      data-message-id={message.id}
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
        {/* Below the footer rather than in it: the reason panel needs the bubble's width. */}
        {isAi && feedback ? (
          <div className="mt-1">
            <FeedbackControls
              testIdPrefix="feedback-message"
              mine={feedback.mine}
              canWrite={feedback.canWrite}
              onRate={feedback.onRate}
              onRemove={feedback.onRemove}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AiSidebar({
  detail,
  className,
  language,
  canWrite,
  feedbackFor,
  onInsert,
  onInsertAndSend,
  onDiscard,
  onRate,
  onRemoveRating,
  onMarkReviewed,
  onErased,
  onRefresh,
}: {
  detail: ConversationDetail
  className?: string
  language: string
  canWrite: boolean
  feedbackFor: (suggestionId: string) => Feedback | null
  onInsert: (text: string, suggestionId: string) => void
  onInsertAndSend: (text: string, suggestionId: string) => void
  onDiscard: (suggestionId: string) => void
  onRate: (
    suggestionId: string,
    rating: FeedbackRating,
    reason?: FeedbackReason | null,
    note?: string | null,
  ) => void
  onRemoveRating: (suggestionId: string) => void
  onMarkReviewed: () => void
  onErased: () => void
  /** The customer changed in a way the conversation list also has to hear about. */
  onRefresh: () => void
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
      {detail.inReviewQueue ? (
        <section
          data-testid="review-panel"
          className="rounded-lg border border-amber-400/60 bg-amber-50 p-2.5 dark:bg-amber-950/30"
        >
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {t('sidebar.review')}
          </h3>
          <p className="text-[12px] text-amber-900 dark:text-amber-200">
            {t('sidebar.inReviewQueue')}
          </p>
          {canWrite ? (
            <Button
              size="sm"
              className="mt-2 w-full"
              data-testid="mark-reviewed"
              onClick={onMarkReviewed}
            >
              {t('sidebar.markReviewed')}
            </Button>
          ) : null}
        </section>
      ) : null}

      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('sidebar.suggestion')}
        </h3>
        {suggestion ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-2.5">
            <p className="whitespace-pre-wrap text-[13px]">{suggestion.messageText}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                data-testid="suggestion-insert"
                onClick={() => onInsert(suggestion.messageText, suggestion.id)}
              >
                {t('sidebar.insert')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                data-testid="suggestion-insert-and-send"
                onClick={() => onInsertAndSend(suggestion.messageText, suggestion.id)}
              >
                {t('sidebar.insertAndSend')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="suggestion-discard"
                onClick={() => onDiscard(suggestion.id)}
              >
                {t('sidebar.discard')}
              </Button>
              <FeedbackControls
                testIdPrefix="feedback-suggestion"
                tone="dark"
                mine={feedbackFor(suggestion.id)}
                canWrite={canWrite}
                onRate={(rating, reason, note) => onRate(suggestion.id, rating, reason, note)}
                onRemove={() => onRemoveRating(suggestion.id)}
              />
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

        {/* Who owns the relationship. Above the rest because it decides where this person
            appears in everybody's inbox, which is the most consequential thing on the panel. */}
        {detail.customer ? (
          <div className="mb-2">
            <CustomerAssignee
              customerId={detail.customer.id}
              assigneeUserId={detail.customer.assigneeUserId ?? null}
              canWrite={canWrite}
              onAssigned={onRefresh}
            />
          </div>
        ) : null}

        {/* Whether this person was proved, not merely recognised. A tool that reads an
            account is only offered once this says yes, so it is worth showing plainly. */}
        <IdentityBadge detail={detail} canWrite={canWrite} />

        <dl className="space-y-1 text-[13px]">
          {Object.entries(detail.customer?.fields ?? {}).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-[var(--text-muted)]">{key}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
        {/* Every channel this person is known on. After a merge, two lines appear here,
            which is the only visible proof that the two records became one. */}
        {detail.identities.length > 0 ? (
          <div className="mt-2">
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              {t('sidebar.identities')}
            </p>
            <ul data-testid="customer-identities">
              {detail.identities.map((identity) => (
                <li
                  key={identity.id}
                  className="truncate font-mono text-[11px] text-[var(--text-muted)]"
                >
                  {identity.externalId}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {detail.customer?.summary ? (
          <p className="mt-2 text-[13px] text-[var(--text-muted)]">{detail.customer.summary}</p>
        ) : null}
        <EraseCustomer conversationId={detail.conversation.id} onErased={onErased} />
      </section>

      {detail.customer ? (
        <MergeSuggestions customerId={detail.customer.id} canWrite={canWrite} onMerged={onErased} />
      ) : null}

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
  const toolCalls = (trace.toolCalls ?? []) as {
    toolName?: string
    input?: unknown
    output?: unknown
  }[]

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
                    <div>
                      {call.toolName}({JSON.stringify(call.input)})
                    </div>
                    {/* What it answered, not only that it was asked. For a tenant's own
                        endpoint this is the difference between a usable trace and a list
                        of names. */}
                    {call.output === undefined || call.output === null ? null : (
                      <div className="truncate pl-3 text-[var(--text-muted)]">
                        ↳ {t('trace.toolOutput')} {JSON.stringify(call.output)}
                      </div>
                    )}
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

/**
 * Whether this customer was proved, and a way to ask them to prove it.
 *
 * `fields` in the sidebar above is what somebody typed into a chat window. This is what a
 * proof carried, which is the only half a tool may be bound to, so the two are shown
 * separately rather than merged into one list of "what we know".
 */
function IdentityBadge({ detail, canWrite }: { detail: ConversationDetail; canWrite: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [sent, setSent] = useState(false)

  const [error, setError] = useState<string | null>(null)

  const sendLink = useMutation({
    mutationFn: () => api.conversations.sendVerificationLink(detail.conversation.id),
    onSuccess: () => {
      setSent(true)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['conversation', detail.conversation.id] })
    },
    // The route refuses when the link is switched off or has no URL. Without this the
    // button simply re-enables itself and the agent presses it again.
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  const identity = detail.identity
  const verified = identity?.verified ?? false

  return (
    <div className="mb-2 space-y-1.5">
      {verified && identity ? (
        <div data-testid="identity-verified" className="space-y-1">
          <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            {t('sidebar.identityVerified')}
            {identity.verifiedVia ? ` · ${t(`sidebar.identityVia.${identity.verifiedVia}`)}` : ''}
          </span>
          <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
            {identity.verifiedSubject}
          </div>
          {Object.entries(identity.verifiedAttributes).length > 0 ? (
            <dl className="space-y-0.5 text-[12px]">
              {Object.entries(identity.verifiedAttributes).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="text-[var(--text-muted)]">{key}</dt>
                  <dd className="truncate">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : (
        <span className="inline-block rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
          {t('sidebar.identityUnverified')}
        </span>
      )}

      {!verified && canWrite && detail.canSendVerificationLink ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="send-verification-link"
          disabled={sendLink.isPending || sent}
          onClick={() => sendLink.mutate()}
        >
          {sent ? t('sidebar.verificationLinkSent') : t('sidebar.sendVerificationLink')}
        </Button>
      ) : null}

      {error ? <ErrorNote message={error} /> : null}
    </div>
  )
}
