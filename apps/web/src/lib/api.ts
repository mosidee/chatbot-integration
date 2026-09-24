import type {
  ChannelType,
  ConversationMode,
  ConversationStatus,
  FeedbackRating,
  FeedbackReason,
  FeedbackTargetType,
  HandoffReason,
  HttpToolConfig,
  IdentityProof,
  Language,
  MergeMatchKey,
  NormalizedMessage,
  SenderType,
  ToolSummary,
  UserRoleName,
  WorkspaceStatus,
} from '@ci/shared'

/**
 * Typed API client.
 *
 * A hand-written client over fetch rather than Eden Treaty: Eden infers the whole route
 * tree into the browser build, which makes the frontend typecheck depend on the server's
 * inference and slows it markedly on a route surface this size. The response shapes below
 * are the contract, and the shared package supplies the domain types both sides use.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Keep the status text.
    }

    // A session that expired mid-visit should land on the sign-in page, not on a console
    // full of failed requests.
    if (response.status === 401 && !location.pathname.startsWith('/login')) {
      location.href = '/login'
    }

    throw new ApiError(response.status, message)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
/** A body on a DELETE is unusual and deliberate here: deleting a tenant is confirmed by
 * typing its slug, and the slug belongs in the request rather than in the URL. */
const del = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'DELETE',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ConversationListItem = {
  id: string
  mode: ConversationMode
  status: ConversationStatus
  channelId: string
  /** Which channel this thread is on, for the badge on the row. */
  channel: { type: ChannelType; name: string }
  assigneeUserId: string | null
  tags: string[]
  handoffReason: HandoffReason | null
  unreadCount: number
  lastMessageAt: string | null
  waitingHumanSince: string | null
  customer: { id: string; displayName: string | null; assigneeUserId: string | null }
  lastMessage: { text: string; senderType: SenderType; createdAt: string } | null
}

export type Message = {
  id: string
  conversationId: string
  direction: 'inbound' | 'outbound'
  senderType: SenderType
  senderUserId: string | null
  content: NormalizedMessage
  text: string
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  error: string | null
  aiTraceId: string | null
  createdAt: string
}

export type InternalNote = {
  id: string
  authorType: SenderType
  authorUserId: string | null
  body: string
  createdAt: string
}

export type Suggestion = {
  id: string
  conversationId: string
  messageText: string
  aiTraceId: string | null
  status: 'pending' | 'inserted' | 'sent' | 'discarded'
  sentMessageId: string | null
  createdAt: string
}

/** One side of a proposed merge, with enough detail to judge it without leaving the page. */
export type MergeParty = {
  id: string
  displayName: string | null
  fields: Record<string, string>
  summary: string | null
  identities: { externalId: string; displayName: string | null }[]
  conversations: number
  lastMessageAt: string | null
}

export type MergeSuggestion = {
  id: string
  matchKey: MergeMatchKey
  matchValue: string
  createdAt: string
  /** Keeps its id if a person accepts. */
  survivor: MergeParty | null
  /** Absorbed into the survivor, and then gone. */
  absorbed: MergeParty | null
}

/** What one person thought of one thing the AI wrote. */
export type Feedback = {
  id: string
  conversationId: string
  targetType: FeedbackTargetType
  targetId: string
  userId: string
  rating: FeedbackRating
  reason: FeedbackReason | null
  note: string | null
  createdAt: string
  updatedAt: string
}

export type Customer = {
  id: string
  displayName: string | null
  /** Who looks after this person, across every conversation they start. */
  assigneeUserId?: string | null
  primaryLanguage: Language | null
  /** Identifiers only: phone, email, order id, account id, company. */
  fields: Record<string, string>
  /** Free-form context the summariser noticed. Never an identifier. */
  notes: Record<string, string>
  summary: string | null
}

export type ConversationDetail = {
  conversation: ConversationListItem & {
    customerId: string
    channelIdentityId: string
    handoffNote: string | null
    /** Only the detail carries this: the list projects its columns explicitly. */
    reviewedAt: string | null
  }
  customer: Customer | null
  identity: {
    id: string
    externalId: string
    displayName: string | null
    avatarUrl: string | null
    /** An account a proof carried, as opposed to an identifier the customer typed. */
    verifiedSubject: string | null
    verifiedAttributes: Record<string, string>
    verifiedVia: IdentityProof | null
    verifiedAt: string | null
    /** Whether that proof is still one this workspace accepts. */
    verified: boolean
  } | null
  /** Whether the workspace has a verification link to offer, for the sidebar button. */
  canSendVerificationLink: boolean
  channel: { type: ChannelType; name: string } | null
  messages: Message[]
  /** Whether older messages exist above the window that was returned. */
  hasMoreMessages: boolean
  notes: InternalNote[]
  suggestions: Suggestion[]
  feedback: Feedback[]
  /** Whether this conversation is still waiting to be reviewed. Drives the sidebar button. */
  inReviewQueue: boolean
  /** Every channel this customer is known on, not only the one they are writing from. */
  identities: {
    id: string
    channelId: string
    externalId: string
    displayName: string | null
  }[]
}

export type AiTrace = {
  id: string
  conversationId: string | null
  task: string
  providerName: string | null
  model: string | null
  usedFallback: boolean
  prompt: unknown
  toolCalls: unknown
  retrieved: unknown
  tokensIn: number | null
  tokensOut: number | null
  latencyMs: number | null
  costEstimate: string | null
  outcome: 'sent' | 'draft' | 'handoff' | 'error'
  error: string | null
  createdAt: string
}

export type IdentitySettings = {
  widgetToken: { enabled: boolean }
  verificationLink: {
    enabled: boolean
    url: string | null
    ttlMinutes: number
    /** The secret itself is never returned, only whether one is stored. */
    hasSecret: boolean
  }
}

export type WorkspaceSettings = {
  defaultLanguage: Language
  defaultMode: ConversationMode
  persona: string
  identity: IdentitySettings
  retentionDays: number
  waitingHumanFallbackMinutes: number | null
  autoResolveAfterHours: number | null
  redaction: { cardNumbers: boolean; thaiNationalId: boolean }
  acknowledgementText: Record<string, string>
  stillWaitingText: Record<string, string>
  modelPrices: Record<string, { inputPerMillion: number; outputPerMillion: number }>
  businessHours: {
    timezone: string
    days: Record<string, { open: string; close: string } | undefined>
  }
}

export type ToolTestResult =
  | { ok: true; status: number; durationMs: number; body: unknown }
  | { ok: false; durationMs: number; error: string }

export type Provider = {
  id: string
  name: string
  baseUrl: string
  hasKey: boolean
  supportsTools: boolean
  supportsVision: boolean
  enabled: boolean
}

/** The outcome of calling one model once, from the settings page. */
export type VerifyResult = { ok: true; detail: string } | { ok: false; error: string }

export type TaskSlot = {
  id: string
  task: string
  primaryProviderId: string | null
  primaryModel: string | null
  fallbackProviderId: string | null
  fallbackModel: string | null
  params: Record<string, unknown>
}

export type ChannelField = { key: string; label: string; secret: boolean }

export type Channel = {
  id: string
  type: 'test' | 'web' | 'line' | 'messenger'
  name: string
  enabled: boolean
  defaultMode: ConversationMode | null
  hasConfig: boolean
  webhookUrl: string
  /** Meta asks for this when subscribing a page. Null for other platforms. */
  verifyToken: string | null
  requiredFields: ChannelField[]
  /** Widget channels only: where it may be embedded, and the script to embed. */
  allowedOrigins?: string[]
  embedUrl?: string
}

export type CredentialCheck = {
  ok: boolean
  detail: string
  info?: Record<string, string | number>
}

export type CannedResponse = {
  id: string
  shortcut: string
  language: Language | null
  body: string
}

export type Member = {
  userId: string
  role: UserRoleName
  name: string
  email: string
  image: string | null
  joinedAt?: string
  isSelf?: boolean
}

export type PendingInvitation = {
  id: string
  email: string
  role: string | null
  expiresAt: string
  createdAt: string
  invitedByName: string | null
}

export type Membership = {
  id: string
  name: string
  slug: string
  role: UserRoleName
  status: WorkspaceStatus
}

export type Me = {
  userId: string
  email: string
  name: string
  /** Null when they belong to no workspace at all. */
  role: UserRoleName | null
  workspace: { id: string; name: string; slug: string; status: WorkspaceStatus } | null
  memberships: Membership[]
  platformAdmin: boolean
}

export type Tenant = {
  id: string
  name: string
  slug: string
  status: WorkspaceStatus
  memberCount: number
  privateEgressOrigins: string[]
  createdAt: string
}

export type PlatformAdmin = {
  userId: string
  email: string
  name: string
  grantedByUserId: string | null
  createdAt: string
}

/** What the page behind an invitation link needs before anybody types anything. */
export type InvitationInfo = {
  purpose: 'invite' | 'password_reset'
  email: string
  role: string | null
  workspaceName: string
  existingAccount: boolean
}

export type DashboardDay = {
  day: string
  conversations: number
  customerMessages: number
  answered: number
  handoffs: number
  cost: number
}

export type Dashboard = {
  since: string
  days: DashboardDay[]
  totals: {
    conversations: number
    customerMessages: number
    answered: number
    handoffs: number
    errors: number
    cost: number
    tokensIn: number
    tokensOut: number
  }
  firstResponse: { medianSeconds: number | null; conversations: number }
  handoffWait: { medianSeconds: number | null; events: number; unanswered: number }
  handoffReasons: { reason: string; conversations: number }[]
  channels: { channel: string; type: string; conversations: number }[]
  waitingNow: number
  feedback: { up: number; down: number; reasons: { reason: string; count: number }[] }
  reviewQueueNow: number
}

export type ConversationFilters = {
  status?: ConversationStatus
  mode?: ConversationMode
  channelId?: string
  assigneeUserId?: string
  tag?: string
  /** Only what nobody has reviewed. A literal string: the server refuses anything else. */
  review?: 'true'
  limit?: number
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export type UploadResult = {
  storageKey: string
  url: string
  mime: string
  sizeBytes: number
  fileName: string
}

export type KnowledgeSource = {
  id: string
  kind: 'qa' | 'article' | 'file' | 'url'
  title: string
  status: 'pending' | 'processing' | 'ready' | 'failed'
  error: string | null
  mime: string | null
  byteSize: number | null
  meta: Record<string, unknown>
  createdAt: string
  entryCount: number
  chunkCount: number
}

export type KnowledgeEntry = {
  id: string
  sourceId: string
  language: Language
  question: string | null
  body: string
  tags: string[]
  channelTypes: string[]
  enabled: boolean
}

export type SearchHit = {
  id: string
  sourceId: string
  sourceTitle: string
  text: string
  score: number
  denseScore: number | null
  keywordScore: number | null
}

export type SearchResult = {
  embeddingModel: string | null
  chunks: SearchHit[]
  dense: SearchHit[]
  keyword: SearchHit[]
}

export const api = {
  uploads: {
    /** Stores a file and returns its key; the key is what goes into a message. */
    upload: async (file: File): Promise<UploadResult> => {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch('/api/v1/uploads', {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!response.ok) {
        let message = response.statusText
        try {
          const body = (await response.json()) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // Keep the status text.
        }
        throw new ApiError(response.status, message)
      }
      return (await response.json()) as UploadResult
    },
    /** Same-origin URL the browser can render; access follows the session. */
    urlFor: (storageKey: string) => `/api/v1/uploads/${storageKey}`,
  },

  dashboard: {
    load: (days = 14) => get<Dashboard>(`/v1/dashboard?days=${days}`),
  },

  conversations: {
    list: (filters: ConversationFilters = {}) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== '') params.set(key, String(value))
      }
      const qs = params.toString()
      return get<{ conversations: ConversationListItem[] }>(
        `/v1/conversations${qs ? `?${qs}` : ''}`,
      )
    },
    /** `messages` is how many of the most recent to fetch; the console raises it on scroll. */
    detail: (id: string, messages?: number) =>
      get<ConversationDetail>(
        `/v1/conversations/${id}${messages === undefined ? '' : `?messages=${messages}`}`,
      ),
    send: (id: string, message: NormalizedMessage, suggestionId?: string) =>
      post<{ messageId: string }>(`/v1/conversations/${id}/messages`, { message, suggestionId }),
    takeOver: (id: string) => post<{ mode: ConversationMode }>(`/v1/conversations/${id}/take-over`),
    returnToAi: (id: string, note?: string) =>
      post<{ mode: ConversationMode }>(`/v1/conversations/${id}/return-to-ai`, { note }),
    setMode: (id: string, mode: ConversationMode) =>
      post<{ mode: ConversationMode }>(`/v1/conversations/${id}/mode`, { mode }),
    setStatus: (id: string, status: ConversationStatus) =>
      post<{ status: ConversationStatus }>(`/v1/conversations/${id}/status`, { status }),
    assign: (id: string, userId: string | null) =>
      post<{ assigneeUserId: string | null }>(`/v1/conversations/${id}/assign`, { userId }),
    eraseCustomer: (id: string) =>
      post<{ queued: true; customerId: string }>(`/v1/conversations/${id}/erase-customer`),
    addNote: (id: string, body: string) =>
      post<{ noteId: string }>(`/v1/conversations/${id}/notes`, { body }),
    discardSuggestion: (id: string, suggestionId: string) =>
      post<{ ok: true }>(`/v1/conversations/${id}/suggestions/${suggestionId}/discard`),
    reviewCount: () => get<{ count: number }>('/v1/conversations/review-count'),
    counts: () => get<{ open: number; waiting: number }>('/v1/conversations/counts'),
    markReviewed: (id: string) => post<{ reviewedAt: string }>(`/v1/conversations/${id}/review`),
    sendVerificationLink: (id: string) =>
      post<{ ok: true; messageId: string }>(`/v1/conversations/${id}/verification-link`),
    giveFeedback: (
      id: string,
      input: {
        targetType: FeedbackTargetType
        targetId: string
        rating: FeedbackRating
        reason?: FeedbackReason | null
        note?: string | null
      },
    ) => post<{ feedback: Feedback }>(`/v1/conversations/${id}/feedback`, input),
    removeFeedback: (id: string, feedbackId: string) =>
      del<{ ok: true }>(`/v1/conversations/${id}/feedback/${feedbackId}`),
  },

  customers: {
    /** Hand a customer to a colleague, or take them yourself. Null lets them go. */
    assign: (id: string, assigneeUserId: string | null) =>
      patch<{ assigneeUserId: string | null }>(`/v1/customers/${id}`, { assigneeUserId }),
    mergeSuggestions: (customerId: string) =>
      get<{ suggestions: MergeSuggestion[] }>(`/v1/customers/${customerId}/merge-suggestions`),
    acceptMerge: (customerId: string, suggestionId: string) =>
      post<{ merged: { survivorId: string; absorbedId: string; conversations: number } }>(
        `/v1/customers/${customerId}/merge-suggestions/${suggestionId}/accept`,
      ),
    rejectMerge: (customerId: string, suggestionId: string) =>
      post<{ ok: true }>(`/v1/customers/${customerId}/merge-suggestions/${suggestionId}/reject`),
  },

  simulator: {
    channels: () => get<{ channels: { id: string; name: string }[] }>('/v1/simulator/channels'),
    send: (
      channelId: string,
      payload: { externalId: string; message: NormalizedMessage; displayName?: string },
    ) => post<{ received: boolean }>(`/v1/simulator/${channelId}/inbound`, payload),
  },

  traces: {
    get: (id: string) => get<{ trace: AiTrace }>(`/v1/ai-traces/${id}`),
    list: (conversationId?: string) =>
      get<{ traces: AiTrace[] }>(
        `/v1/ai-traces${conversationId ? `?conversationId=${conversationId}` : ''}`,
      ),
  },

  knowledge: {
    sources: () => get<{ sources: KnowledgeSource[] }>('/v1/knowledge/sources'),
    createSource: (body: {
      title: string
      language: Language
      question?: string | null
      body: string
      tags?: string[]
      channelTypes?: string[]
    }) => post<{ sourceId: string }>('/v1/knowledge/sources', body),
    uploadFile: async (file: File): Promise<{ sourceId: string }> => {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch('/api/v1/knowledge/sources/file', {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!response.ok) {
        let message = response.statusText
        try {
          const body = (await response.json()) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // Keep the status text.
        }
        throw new ApiError(response.status, message)
      }
      return (await response.json()) as { sourceId: string }
    },
    entries: (sourceId: string) =>
      get<{ entries: KnowledgeEntry[] }>(`/v1/knowledge/sources/${sourceId}/entries`),
    updateEntry: (id: string, body: Record<string, unknown>) =>
      patch<{ ok: true }>(`/v1/knowledge/entries/${id}`, body),
    reindex: (sourceId: string) => post<{ ok: true }>(`/v1/knowledge/sources/${sourceId}/reindex`),
    deleteSource: (sourceId: string) => del<{ ok: true }>(`/v1/knowledge/sources/${sourceId}`),
    search: (body: { query: string; language?: Language | null; limit?: number }) =>
      post<SearchResult>('/v1/knowledge/search', body),
    fromMessage: (body: {
      messageId: string
      title: string
      question: string
      body: string
      language: Language
    }) => post<{ sourceId: string }>('/v1/knowledge/from-message', body),
  },

  settings: {
    workspace: () => get<{ settings: WorkspaceSettings }>('/v1/settings/workspace'),
    me: () => get<Me>('/v1/settings/me'),
    updateWorkspace: (patchBody: Partial<WorkspaceSettings>) =>
      patch<{ settings: WorkspaceSettings }>('/v1/settings/workspace', patchBody),
    providers: () => get<{ providers: Provider[] }>('/v1/settings/providers'),
    createProvider: (body: {
      name: string
      baseUrl: string
      apiKey?: string
      supportsTools?: boolean
      supportsVision?: boolean
    }) => post<{ id: string }>('/v1/settings/providers', body),
    updateProvider: (id: string, body: Record<string, unknown>) =>
      patch<{ ok: true }>(`/v1/settings/providers/${id}`, body),
    deleteProvider: (id: string) => del<{ ok: true }>(`/v1/settings/providers/${id}`),
    providerModels: (id: string) =>
      post<{ models: string[]; error?: string }>(`/v1/settings/providers/${id}/models`),
    verifyModel: (id: string, body: { model: string; task: string; sendDimensions?: boolean }) =>
      post<VerifyResult>(`/v1/settings/providers/${id}/verify-model`, body),
    taskSlots: () => get<{ slots: TaskSlot[] }>('/v1/settings/task-slots'),
    setTaskSlot: (task: string, body: Record<string, unknown>) =>
      put<{ ok: true }>(`/v1/settings/task-slots/${task}`, body),
    channels: () => get<{ channels: Channel[] }>('/v1/settings/channels'),
    createChannel: (body: {
      type: Channel['type']
      name: string
      config?: Record<string, unknown>
    }) => post<{ id: string }>('/v1/settings/channels', body),
    updateChannel: (id: string, body: Record<string, unknown>) =>
      patch<{ ok: true }>(`/v1/settings/channels/${id}`, body),
    checkChannel: (id: string) => post<CredentialCheck>(`/v1/settings/channels/${id}/check`),
    members: () => get<{ members: Member[] }>('/v1/settings/members'),
    cannedResponses: () => get<{ responses: CannedResponse[] }>('/v1/settings/canned-responses'),
    createCannedResponse: (body: { shortcut: string; body: string; language?: Language | null }) =>
      post<{ id: string }>('/v1/settings/canned-responses', body),
    deleteCannedResponse: (id: string) => del<{ ok: true }>(`/v1/settings/canned-responses/${id}`),

    tools: () => get<{ tools: ToolSummary[] }>('/v1/settings/tools'),
    createTool: (body: {
      name: string
      description: string
      config: HttpToolConfig
      credential?: string
      enabled?: boolean
    }) => post<{ id: string }>('/v1/settings/tools', body),
    updateTool: (id: string, body: Record<string, unknown>) =>
      patch<{ ok: true }>(`/v1/settings/tools/${id}`, body),
    deleteTool: (id: string) => del<{ ok: true }>(`/v1/settings/tools/${id}`),
    testTool: (id: string, body: { args?: Record<string, unknown>; subject?: string }) =>
      post<ToolTestResult>(`/v1/settings/tools/${id}/test`, body),
  },

  /** People in this workspace. Admin-only on the server; the console hides it too. */
  admin: {
    members: () =>
      get<{ members: Member[]; invitations: PendingInvitation[] }>('/v1/admin/members'),
    updateMember: (userId: string, body: { role?: UserRoleName; name?: string }) =>
      patch<{ ok: true }>(`/v1/admin/members/${userId}`, body),
    removeMember: (userId: string) => del<{ ok: true }>(`/v1/admin/members/${userId}`),
    createInvitation: (body: { email: string; role: UserRoleName }) =>
      post<{ id: string; link: string; expiresAt: string; existingAccount: boolean }>(
        '/v1/admin/invitations',
        body,
      ),
    revokeInvitation: (id: string) => del<{ ok: true }>(`/v1/admin/invitations/${id}`),
    resetLink: (userId: string) =>
      post<{ link: string; expiresAt: string }>(`/v1/admin/members/${userId}/reset-link`),
  },

  /** The tenants themselves. Only a platform admin sees any of this. */
  platform: {
    tenants: () => get<{ tenants: Tenant[] }>('/v1/platform/tenants'),
    createTenant: (body: { name: string; slug: string; adminEmail: string }) =>
      post<{ id: string; inviteLink: string; inviteExpiresAt: string }>(
        '/v1/platform/tenants',
        body,
      ),
    updateTenant: (
      id: string,
      body: { name?: string; slug?: string; privateEgressOrigins?: string[] },
    ) => patch<{ ok: true }>(`/v1/platform/tenants/${id}`, body),
    suspend: (id: string) => post<{ status: string }>(`/v1/platform/tenants/${id}/suspend`),
    unsuspend: (id: string) => post<{ status: string }>(`/v1/platform/tenants/${id}/unsuspend`),
    deleteTenant: (id: string, slug: string) =>
      del<{ queued: true }>(`/v1/platform/tenants/${id}`, { slug }),
    admins: () => get<{ admins: PlatformAdmin[] }>('/v1/platform/admins'),
    grantAdmin: (email: string) => post<{ userId: string }>('/v1/platform/admins', { email }),
    revokeAdmin: (userId: string) => del<{ ok: true }>(`/v1/platform/admins/${userId}`),
    /** For the accounts `/admin` refuses: anyone in more than one tenant, or a platform admin. */
    resetLink: (email: string) =>
      post<{ link: string; expiresAt: string }>('/v1/platform/users/reset-link', { email }),
  },

  /** Public: the caller may have no account yet, which is the whole point. */
  invitations: {
    get: (token: string) => get<InvitationInfo>(`/invitations/${token}`),
    accept: (token: string, body: { name?: string; password?: string }) =>
      post<{ workspaceId: string; userId: string }>(`/invitations/${token}/accept`, body),
  },

  auth: {
    /** Null when nobody is signed in. Used by the route guard, so it must never throw. */
    session: async (): Promise<{
      user: { id: string; name: string; email: string; image: string | null }
    } | null> => {
      try {
        const response = await fetch('/api/auth/get-session', { credentials: 'include' })
        if (!response.ok) return null
        const body = (await response.json()) as {
          user?: { id: string; name: string; email: string; image: string | null }
        } | null
        return body?.user ? { user: body.user } : null
      } catch {
        return null
      }
    },
    signIn: (email: string, password: string) =>
      post<{ user: { id: string } }>('/auth/sign-in/email', { email, password }),
    signOut: () => post<unknown>('/auth/sign-out'),
    /**
     * Choose which workspace this session is about.
     *
     * Better Auth's own endpoint: it checks the membership and re-issues the session
     * cookie. Nothing wrote this field before multi-workspace existed, so a person in two
     * tenants landed in whichever one the database returned first.
     */
    setActiveWorkspace: (organizationId: string) =>
      post<unknown>('/auth/organization/set-active', { organizationId }),
  },
}
