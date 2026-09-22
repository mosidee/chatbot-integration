import './styles.css'

/**
 * The chat itself, inside the iframe.
 *
 * No framework and no state library: a thread, a box and a poll. The whole point of this
 * file is that it loads before a customer has decided whether to type anything, so its
 * size is a feature.
 *
 * Messages are polled rather than pushed. The console keeps a socket because an agent has
 * it open all day; a widget is open for a few minutes, and a poll survives every corporate
 * proxy without a reconnection story to get wrong.
 *
 * What it must never do is look alive when it is not. A visitor has no inbox to check back
 * in, no email telling them a reply arrived, and no way to tell a thinking machine from a
 * broken one — so every state the server knows about is shown here, and a failure says so
 * rather than leaving the thread sitting there.
 */

const POLL_MS = 3000
const VISITOR_KEY = 'chat-widget:visitor'

/**
 * How long a "typing" indicator is allowed to stand on its own.
 *
 * A turn that takes longer than this has almost certainly failed in a way that produced no
 * message, and three dots pulsing forever is a worse lie than silence: it says an answer is
 * seconds away for as long as the page is open.
 */
const TYPING_MAX_MS = 60_000

/** Failed polls in a row before the visitor is told the connection is the problem. */
const OFFLINE_AFTER = 2

type WidgetState = 'ai' | 'waiting' | 'human'
type WidgetAttachment = { url: string; mime: string; fileName: string | null }
type WidgetMessage = {
  id: string
  from: 'you' | 'support'
  /** Who wrote it. Absent from an API older than this bundle, which `from` still covers. */
  sender?: 'you' | 'ai' | 'agent' | 'system'
  text: string
  at: string
  attachments?: WidgetAttachment[]
}
type PollResponse = {
  messages: WidgetMessage[]
  conversationId: string | null
  state?: WidgetState
  stateText?: string | null
}

const params = new URLSearchParams(location.search)
const channel = params.get('channel') ?? ''
const token = params.get('token')
const colour = params.get('colour')
if (colour) applyAccent(colour)

/**
 * The brand colour, and a foreground that can be read on top of it.
 *
 * A tenant picks the colour from their own site, where it sits behind dark text; here it
 * sits behind white. A pale brand made every bubble the customer sent unreadable, so the
 * foreground is computed rather than assumed.
 */
function applyAccent(value: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return
  const channels = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
  // Relative luminance, the WCAG definition.
  const [r, g, b] = channels.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  document.documentElement.style.setProperty('--accent', value)
  document.documentElement.style.setProperty(
    '--accent-fg',
    luminance > 0.45 ? '#111827' : '#ffffff',
  )
}

/** Stable across reloads so a customer who refreshes keeps their conversation. */
function visitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_KEY)
    if (existing) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(VISITOR_KEY, created)
    return created
  } catch {
    // Private browsing or blocked storage: a per-load id still works, it just will not
    // survive a refresh.
    return crypto.randomUUID()
  }
}

const root = document.getElementById('root') as HTMLElement
root.innerHTML = `
  <div class="shell">
    <div class="header">
      <span>ช่วยเหลือ</span>
      <button type="button" id="close" aria-label="ปิด">✕</button>
    </div>
    <div class="thread" id="thread" role="log" aria-live="polite">
      <p class="hint" id="hint">สวัสดีค่ะ พิมพ์คำถามได้เลยนะคะ</p>
      <div class="typing" id="typing" hidden aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
    <p class="state" id="state" hidden role="status"></p>
    <p class="error" id="error" hidden role="alert"></p>
    <form class="composer" id="composer">
      <textarea id="text" rows="1" maxlength="4000" autocomplete="off" placeholder="พิมพ์ข้อความ..." aria-label="ข้อความ"></textarea>
      <button type="submit" id="send">ส่ง</button>
    </form>
  </div>
`

const thread = document.getElementById('thread') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement
const typing = document.getElementById('typing') as HTMLElement
const stateLine = document.getElementById('state') as HTMLElement
const errorLine = document.getElementById('error') as HTMLElement
const form = document.getElementById('composer') as HTMLFormElement
const input = document.getElementById('text') as HTMLTextAreaElement
const send = document.getElementById('send') as HTMLButtonElement

function close(): void {
  parent.postMessage({ type: 'chat-widget:close' }, '*')
}

document.getElementById('close')?.addEventListener('click', close)
// Escape closes it, the way every other dialog on the web does.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close()
})

let session: string | null = null
let since: string | null = null
let state: WidgetState = 'ai'
let awaitingReplySince: number | null = null
let failedPolls = 0
/** Set when the chat cannot work at all, so nothing re-enables the box behind it. */
let shutDown = false
let unread = 0
const seen = new Set<string>()

/**
 * Bubbles shown before the server confirmed them, kept by their text.
 *
 * A message is drawn the moment it is typed, so the widget feels immediate, and the poll
 * then brings back the stored copy with a different id. Without this the customer sees
 * everything they said twice.
 */
const pending = new Map<string, HTMLElement[]>()

function takePending(text: string): HTMLElement | null {
  const waiting = pending.get(text)
  const bubble = waiting?.shift() ?? null
  if (waiting && waiting.length === 0) pending.delete(text)
  return bubble
}

function showError(message: string | null): void {
  errorLine.textContent = message ?? ''
  errorLine.hidden = message === null
}

/** Stop taking messages nobody will answer, and say why. */
function shutDownWith(message: string): void {
  shutDown = true
  showError(message)
  input.disabled = true
  send.disabled = true
  setTyping(false)
}

function setTyping(on: boolean): void {
  typing.hidden = !on
  if (on) thread.scrollTop = thread.scrollHeight
}

/**
 * What the widget says about who is answering.
 *
 * The words come from the server, in the tenant's language. This file decides only when to
 * show them, which is whenever somebody other than the AI is on the other end.
 */
function setState(next: WidgetState, text: string | null): void {
  state = next
  stateLine.textContent = text ?? ''
  stateLine.hidden = !text
}

function append(message: WidgetMessage, optimistic = false): void {
  if (seen.has(message.id)) return
  seen.add(message.id)

  // The stored copy of something already on screen: adopt the bubble already drawn rather
  // than drawing a second one.
  if (!optimistic && message.from === 'you') {
    const already = takePending(message.text)
    if (already) {
      already.classList.remove('pending')
      return
    }
  }

  hint.hidden = true

  const bubble = document.createElement('div')
  const sender = message.sender ?? message.from
  bubble.className = `bubble ${message.from}${sender === 'system' ? ' system' : ''}`
  bubble.dataset.from = message.from
  bubble.dataset.sender = sender
  if (optimistic) bubble.classList.add('pending')
  // textContent, never innerHTML: everything here came from somebody typing.
  if (message.text) bubble.textContent = message.text

  /**
   * A file an agent sent. An image is shown; anything else is a link to open, because a
   * widget in somebody's page is the wrong place to start a download nobody asked for.
   */
  for (const attachment of message.attachments ?? []) {
    if (attachment.mime.startsWith('image/')) {
      const image = document.createElement('img')
      image.src = attachment.url
      image.alt = attachment.fileName ?? ''
      image.className = 'attachment'
      // Wrapped in a link: a screenshot of an error, which is what customers send, is
      // unreadable at the width of this card.
      const open = document.createElement('a')
      open.href = attachment.url
      open.target = '_blank'
      open.rel = 'noopener noreferrer'
      open.append(image)
      bubble.append(open)
      continue
    }

    const link = document.createElement('a')
    link.href = attachment.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.className = 'attachment-file'
    link.textContent = attachment.fileName ?? attachment.mime
    bubble.append(link)
  }

  // The indicator belongs at the end of the thread, under whatever just arrived.
  thread.insertBefore(bubble, typing)
  thread.scrollTop = thread.scrollHeight

  if (optimistic) {
    const waiting = pending.get(message.text) ?? []
    waiting.push(bubble)
    pending.set(message.text, waiting)
  }

  /**
   * A reply that arrived while nobody was looking.
   *
   * The iframe goes on polling while the launcher is closed, so without this a customer
   * who tabbed away never learns their answer came. The loader draws the count.
   */
  if (message.from === 'support' && !optimistic && (document.hidden || !visible)) {
    unread += 1
    parent.postMessage({ type: 'chat-widget:unread', count: unread }, '*')
  }
}

async function startSession(): Promise<void> {
  const response = await fetch(`/api/widget/${channel}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: visitorId(), ...(token ? { token } : {}) }),
  })
  if (!response.ok) {
    if (await handleRefusal(response)) return
    throw new Error('session')
  }
  session = ((await response.json()) as { session: string }).session
}

/**
 * A refusal the customer has to be told about, as opposed to one worth retrying.
 *
 * A suspended tenant and a channel that no longer exists are both permanent as far as this
 * page is concerned. Before this the widget ignored every non-OK response but 401, so a
 * suspended workspace looked exactly like a quiet one and the visitor kept typing into it.
 */
async function handleRefusal(response: Response): Promise<boolean> {
  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { code?: string }
    shutDownWith(
      body.code === 'workspace_suspended' ? 'ระบบแชทปิดให้บริการชั่วคราว' : 'ไม่สามารถใช้งานแชทจากหน้านี้ได้',
    )
    return true
  }
  if (response.status === 404) {
    shutDownWith('ยังไม่ได้ตั้งค่าแชท')
    return true
  }
  return false
}

async function poll(): Promise<void> {
  if (!session || shutDown) return
  const url = new URL(`/api/widget/${channel}/messages`, location.origin)
  if (since) url.searchParams.set('since', since)

  let response: Response
  try {
    response = await fetch(url, { headers: { 'x-widget-session': session } })
  } catch {
    // The network, not the server. Only worth mentioning once it has happened twice:
    // a single dropped poll on a phone changing cell is not news.
    failedPolls += 1
    if (failedPolls >= OFFLINE_AFTER) showError('ออฟไลน์ กำลังเชื่อมต่อใหม่...')
    return
  }

  if (response.status === 401) {
    // The session expired while the widget sat open. Start a new one rather than going
    // quiet, which from the customer's side looks like the chat broke.
    session = null
    await startSession()
    return
  }
  if (!response.ok) {
    if (await handleRefusal(response)) return
    failedPolls += 1
    if (failedPolls >= OFFLINE_AFTER) showError('ออฟไลน์ กำลังเชื่อมต่อใหม่...')
    return
  }

  if (failedPolls > 0) {
    failedPolls = 0
    showError(null)
  }

  const body = (await response.json()) as PollResponse
  for (const message of body.messages) {
    append(message)
    since = message.at
    if (message.from === 'support') awaitingReplySince = null
  }

  setState(body.state ?? 'ai', body.stateText ?? null)

  /**
   * Three dots only while an answer is actually owed.
   *
   * Owed means: the customer spoke last, the AI is the one answering, and it has not been
   * so long that something has clearly gone wrong. Once a person has been fetched the
   * state line says so instead, because a colleague may be minutes away and dots would
   * promise seconds.
   */
  const waited = awaitingReplySince === null ? 0 : Date.now() - awaitingReplySince
  setTyping(awaitingReplySince !== null && state === 'ai' && waited < TYPING_MAX_MS)
}

/** Grow with what is typed, up to a few lines. A one-line box hides a long question. */
function autogrow(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`
}

input.addEventListener('input', autogrow)
input.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter is a new line: what every chat on the web does.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    form.requestSubmit()
  }
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text || !session || shutDown) return

  input.value = ''
  autogrow()
  send.disabled = true
  showError(null)

  // Shown immediately with a temporary id. The poll will bring back the stored copy, and
  // `seen` keeps it from appearing twice.
  append(
    { id: `local-${crypto.randomUUID()}`, from: 'you', text, at: new Date().toISOString() },
    true,
  )
  awaitingReplySince = Date.now()
  if (state === 'ai') setTyping(true)

  try {
    const response = await fetch(`/api/widget/${channel}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-widget-session': session },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      if (await handleRefusal(response)) return
      throw new Error('send')
    }
    await poll()
  } catch {
    // Remove the bubble that was drawn optimistically: leaving it would tell the customer
    // their message was sent when it was not.
    takePending(text)?.remove()
    input.value = text
    autogrow()
    awaitingReplySince = null
    setTyping(false)
    showError('ส่งไม่สำเร็จ กรุณาลองอีกครั้ง')
  } finally {
    if (!shutDown) {
      send.disabled = false
      input.focus()
    }
  }
})

/**
 * Whether the launcher is open, as the parent understands it.
 *
 * The iframe is hidden rather than unloaded when the launcher closes, so it cannot tell
 * from its own document alone. The parent says, and the answer decides whether an arriving
 * reply counts as unread.
 */
let visible = true

window.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null
  if (data?.type === 'chat-widget:open') {
    visible = true
    unread = 0
    if (!shutDown) input.focus()
    thread.scrollTop = thread.scrollHeight
  }
  if (data?.type === 'chat-widget:hidden') visible = false
})

async function main(): Promise<void> {
  if (!channel) {
    shutDownWith('ยังไม่ได้ตั้งค่าแชท')
    return
  }

  /**
   * Keep trying, with the box shut until there is somewhere for a message to go.
   *
   * A session that failed once used to leave the widget looking ready: the customer typed,
   * pressed send, and the handler returned without them because `session` was null.
   */
  input.disabled = true
  send.disabled = true
  for (let attempt = 0; attempt < 5 && !session && !shutDown; attempt += 1) {
    try {
      await startSession()
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
    }
  }

  if (shutDown) return
  if (!session) {
    shutDownWith('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
    return
  }

  input.disabled = false
  send.disabled = false
  await poll()
  setInterval(() => void poll().catch(() => {}), POLL_MS)
}

void main()
