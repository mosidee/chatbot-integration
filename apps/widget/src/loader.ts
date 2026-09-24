/**
 * The script a host application embeds.
 *
 * ```html
 * <script src="https://chat.example.com/widget/loader.js"
 *         data-channel="<channel id>"
 *         data-token="<optional signed visitor token>"
 *         data-colour="#2563eb"
 *         data-lang="th"
 *         defer></script>
 * ```
 *
 * It creates a launcher and an iframe and does nothing else. Everything a customer types
 * lives inside the iframe, on our origin, which is what keeps the host page unable to read
 * the conversation and keeps us unable to read the host page. It also means the widget's
 * own requests are same-origin, so there is no cross-origin story to get wrong.
 */

import { launcherTextOn } from './launcher-colour'

type Settings = {
  channel: string
  token: string | null
  colour: string
  title: string
  origin: string
  /** `th` or `en`; the chat's own words. Omitted, the workspace's language is used. */
  lang: string | null
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
    title: script.dataset.title ?? (script.dataset.lang === 'en' ? 'Chat with us' : 'แชทกับเรา'),
    origin: new URL(script.src).origin,
    lang: script.dataset.lang === 'en' || script.dataset.lang === 'th' ? script.dataset.lang : null,
  }
}

const OPEN_KEY = 'chat-widget:open'

/** Is this a phone? Asked live, because a tablet rotates and a desktop window resizes. */
const phone = () => window.matchMedia('(max-width: 480px)').matches

function mount(settings: Settings): void {
  const frameUrl = new URL('/widget/index.html', settings.origin)
  frameUrl.searchParams.set('channel', settings.channel)
  frameUrl.searchParams.set('colour', settings.colour)
  if (settings.token) frameUrl.searchParams.set('token', settings.token)
  if (settings.lang) frameUrl.searchParams.set('lang', settings.lang)

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483000'

  const frame = document.createElement('iframe')
  frame.title = settings.title
  frame.src = frameUrl.toString()

  /**
   * A card on a desktop, the whole page on a phone.
   *
   * The card was fixed at 380x560 everywhere, which on a phone left a tall panel with the
   * launcher wedged under it and the composer behind the on-screen keyboard: `100vh` does
   * not shrink when the keyboard opens, but `100dvh` does.
   */
  const sizeFrame = () => {
    frame.style.cssText = [
      'border:0',
      `display:${open ? 'block' : 'none'}`,
      'background:#fff',
      ...(phone()
        ? ['position:fixed', 'inset:0', 'width:100%', 'height:100dvh', 'border-radius:0']
        : [
            'width:min(380px,calc(100vw - 32px))',
            'height:min(560px,calc(100vh - 120px))',
            'border-radius:16px',
            'box-shadow:0 12px 40px rgba(0,0,0,.18)',
          ]),
    ].join(';')
  }

  const launcher = document.createElement('button')
  launcher.type = 'button'
  launcher.setAttribute('aria-label', settings.title)
  launcher.textContent = '💬'
  launcher.style.cssText = [
    /*
     * `all:initial` first. Everything below is set explicitly, so a host page with a
     * `button { padding: 12px 24px }` in its reset cannot reshape the launcher.
     */
    'all:initial',
    'margin-left:auto',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'position:relative',
    'width:56px',
    'height:56px',
    'margin-top:12px',
    'border:0',
    'border-radius:28px',
    'cursor:pointer',
    'font-family:system-ui,sans-serif',
    'font-size:24px',
    'line-height:1',
    // The same readable-on-brand choice the chat makes, not white on whatever the brand is.
    `color:${launcherTextOn(settings.colour)}`,
    `background:${settings.colour}`,
    'box-shadow:0 6px 20px rgba(0,0,0,.2)',
  ].join(';')

  /** How many replies arrived while the chat was shut. */
  const badge = document.createElement('span')
  badge.style.cssText = [
    'position:absolute',
    'top:-2px',
    'right:-2px',
    'min-width:20px',
    'height:20px',
    'padding:0 5px',
    'border-radius:10px',
    'background:#e02424',
    'color:#fff',
    'font-family:system-ui,sans-serif',
    'font-size:12px',
    'font-weight:700',
    'line-height:20px',
    'text-align:center',
    'display:none',
  ].join(';')
  launcher.append(badge)

  let unreadCount = 0
  /** The launcher's name says what the badge shows, for somebody who cannot see it. */
  const describe = () => {
    const unreadText =
      unreadCount > 0
        ? settings.lang === 'en'
          ? ` (${unreadCount} new)`
          : ` (ข้อความใหม่ ${unreadCount})`
        : ''
    launcher.setAttribute('aria-label', `${settings.title}${unreadText}`)
  }
  const setUnread = (count: number) => {
    unreadCount = count
    badge.textContent = count > 9 ? '9+' : String(count)
    badge.style.display = count > 0 ? 'block' : 'none'
    badge.setAttribute('aria-hidden', 'true')
    describe()
  }

  /**
   * A visible focus ring. `all:initial` resets the browser's own outline, and an inline
   * style cannot say `:focus-visible`, so it is drawn on focus and removed on blur.
   */
  launcher.addEventListener('focus', () => {
    launcher.style.outline = `3px solid ${settings.colour}`
    launcher.style.outlineOffset = '3px'
  })
  launcher.addEventListener('blur', () => {
    launcher.style.outline = 'none'
  })

  /**
   * Whether the chat is open, remembered for this tab.
   *
   * A host application is several pages, and the loader runs again on each one. Without
   * this, a customer who clicked through to the pricing page mid-conversation found the
   * chat shut and had to go looking for it again.
   */
  let open = (() => {
    // Desktop only. On a phone the chat is the whole page, so restoring it would cover
    // every page the visitor moved to — Back included — until they closed it again.
    if (phone()) return false
    try {
      return sessionStorage.getItem(OPEN_KEY) === '1'
    } catch {
      return false
    }
  })()

  const tellFrame = (type: string) => {
    frame.contentWindow?.postMessage({ type }, settings.origin)
  }

  const render = () => {
    sizeFrame()
    launcher.textContent = open ? '✕' : '💬'
    launcher.append(badge)
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false')
    describe()
    // Hidden behind a full-screen chat: on a phone the header's own close button is the
    // way out, and a floating launcher on top of the composer is just in the way.
    launcher.style.display = open && phone() ? 'none' : 'flex'
    try {
      sessionStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // Blocked storage only costs the memory of being open, not the chat itself.
    }
  }

  const setOpen = (next: boolean) => {
    open = next
    render()
    if (open) {
      setUnread(0)
      tellFrame('chat-widget:open')
    } else {
      tellFrame('chat-widget:hidden')
      // Where focus goes when a dialog closes: back to what opened it.
      launcher.focus()
    }
  }

  launcher.addEventListener('click', () => setOpen(!open))
  window.addEventListener('resize', render)
  frame.addEventListener('load', () => tellFrame(open ? 'chat-widget:open' : 'chat-widget:hidden'))

  window.addEventListener('message', (event) => {
    if (event.origin !== settings.origin) return
    const data = event.data as { type?: string; count?: number } | null
    // The chat app asks to be closed when a customer presses its own close button or
    // Escape, so the launcher and the frame cannot disagree about whether it is open.
    if (data?.type === 'chat-widget:close' && open) setOpen(false)
    if (data?.type === 'chat-widget:unread' && !open) setUnread(data.count ?? 0)
  })

  render()
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
