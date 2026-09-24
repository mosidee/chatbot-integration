import type {
  ConversationMode,
  FeedbackRating,
  FeedbackReason,
  FeedbackTargetType,
  NormalizedMessage,
} from '@ci/shared'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomerAssignee } from '../components/CustomerAssignee'
import { DeliveryProblem, DeliveryTicks } from '../components/DeliveryTicks'
import { EraseCustomer } from '../components/EraseCustomer'
import { FeedbackControls } from '../components/FeedbackControls'
import { Lightbox } from '../components/Lightbox'
import { MergeSuggestions } from '../components/MergeSuggestions'
import {
  Button,
  ChannelBadge,
  cn,
  Dialog,
  dayLabel,
  EmptyState,
  ErrorNote,
  formatTime,
  Icon,
  Input,
  isNewDay,
  Label,
  ModeBadge,
  Spinner,
  Textarea,
  timeAgo,
} from '../components/ui'
import {
  type AiTrace,
  ApiError,
  api,
  type ConversationDetail,
  type Feedback,
  type Message,
  type UploadResult,
} from '../lib/api'
import { can } from '../lib/capabilities'
import { useRealtime } from '../lib/ws'

/**
 * The inbox: conversation list, thread, and the AI sidebar.
 *
 * On a phone the three panes become one at a time, because an agent replying from their
 * phone needs the thread full-width, not a squeezed column.
 */
/**
 * What actually goes out: a note, a file, or a file with a note.
 *
 * The kind follows the mime type rather than always being `image`, which is the difference
 * between a PDF arriving as a document and arriving as a picture that will not open. The
 * simulator gets this wrong on the inbound side and is not a model to copy.
 */
function messageToSend(text: string, attachment: UploadResult | null): NormalizedMessage {
  if (!attachment) return { kind: 'text', text }

  return {
    kind: attachment.mime.startsWith('image/') ? 'image' : 'file',
    text: text || null,
    attachments: [
      {
        storageKey: attachment.storageKey,
        // Filled in when the message goes out, by the one place that knows this
        // installation's public address. See `withMediaLinks`.
        sourceUrl: null,
        mime: attachment.mime,
        sizeBytes: attachment.sizeBytes,
        fileName: attachment.fileName,
        width: null,
        height: null,
        durationMs: null,
      },
    ],
  }
}

/** Which queue the inbox is showing. Lives in the address so it can be linked to. */
export const INBOX_TABS = ['open', 'waiting', 'review', 'resolved'] as const
export type InboxTab = (typeof INBOX_TABS)[number]

/** How many messages the thread asks for at a time, and grows by on scroll. */
const MESSAGE_PAGE = 30

/**
 * What an agent was writing, per conversation, for as long as the page is open.
 *
 * The pane is keyed by conversation, so switching threads remounted it and threw away the
 * half-written reply and its attachment. Kept here instead, and put back when they return.
 */
type Draft = { text: string; suggestionId: string | null; attachment: UploadResult | null }
const drafts = new Map<string, Draft>()

/** Close enough to the bottom to count as following the conversation. */
const FOLLOW_THRESHOLD_PX = 120

export function Inbox() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  /**
   * The open conversation lives in the address, beside the tab.
   *
   * It was component state, so a reload, a shared link or Back lost the thread somebody was
   * in the middle of. A conversation the person may not see is refused by the API and the
   * pane says so; the id in the address grants nothing.
   */
  const selectedId =
    useRouterState({ select: (state) => (state.location.search as { c?: string }).c }) ?? null
  /**
   * Which queue is showing, taken from the address.
   *
   * So the dashboard's "three are waiting" can be the way to go and read them, and so a
   * reload keeps somebody on the tab they were working through.
   */
  const requested = useRouterState({
    select: (state) => (state.location.search as { tab?: string }).tab,
  })
  // The raw location, not what `validateSearch` returns, so it is checked here too: an
  // unknown value otherwise matched no filter and listed every conversation under no tab.
  const tab: InboxTab = INBOX_TABS.includes(requested as InboxTab)
    ? (requested as InboxTab)
    : 'open'
  const setTab = (next: InboxTab) =>
    void navigate({ to: '/', search: { tab: next, ...(selectedId ? { c: selectedId } : {}) } })
  const setSelectedId = (id: string | null) =>
    void navigate({ to: '/', search: { tab, ...(id ? { c: id } : {}) } })

  // Waiting is open conversations only. Resolving does not change the mode, so without
  // this a conversation closed while it waited sat in the Waiting tab for good.
  const statusFilter =
    tab === 'open' || tab === 'resolved' ? tab : tab === 'waiting' ? 'open' : undefined
  const modeFilter: ConversationMode | undefined = tab === 'waiting' ? 'waiting_human' : undefined
  // Review cuts across status: a resolved conversation still needs reading.
  const reviewFilter = tab === 'review'

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

  /**
   * The queue, a page at a time.
   *
   * It used to be the first fifty and nothing else: a busy day's fifty-first conversation
   * was counted in the badge and could not be opened from anywhere.
   */
  const conversations = useInfiniteQuery({
    queryKey: ['conversations', statusFilter, modeFilter, reviewFilter],
    queryFn: ({ pageParam }) =>
      api.conversations.list({
        status: statusFilter,
        mode: modeFilter,
        ...(reviewFilter ? { review: 'true' as const } : {}),
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
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
      // The navigation badges, so a new or handed-off conversation shows there at once.
      void queryClient.invalidateQueries({ queryKey: ['inbox-counts'] })
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
  // Deduplicated by id: a conversation that moved up while the next page loaded would
  // otherwise appear twice.
  const rows = [
    ...new Map(
      (conversations.data?.pages ?? [])
        .flatMap((page) => page.conversations)
        .map((row) => [row.id, row] as const),
    ).values(),
  ]

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
          ).map((item) => {
            const active = tab === item.key
            const waitingToReview = reviewCount.data?.count ?? 0
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`inbox-tab-${item.key}`}
                aria-pressed={active}
                onClick={() => setTab(item.key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface-muted)] text-[var(--text)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]',
                )}
              >
                {item.label}
                {item.key === 'review' && waitingToReview > 0 ? (
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
          ) : conversations.isError && rows.length === 0 ? (
            // A failed load is not an empty queue: saying "no conversations" when the
            // request failed is how a waiting customer goes unseen.
            <div className="space-y-2 p-4" data-testid="inbox-load-failed">
              <ErrorNote message={t('inbox.loadFailed')} />
              <Button size="sm" onClick={() => void conversations.refetch()}>
                {t('common.retry')}
              </Button>
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
                      <ChannelBadge
                        type={conversation.channel.type}
                        label={t(`channels.${conversation.channel.type}`)}
                        testId="conversation-channel"
                      />
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
                          className="ml-auto shrink-0 rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]"
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
              {conversations.hasNextPage ? (
                <li className="p-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    data-testid="load-more-conversations"
                    disabled={conversations.isFetchingNextPage}
                    onClick={() => void conversations.fetchNextPage()}
                  >
                    {conversations.isFetchingNextPage ? t('common.loading') : t('inbox.loadMore')}
                  </Button>
                </li>
              ) : null}
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
  const saved = drafts.get(conversationId)
  const [draft, setDraftState] = useState(saved?.text ?? '')
  /**
   * The draft in the composer came from this suggestion, if it came from one.
   *
   * Carried so that inserting a draft, editing it and sending it still records which
   * suggestion it was. That pairing is the only honest measure of how good the drafts are:
   * it says whether the agent trusted one or rewrote it, without asking them.
   */
  const [insertedSuggestionId, setInsertedSuggestionId] = useState<string | null>(
    saved?.suggestionId ?? null,
  )
  const [showSidebar, setShowSidebar] = useState(false)
  const [returning, setReturning] = useState(false)
  const [returnNote, setReturnNote] = useState('')
  const [promoting, setPromoting] = useState<Message | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  /**
   * The thread is the newest page, kept live, plus older pages fetched by cursor as
   * somebody scrolls up.
   *
   * It used to widen one window and refetch the lot, capped at five hundred messages: the
   * opening of a long conversation could not be reached at all. Older pages are fetched once
   * each, by the id of the oldest message loaded, and never refetched.
   */
  const [older, setOlder] = useState<{ messages: Message[]; notes: ConversationDetail['notes'] }>({
    messages: [],
    notes: [],
  })
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null)
  /**
   * Set while an older page is in flight, so scrolling does not ask again on every pixel.
   * Its own state rather than the query's `isFetching`, which is also true for the ordinary
   * background refetch whenever a message arrives.
   */
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const restoreScrollRef = useRef<number | null>(null)

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 300_000 })
  // Replying, taking over, rating: an agent's. The routes enforce it; this is so a viewer
  // is not invited to press what will refuse them.
  const canWrite = can(me.data, 'reply')

  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversations.detail(conversationId, MESSAGE_PAGE),
    placeholderData: keepPreviousData,
  })

  /** What an agent says or picks is kept for when they come back to this conversation. */
  const remember = (next: Partial<Draft>) => {
    const current = drafts.get(conversationId) ?? { text: '', suggestionId: null, attachment: null }
    const merged = { ...current, ...next }
    if (!merged.text && !merged.attachment) drafts.delete(conversationId)
    else drafts.set(conversationId, merged)
  }
  const setDraft = (next: string | ((current: string) => string)) =>
    setDraftState((current) => {
      const value = typeof next === 'function' ? next(current) : next
      remember({ text: value })
      return value
    })

  /** Somebody who is not already at the bottom is reading history; do not move them. */
  const atBottom = useRef(true)
  const [newBelow, setNewBelow] = useState(false)
  const followNext = useRef(false)
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const scrollToBottom = (instant = false) => {
    bottomRef.current?.scrollIntoView({ behavior: instant || reducedMotion ? 'auto' : 'smooth' })
    setNewBelow(false)
  }
  /** Where the thread was last scrolled to, so only a scroll upwards loads older pages. */
  const lastScrollTop = useRef(0)
  const opened = useRef(false)

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the newest message only
  useEffect(() => {
    if (!newestMessageId) return
    // Following only while they are at the bottom, or right after they sent something.
    // Reading history while a reply arrives used to yank them back down mid-sentence.
    if (!opened.current) {
      // Opening a conversation lands at its end at once. Scrolling there smoothly from the
      // top passed every older-page trigger on the way down and loaded the whole history.
      opened.current = true
      scrollToBottom(true)
    } else if (atBottom.current || followNext.current) {
      followNext.current = false
      scrollToBottom()
    } else {
      setNewBelow(true)
    }
  }, [newestMessageId])

  /**
   * Put the reader back where they were after older messages are added above them.
   *
   * Prepending content moves everything down by however tall it is, so without this the
   * thread jumps and the message they were reading is somewhere off screen.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when an older page lands
  useEffect(() => {
    const thread = threadRef.current
    const previousHeight = restoreScrollRef.current
    if (!thread || previousHeight === null) return
    restoreScrollRef.current = null
    thread.scrollTop = thread.scrollHeight - previousHeight
  }, [older.messages.length])

  const canLoadOlder = olderHasMore === null ? Boolean(detail.data?.hasMoreMessages) : olderHasMore

  const loadOlder = async () => {
    if (!canLoadOlder || loadingOlder) return
    const oldestId = older.messages[0]?.id ?? detail.data?.messages[0]?.id
    if (!oldestId) return
    const thread = threadRef.current
    if (thread) restoreScrollRef.current = thread.scrollHeight
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await api.conversations.older(conversationId, oldestId, MESSAGE_PAGE)
      setOlder((current) => ({
        messages: [...page.messages, ...current.messages],
        notes: [...page.notes, ...current.notes],
      }))
      setOlderHasMore(page.hasMoreMessages)
    } catch (error) {
      restoreScrollRef.current = null
      setOlderError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingOlder(false)
    }
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    void queryClient.invalidateQueries({ queryKey: ['review-count'] })
    // Resolving, reopening, taking over and handing back all move the Inbox badges.
    void queryClient.invalidateQueries({ queryKey: ['inbox-counts'] })
  }

  /**
   * A file waiting to go with the next message.
   *
   * Uploaded as soon as it is chosen rather than on send, so the agent finds out it is too
   * large or the wrong kind while they are still writing, not after they press the button.
   */
  const [attachment, setAttachmentState] = useState<UploadResult | null>(saved?.attachment ?? null)
  const setAttachment = (next: UploadResult | null) => {
    remember({ attachment: next })
    setAttachmentState(next)
  }
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const clearAttachment = () => {
    setAttachment(null)
    setAttachmentError(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const upload = useMutation({
    mutationFn: (file: File) => api.uploads.upload(file),
    onSuccess: (result) => {
      setAttachment(result)
      setAttachmentError(null)
    },
    onError: (caught) =>
      setAttachmentError(caught instanceof Error ? caught.message : String(caught)),
  })

  /**
   * What failed, said beside the thing that failed. Every one of these used to fail in
   * silence: the button went back to normal and nothing had happened.
   */
  const [actionError, setActionError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const failed = (error: unknown) => setActionError(describe(error))

  const send = useMutation({
    mutationFn: ({
      text,
      suggestionId,
      withAttachment,
    }: {
      text: string
      suggestionId?: string
      withAttachment: UploadResult | null
    }) => api.conversations.send(conversationId, messageToSend(text, withAttachment), suggestionId),
    onMutate: () => setSendError(null),
    onSuccess: (_result, sent) => {
      /**
       * Clear only what was sent. The composer stays editable while a reply is in flight,
       * and clearing unconditionally threw away whatever was typed after pressing Send.
       */
      setDraft((current) => (current.trim() === sent.text ? '' : current))
      setInsertedSuggestionId(null)
      if (sent.withAttachment && attachment?.storageKey === sent.withAttachment.storageKey) {
        clearAttachment()
      }
      followNext.current = true
      invalidate()
    },
    onError: (error) => setSendError(describe(error)),
  })

  /** Button, Enter and "insert and send" all come through here, so all three are guarded. */
  const submit = (text: string, suggestionId?: string) => {
    if (send.isPending || upload.isPending) return
    if (!text && !attachment) return
    send.mutate({ text, withAttachment: attachment, ...(suggestionId ? { suggestionId } : {}) })
  }

  /** Something to send: either of a note and a file is enough on its own. */
  const canSend = Boolean(draft.trim() || attachment)

  const rate = useMutation({
    mutationFn: (input: {
      targetType: FeedbackTargetType
      targetId: string
      rating: FeedbackRating
      reason?: FeedbackReason | null
      note?: string | null
    }) => api.conversations.giveFeedback(conversationId, input),
    onSuccess: invalidate,
    onError: failed,
  })

  const unrate = useMutation({
    mutationFn: (feedbackId: string) =>
      api.conversations.removeFeedback(conversationId, feedbackId),
    onSuccess: invalidate,
    onError: failed,
  })

  const resend = useMutation({
    mutationFn: (messageId: string) => api.conversations.resend(conversationId, messageId),
    onSuccess: invalidate,
    onError: failed,
  })

  const markReviewed = useMutation({
    mutationFn: () => api.conversations.markReviewed(conversationId),
    onSuccess: invalidate,
    onError: failed,
  })

  const takeOver = useMutation({
    mutationFn: () => api.conversations.takeOver(conversationId),
    onMutate: () => setActionError(null),
    onSuccess: invalidate,
    onError: failed,
  })

  const returnToAi = useMutation({
    mutationFn: (note: string) => api.conversations.returnToAi(conversationId, note || undefined),
    onMutate: () => setActionError(null),
    // The note is kept until the hand-back succeeds; a failure used to lose it.
    onSuccess: () => {
      setReturnNote('')
      setReturning(false)
      invalidate()
    },
    onError: failed,
  })

  const setStatus = useMutation({
    mutationFn: (status: 'open' | 'resolved') =>
      api.conversations.setStatus(conversationId, status),
    onMutate: () => setActionError(null),
    onSuccess: invalidate,
    onError: failed,
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
  if (!data) {
    // Not found, not allowed, or the request failed: said as such, with a way to try again.
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-6"
        data-testid="conversation-load-failed"
      >
        <ErrorNote
          message={
            detail.error instanceof ApiError &&
            (detail.error.status === 404 || detail.error.status === 403)
              ? t('conversation.notAvailable')
              : t('conversation.loadFailed')
          }
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void detail.refetch()}>
            {t('common.retry')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack}>
            {t('conversation.backToList')}
          </Button>
        </div>
      </div>
    )
  }

  const mode = data.conversation.mode
  const isHumanOwned = mode === 'human'
  const liveIds = new Set(data.messages.map((message) => message.id))
  const threadItems = buildThread({
    messages: [...older.messages.filter((message) => !liveIds.has(message.id)), ...data.messages],
    notes: [
      ...new Map([...older.notes, ...data.notes].map((note) => [note.id, note] as const)).values(),
    ],
    hasMoreMessages: canLoadOlder,
  })

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3">
          <Button
            size="sm"
            variant="ghost"
            className="md:hidden"
            aria-label={t('conversation.backToList')}
            onClick={onBack}
          >
            <Icon name="back" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {data.customer?.displayName ?? t('common.customer')}
              </span>
              {data.channel ? (
                <ChannelBadge
                  type={data.channel.type}
                  label={t(`channels.${data.channel.type}`)}
                  testId="conversation-channel-header"
                />
              ) : null}
              <ModeBadge mode={mode} label={t(`modes.${mode}`)} />
            </div>
            {data.conversation.handoffReason ? (
              <span className="text-[11px] text-[var(--text-muted)]">
                {t('conversation.handoffReason')}:{' '}
                {t(`conversation.handoffReasons.${data.conversation.handoffReason}`)}
              </span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {!canWrite ? null : isHumanOwned ? (
              <Button
                size="sm"
                data-testid="return-to-ai"
                onClick={() => setReturning((open) => !open)}
              >
                {t('conversation.returnToAi')}
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid="take-over"
                variant="primary"
                disabled={takeOver.isPending}
                onClick={() => takeOver.mutate()}
              >
                {t('conversation.takeOver')}
              </Button>
            )}
            {canWrite ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="toggle-status"
                disabled={setStatus.isPending}
                onClick={() =>
                  setStatus.mutate(data.conversation.status === 'resolved' ? 'open' : 'resolved')
                }
              >
                {data.conversation.status === 'resolved'
                  ? t('conversation.reopen')
                  : t('conversation.resolve')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="lg:hidden"
              data-testid="toggle-ai-panel"
              aria-expanded={showSidebar}
              aria-label={t('sidebar.title')}
              onClick={() => setShowSidebar((v) => !v)}
            >
              <Icon name="sparkle" />
            </Button>
          </div>
        </header>

        {actionError ? (
          <div
            className="shrink-0 border-b border-[var(--border)] px-3 py-2"
            data-testid="conversation-action-error"
          >
            <ErrorNote message={actionError} />
          </div>
        ) : null}

        {returning ? (
          /**
           * What to tell the AI on the way back.
           *
           * The string for this existed and nothing collected it: returning always passed
           * an empty note, so whatever the colleague had just sorted out was invisible to
           * the next turn and it could contradict them.
           */
          <div className="shrink-0 space-y-2 border-b border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <Label htmlFor="return-note">{t('conversation.returnNote')}</Label>
            <Textarea
              id="return-note"
              rows={2}
              data-testid="return-note"
              value={returnNote}
              onChange={(event) => setReturnNote(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                data-testid="return-to-ai-confirm"
                disabled={returnToAi.isPending}
                onClick={() => returnToAi.mutate(returnNote.trim())}
              >
                {t('conversation.returnToAi')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReturning(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        <div
          ref={threadRef}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
          data-testid="message-thread"
          onScroll={(event) => {
            const thread = event.currentTarget
            atBottom.current =
              thread.scrollHeight - thread.scrollTop - thread.clientHeight < FOLLOW_THRESHOLD_PX
            if (atBottom.current) setNewBelow(false)
            const goingUp = thread.scrollTop < lastScrollTop.current
            lastScrollTop.current = thread.scrollTop
            // Near the top rather than exactly at it: a thread that only loads at zero never
            // loads at all on a trackpad that stops a pixel short. Only on the way up, which
            // is somebody reaching for history rather than the thread settling.
            if (goingUp && thread.scrollTop < 80 && !olderError) void loadOlder()
          }}
        >
          {olderError ? (
            <div className="flex flex-col items-center gap-1 py-1">
              <ErrorNote message={olderError} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOlderError(null)
                  void loadOlder()
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
          {canLoadOlder ? (
            <div className="flex justify-center py-1">
              <Button
                size="sm"
                variant="ghost"
                data-testid="load-older-messages"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? t('common.loading') : t('conversation.loadOlder')}
              </Button>
            </div>
          ) : null}
          {threadItems.length === 0 ? (
            <EmptyState title={t('conversation.noMessages')} />
          ) : (
            threadItems.map((item, index) => (
              <div key={item.key} className="contents">
                {/* A thread can run for months and every bubble showed only a clock time,
                    so March and this morning were indistinguishable at a glance. */}
                {isNewDay(threadItems[index - 1]?.at ?? null, item.at) ? (
                  <div className="flex justify-center py-1">
                    <span className="rounded-full bg-[var(--surface-muted)] px-2.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                      {dayLabel(item.at, i18n.language)}
                    </span>
                  </div>
                ) : null}

                {item.kind === 'note' ? (
                  <div className="mx-auto max-w-lg rounded-lg border border-dashed border-amber-400 bg-amber-50 px-3 py-1.5 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <span className="font-medium">{t('conversation.internalNote')}: </span>
                    {item.note.body}
                  </div>
                ) : (
                  <Bubble
                    message={item.message}
                    onPromote={
                      canWrite && item.message.direction === 'outbound' && item.message.text
                        ? () => setPromoting(item.message)
                        : undefined
                    }
                    onResend={
                      canWrite && item.message.status === 'failed'
                        ? () => resend.mutate(item.message.id)
                        : undefined
                    }
                    resending={resend.isPending && resend.variables === item.message.id}
                    feedback={{
                      mine: mineFor('message', item.message.id),
                      canWrite,
                      onRate: (rating, reason, note) =>
                        rate.mutate({
                          targetType: 'message',
                          targetId: item.message.id,
                          rating,
                          reason,
                          note,
                        }),
                      onRemove: () => {
                        const mine = mineFor('message', item.message.id)
                        if (mine) unrate.mutate(mine.id)
                      },
                    }}
                  />
                )}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {newBelow ? (
          <div className="pointer-events-none relative">
            <Button
              size="sm"
              variant="primary"
              data-testid="new-messages"
              className="pointer-events-auto absolute bottom-2 left-1/2 -translate-x-1/2 shadow"
              onClick={() => scrollToBottom()}
            >
              {t('conversation.newMessages')}
            </Button>
          </div>
        ) : null}

        {!canWrite ? (
          <p
            className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] p-3 text-center text-[12px] text-[var(--text-muted)]"
            data-testid="read-only-note"
          >
            {t('conversation.readOnly')}
          </p>
        ) : null}
        <footer
          className={cn(
            'shrink-0 border-t border-[var(--border)] bg-[var(--surface)] p-2',
            canWrite ? '' : 'hidden',
            // The panel covers the thread below `lg`, and a Send button floating over
            // somebody's customer record is worse than no Send button at all.
            showSidebar ? 'hidden lg:block' : '',
          )}
        >
          {attachment ? (
            <div
              data-testid="composer-attachment"
              className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--border)] p-1.5 text-[13px]"
            >
              {attachment.mime.startsWith('image/') ? (
                <img
                  src={api.uploads.urlFor(attachment.storageKey)}
                  alt=""
                  className="size-10 rounded object-cover"
                />
              ) : (
                <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px]">
                  {attachment.mime.split('/').pop()}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{attachment.fileName}</span>
              <Button
                size="sm"
                variant="ghost"
                data-testid="remove-attachment"
                aria-label={t('common.remove')}
                onClick={clearAttachment}
              >
                ✕
              </Button>
            </div>
          ) : null}
          {sendError ? (
            <div className="mb-2" data-testid="send-error">
              <ErrorNote message={`${t('conversation.sendFailed')}: ${sendError}`} />
            </div>
          ) : null}
          {attachmentError ? (
            <p
              className="mb-2 text-[13px] text-red-700 dark:text-red-300"
              data-testid="attachment-error"
            >
              {attachmentError}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              data-testid="attachment-input"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) upload.mutate(file)
              }}
            />
            <Button
              variant="secondary"
              data-testid="attach"
              aria-label={t('conversation.attach')}
              title={t('conversation.attach')}
              disabled={upload.isPending || send.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending ? <Spinner /> : <Icon name="attach" />}
            </Button>
            <Textarea
              rows={2}
              data-testid="composer"
              aria-label={t('conversation.placeholder')}
              value={draft}
              placeholder={t('conversation.placeholder')}
              onChange={(e) => {
                const next = expandShortcut(e.target.value)
                setDraft(next)
                // Cleared the box: whatever draft was inserted is no longer what is being sent.
                if (!next.trim()) setInsertedSuggestionId(null)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return
                // Enter that confirms a Thai or Japanese input method's candidate is not a
                // send. It arrives as a keydown with `isComposing` set.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                // Enter used to send whatever was typed even while a file was still
                // uploading, so the note went and the attachment did not.
                if (!canSend) return
                submit(draft.trim(), fromSuggestion().suggestionId)
              }}
            />
            <Button
              variant="primary"
              data-testid="send"
              disabled={!canSend || send.isPending || upload.isPending}
              onClick={() => submit(draft.trim(), fromSuggestion().suggestionId)}
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
        onClose={() => setShowSidebar(false)}
        language={i18n.language}
        canWrite={canWrite}
        feedbackFor={(suggestionId) => mineFor('suggestion', suggestionId)}
        onRefresh={invalidate}
        onInsert={(text, suggestionId) => {
          setDraft(text)
          setInsertedSuggestionId(suggestionId)
          remember({ suggestionId })
        }}
        onInsertAndSend={(text, suggestionId) => submit(text, suggestionId)}
        onDiscard={(suggestionId) => {
          void api.conversations
            .discardSuggestion(conversationId, suggestionId)
            .then(invalidate)
            .catch(failed)
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

/**
 * One item in the thread: a message, or an internal note written at that moment.
 *
 * Notes used to render in a block after every message, so a note written on the first day
 * sat below this morning's reply and read as a comment on it. Interleaving puts each one
 * where it was actually written, which is the only position that explains anything.
 */
type ThreadItem =
  | { kind: 'message'; key: string; at: string; message: Message }
  | { kind: 'note'; key: string; at: string; note: ConversationDetail['notes'][number] }

function buildThread(data: {
  messages: Message[]
  notes: ConversationDetail['notes']
  hasMoreMessages: boolean
}): ThreadItem[] {
  const messages: ThreadItem[] = data.messages.map((message) => ({
    kind: 'message',
    key: `m-${message.id}`,
    at: message.createdAt,
    message,
  }))

  /**
   * Notes are not windowed by the endpoint, but messages are.
   *
   * So a note older than the oldest loaded message has nothing to sit beside: placing it by
   * its timestamp would put it above the first bubble, where it reads as the beginning of
   * the conversation. It is held back until somebody scrolls far enough up for its
   * surroundings to exist. Once the whole thread is loaded, every note is shown.
   */
  const oldestLoaded = data.messages[0]?.createdAt
  const clamp = data.hasMoreMessages && oldestLoaded ? Date.parse(oldestLoaded) : null

  const notes: ThreadItem[] = data.notes
    .filter((note) => clamp === null || Date.parse(note.createdAt) >= clamp)
    .map((note) => ({ kind: 'note', key: `n-${note.id}`, at: note.createdAt, note }))

  return [...messages, ...notes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
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
  onResend,
  resending = false,
  feedback,
}: {
  message: Message
  onPromote?: (() => void) | undefined
  /** Offered on a message whose delivery failed for good, to somebody who may reply. */
  onResend?: (() => void) | undefined
  resending?: boolean
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
            'mt-0.5 flex items-center gap-1.5 text-[11px]',
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
        {isCustomer ? null : (
          <DeliveryProblem
            status={message.status}
            error={message.error}
            onResend={onResend}
            resending={resending}
          />
        )}
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
  onClose,
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
  /** Shut the panel again. Only reachable below `lg`, where it covers the thread. */
  onClose: () => void
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
        /**
         * A panel beside the thread on a wide screen, and the whole screen on a phone.
         *
         * It used to be an in-flow element that simply took the thread's place, which left
         * the composer mounted underneath it: the Send button floated over the customer's
         * details, and the header carrying the only way back scrolled out of reach. Fixed
         * and full-height, with a close button of its own.
         */
        'fixed inset-0 z-30 w-full shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-3',
        'lg:static lg:inset-auto lg:z-auto lg:w-80',
        className,
      )}
      data-testid="ai-panel"
    >
      <div className="sticky -top-3 z-10 -mx-3 -mt-3 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 lg:hidden">
        <span className="text-sm font-semibold">{t('sidebar.title')}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          data-testid="close-ai-panel"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </div>

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

        {/* A fixed label column and a value that wraps. The label used to shrink with the
            value, so a Thai key broke one syllable per line while its value truncated. */}
        <dl className="space-y-1 text-[13px]">
          {Object.entries(detail.customer?.fields ?? {}).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--text-muted)]">{fieldLabel(t, key)}</dt>
              <dd className="min-w-0 flex-1 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        {/* Every channel this person is known on. After a merge, two lines appear here,
            which is the only visible proof that the two records became one. */}
        {detail.identities.length > 0 ? (
          <div className="mt-2">
            <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
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
        {/* What the AI noticed, kept apart from the identifiers above. Those five keys are
            what an agent scans to check they have the right person; these are context. */}
        {Object.entries(detail.customer?.notes ?? {}).length > 0 ? (
          <div className="mt-2">
            <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t('sidebar.aiNoted')}
            </p>
            <dl className="space-y-1 text-[13px]" data-testid="customer-notes">
              {Object.entries(detail.customer?.notes ?? {}).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="w-24 shrink-0 text-[var(--text-muted)]">{key}</dt>
                  <dd className="min-w-0 flex-1 break-words">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        {detail.customer?.summary ? (
          <p className="mt-2 text-[13px] text-[var(--text-muted)]">{detail.customer.summary}</p>
        ) : null}
        <EraseCustomer
          conversationId={detail.conversation.id}
          customerName={detail.customer?.displayName ?? t('common.customer')}
          onErased={onErased}
        />
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
    <Dialog
      label={t('trace.title')}
      onClose={onClose}
      testId="trace-dialog"
      className="flex items-end justify-center bg-black/40 p-4 sm:items-center"
    >
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
    </Dialog>
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
    <Dialog
      label={t('knowledge.saveAsKnowledge')}
      onClose={onClose}
      testId="promote-dialog"
      className="flex items-end justify-center bg-black/40 p-4 sm:items-center"
    >
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
    </Dialog>
  )
}

/**
 * A customer field's name in the reader's language.
 *
 * The five keys the AI may record are a closed set, so they get proper labels. Anything
 * else — a key a summariser invented, or one from before that set existed — is shown as it
 * is rather than guessed at.
 */
function fieldLabel(t: (key: string) => string, key: string): string {
  const known = ['phone', 'email', 'order_id', 'account_id', 'company']
  return known.includes(key) ? t(`sidebar.fields.${key}`) : key
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
                  <dt className="w-24 shrink-0 text-[var(--text-muted)]">{key}</dt>
                  <dd className="min-w-0 flex-1 break-words">{value}</dd>
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
