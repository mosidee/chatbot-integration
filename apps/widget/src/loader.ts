/**
 * The script a host application embeds.
 *
 * ```html
 * <script src="https://chat.example.com/widget/loader.js"
 *         data-channel="<channel id>"
 *         data-token="<optional signed visitor token>"
 *         data-colour="#2563eb"
 *         defer></script>
 * ```
 *
 * It creates a launcher and an iframe and does nothing else. Everything a customer types
 * lives inside the iframe, on our origin, which is what keeps the host page unable to read
 * the conversation and keeps us unable to read the host page. It also means the widget's
 * own requests are same-origin, so there is no cross-origin story to get wrong.
 */

type Settings = {
  channel: string
  token: string | null
  colour: string
  title: string
  origin: string
}

function readSettings(): Settings | null {
  const script = document.currentScript as HTMLScriptElement | null
  if (!script) return null
  const channel = script.dataset.channel
  if (!channel) {
    console.error('[chat widget] data-channel is required')
    return null
  }
  return {
    channel,
    token: script.dataset.token ?? null,
    colour: script.dataset.colour ?? '#2563eb',
    title: script.dataset.title ?? 'แชทกับเรา',
    origin: new URL(script.src).origin,
  }
}

function mount(settings: Settings): void {
  const frameUrl = new URL('/widget/index.html', settings.origin)
  frameUrl.searchParams.set('channel', settings.channel)
  frameUrl.searchParams.set('colour', settings.colour)
  if (settings.token) frameUrl.searchParams.set('token', settings.token)

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483000'

  const frame = document.createElement('iframe')
  frame.title = settings.title
  frame.src = frameUrl.toString()
  frame.style.cssText = [
    'width:min(380px,calc(100vw - 32px))',
    'height:min(560px,calc(100vh - 120px))',
    'border:0',
    'border-radius:16px',
    'box-shadow:0 12px 40px rgba(0,0,0,.18)',
    'background:#fff',
    'display:none',
  ].join(';')

  const launcher = document.createElement('button')
  launcher.type = 'button'
  launcher.setAttribute('aria-label', settings.title)
  launcher.textContent = '💬'
  launcher.style.cssText = [
    'margin-left:auto',
    'display:block',
    'width:56px',
    'height:56px',
    'margin-top:12px',
    'border:0',
    'border-radius:28px',
    'cursor:pointer',
    'font-size:24px',
    'color:#fff',
    `background:${settings.colour}`,
    'box-shadow:0 6px 20px rgba(0,0,0,.2)',
  ].join(';')

  let open = false
  const toggle = () => {
    open = !open
    frame.style.display = open ? 'block' : 'none'
    launcher.textContent = open ? '✕' : '💬'
  }
  launcher.addEventListener('click', toggle)

  // The chat app asks to be closed when a customer presses its own close button, so the
  // launcher and the frame cannot disagree about whether it is open.
  window.addEventListener('message', (event) => {
    if (event.origin !== settings.origin) return
    if ((event.data as { type?: string })?.type === 'chat-widget:close' && open) toggle()
  })

  host.append(frame, launcher)
  document.body.append(host)
}

const settings = readSettings()
if (settings) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(settings))
  } else {
    mount(settings)
  }
}
