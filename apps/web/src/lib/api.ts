import type {
  ConversationMode,
  ConversationStatus,
  HandoffReason,
  Language,
  NormalizedMessage,
  SenderType,
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
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ConversationListItem = {
  id: string
  mode: ConversationMode
  status: ConversationStatus
  channelId: string
  assigneeUserId: string | null
  tags: string[]
  handoffReason: HandoffReason | null
  unreadCount: number
  lastMessageAt: string | null
  waitingHumanSince: string | null
  customer: { id: string; displayName: string | null }
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
  createdAt: string
}

export type Customer = {
  id: string
  displayName: string | null
  primaryLanguage: Language | null
  fields: Record<string, string>
  summary: string | null
}

export type ConversationDetail = {
  conversation: ConversationListItem & {
    customerId: string
    channelIdentityId: string
    handoffNote: string | null
  }
  customer: Customer | null
  identity: {
    id: string
    externalId: string
    displayName: string | null
    avatarUrl: string | null
  } | null
  messages: Message[]
  notes: InternalNote[]
  suggestions: Suggestion[]
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

export type WorkspaceSettings = {
  defaultLanguage: Language
  defaultMode: ConversationMode
  persona: string
  retentionDays: number
  waitingHumanFallbackMinutes: number | null
  redaction: { cardNumbers: boolean; thaiNationalId: boolean }
  acknowledgementText: Record<string, string>
  modelPrices: Record<string, { inputPerMillion: number; outputPerMillion: number }>
  businessHours: {
    timezone: string
    days: Record<string, { open: string; close: string } | undefined>
  }
}

export type Provider = {
  id: string
  name: string
  baseUrl: string
  hasKey: boolean
  supportsTools: boolean
  supportsVision: boolean
  enabled: boolean
}

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
  role: string
  name: string
  email: string
  image: string | null
}

export type ConversationFilters = {
  status?: ConversationStatus
  mode?: ConversationMode
  channelId?: string
  assigneeUserId?: string
  tag?: string
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
    detail: (id: string) => get<ConversationDetail>(`/v1/conversations/${id}`),
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
    addNote: (id: string, body: string) =>
      post<{ noteId: string }>(`/v1/conversations/${id}/notes`, { body }),
    discardSuggestion: (id: string, suggestionId: string) =>
      post<{ ok: true }>(`/v1/conversations/${id}/suggestions/${suggestionId}/discard`),
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
  },

  auth: {
    session: () =>
      get<{ user: { id: string; name: string; email: string; image: string | null } } | null>(
        '/auth/get-session',
      ),
    signIn: (email: string, password: string) =>
      post<{ user: { id: string } }>('/auth/sign-in/email', { email, password }),
    signOut: () => post<unknown>('/auth/sign-out'),
  },
}
