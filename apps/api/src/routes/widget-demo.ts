import { schema } from '@ci/db'
import { and, asc, eq } from 'drizzle-orm'
import Elysia from 'elysia'
import type { ApiContext } from '../context'

/**
 * A host page for trying the widget, on our own domain.
 *
 * The widget is meant to be embedded in somebody else's site, which makes it awkward to
 * look at before that site exists. This is the smallest possible stand-in: a page that
 * embeds the loader exactly as salon-saas will, so what an operator sees here is what a
 * customer will see there.
 *
 * It reads the channel id from the database rather than being configured, so it works on
 * any deployment without a second place to keep in step.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function page(body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>ทดลองใช้วิดเจ็ตแชท</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, 'Segoe UI', 'Noto Sans Thai', sans-serif;
    background: #f8fafc; color: #101828; padding: 24px;
  }
  main { max-width: 34rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { line-height: 1.65; color: #475467; margin: 0 0 .75rem; }
  code {
    background: #eef2f6; padding: .1rem .35rem; border-radius: .25rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em;
  }
  pre {
    background: #101828; color: #e4e7ec; padding: 12px 14px; border-radius: 10px;
    overflow-x: auto; font-size: .8rem; line-height: 1.5;
  }
  /* The inline-code style would otherwise paint a pale block behind every line here. */
  pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export function widgetDemoRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx

  return new Elysia({ name: 'widget-demo' }).get('/widget-demo', async () => {
    const rows = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.type, 'web'), eq(schema.channels.enabled, true)))
      .orderBy(asc(schema.channels.createdAt))
      .limit(1)

    const channelId = rows[0]?.id
    if (!channelId) {
      return page(
        `<h1>ยังไม่มีช่องทางเว็บ</h1>
         <p>สร้างช่องทางชนิด <code>web</code> ในหน้าตั้งค่าก่อน แล้วเปิดหน้านี้อีกครั้ง</p>`,
      )
    }

    const origin = runtime.env.PUBLIC_API_URL.replace(/\/$/, '')
    const snippet = [
      '&lt;script',
      `  src="${escapeHtml(origin)}/widget/loader.js"`,
      `  data-channel="${escapeHtml(channelId)}"`,
      '  data-colour="#2563eb"',
      '  defer',
      '&gt;&lt;/script&gt;',
    ].join('\n')

    return page(
      `<h1>ทดลองใช้วิดเจ็ตแชท</h1>
       <p>หน้านี้ฝังวิดเจ็ตแบบเดียวกับที่เว็บไซต์ของคุณจะฝัง กดปุ่มมุมขวาล่างเพื่อเริ่มคุยในฐานะลูกค้า
          ข้อความจะเข้าไปที่กล่องข้อความของทีมงานทันที</p>
       <p>นำโค้ดนี้ไปวางในเว็บไซต์ของคุณ</p>
       <pre><code>${snippet}</code></pre>
       <script
         src="${escapeHtml(origin)}/widget/loader.js"
         data-channel="${escapeHtml(channelId)}"
         data-colour="#2563eb"
         defer
       ></script>`,
    )
  })
}
