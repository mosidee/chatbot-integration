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
 */

const POLL_MS = 3000
const VISITOR_KEY = 'chat-widget:visitor'

type WidgetMessage = { id: string; from: 'you' | 'support'; text: string; at: string }

const params = new URLSearchParams(location.search)
const channel = params.get('channel') ?? ''
const token = params.get('token')
const colour = params.get('colour')
if (colour) document.documentElement.style.setProperty('--accent', colour)

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
    </div>
    <p class="error" id="error" hidden></p>
    <form class="composer" id="composer">
      <input id="text" autocomplete="off" placeholder="พิมพ์ข้อความ..." aria-label="ข้อความ" />
      <button type="submit" id="send">ส่ง</button>
    </form>
  </div>
`

const thread = document.getElementById('thread') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement
const errorLine = document.getElementById('error') as HTMLElement
const form = document.getElementById('composer') as HTMLFormElement
const input = document.getElementById('text') as HTMLInputElement
const send = document.getElementById('send') as HTMLButtonElement

document.getElementById('close')?.addEventListener('click', () => {
  parent.postMessage({ type: 'chat-widget:close' }, '*')
})

let session: string | null = null
let since: string | null = null
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

function append(message: WidgetMessage, optimistic = false): void {
  if (seen.has(message.id)) return
  seen.add(message.id)

  // The stored copy of something already on screen: adopt the bubble already drawn rather
  // than drawing a second one.
  if (!optimistic && message.from === 'you') {
    const already = takePending(message.text)
    if (already) return
  }

  hint.hidden = true

  const bubble = document.createElement('div')
  bubble.className = `bubble ${message.from}`
  bubble.dataset.from = message.from
  bubble.textContent = message.text
  thread.append(bubble)
  thread.scrollTop = thread.scrollHeight

  if (optimistic) {
    const waiting = pending.get(message.text) ?? []
    waiting.push(bubble)
    pending.set(message.text, waiting)
  }
}

async function startSession(): Promise<void> {
  const response = await fetch(`/api/widget/${channel}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: visitorId(), ...(token ? { token } : {}) }),
  })
  if (!response.ok) throw new Error('session')
  session = ((await response.json()) as { session: string }).session
}

async function poll(): Promise<void> {
  if (!session) return
  const url = new URL(`/api/widget/${channel}/messages`, location.origin)
  if (since) url.searchParams.set('since', since)

  const response = await fetch(url, { headers: { 'x-widget-session': session } })
  if (response.status === 401) {
    // The session expired while the widget sat open. Start a new one rather than going
    // quiet, which from the customer's side looks like the chat broke.
    session = null
    await startSession()
    return
  }
  if (!response.ok) return

  const body = (await response.json()) as { messages: WidgetMessage[] }
  for (const message of body.messages) {
    append(message)
    since = message.at
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text || !session) return

  input.value = ''
  send.disabled = true
  showError(null)

  // Shown immediately with a temporary id. The poll will bring back the stored copy, and
  // `seen` keeps it from appearing twice.
  append(
    { id: `local-${crypto.randomUUID()}`, from: 'you', text, at: new Date().toISOString() },
    true,
  )

  try {
    const response = await fetch(`/api/widget/${channel}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-widget-session': session },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) throw new Error('send')
    await poll()
  } catch {
    // Remove the bubble that was drawn optimistically: leaving it would tell the customer
    // their message was sent when it was not.
    takePending(text)?.remove()
    input.value = text
    showError('ส่งไม่สำเร็จ กรุณาลองอีกครั้ง')
  } finally {
    send.disabled = false
    input.focus()
  }
})

async function main(): Promise<void> {
  if (!channel) {
    showError('ยังไม่ได้ตั้งค่าแชท')
    return
  }
  try {
    await startSession()
    await poll()
    setInterval(() => void poll().catch(() => {}), POLL_MS)
  } catch {
    showError('เชื่อมต่อไม่สำเร็จ')
  }
}

void main()
