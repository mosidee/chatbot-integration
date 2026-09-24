import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Channel } from '../lib/api'
import { Button, ErrorNote, Input, Label } from './ui'

/**
 * Everything needed to put the widget on a website, in the place an operator configures it.
 *
 * The snippet is generated rather than documented, because the channel id in it is the one
 * thing nobody can be expected to remember, and a wrong id fails silently on somebody
 * else's page. The preview opens the real widget against this same channel, so what is
 * seen here is what a customer will see, and the conversation lands in the inbox like any
 * other.
 */

function snippetFor(channel: Channel): string {
  return [
    '<script',
    `  src="${channel.embedUrl}"`,
    `  data-channel="${channel.id}"`,
    '  data-colour="#2563eb"',
    '  defer',
    '></script>',
  ].join('\n')
}

export function WidgetPanel({ channel, onChange }: { channel: Channel; onChange: () => void }) {
  const { t } = useTranslation()
  const [origins, setOrigins] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [copied, setCopied] = useState(false)

  const snippet = snippetFor(channel)
  const current = (channel.allowedOrigins ?? []).join('\n')

  const save = useMutation({
    mutationFn: (value: string) =>
      api.settings.updateChannel(channel.id, {
        config: {
          // One per line, blank lines dropped. An empty list means any site may embed it,
          // which suits development and nothing else.
          allowedOrigins: value
            .split(/[\s,]+/)
            .map((origin) => origin.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      setOrigins(null)
      onChange()
    },
  })
  const saveError = save.error
    ? save.error instanceof Error
      ? save.error.message
      : String(save.error)
    : null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused; the snippet is on screen to select by hand.
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
      <div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${channel.id}-snippet`}>{t('settings.embedSnippet')}</Label>
          <Button size="sm" variant="ghost" data-testid="copy-snippet" onClick={() => void copy()}>
            {copied ? t('settings.copied') : t('settings.copy')}
          </Button>
        </div>
        <pre
          id={`${channel.id}-snippet`}
          data-testid="widget-snippet"
          className="overflow-x-auto rounded-lg bg-[var(--surface-muted)] px-2 py-1.5 text-[11px] leading-relaxed"
        >
          <code>{snippet}</code>
        </pre>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('settings.embedHint')}</p>
      </div>

      <div>
        <Label htmlFor={`${channel.id}-origins`}>{t('settings.allowedOrigins')}</Label>
        <Input
          id={`${channel.id}-origins`}
          data-testid="allowed-origins"
          placeholder="https://app.example.com"
          value={origins ?? current}
          onChange={(e) => setOrigins(e.target.value)}
        />
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          {(channel.allowedOrigins ?? []).length === 0
            ? t('settings.originsOpen')
            : t('settings.originsHint')}
        </p>
        {origins !== null && origins !== current ? (
          <Button
            size="sm"
            variant="primary"
            className="mt-1.5"
            data-testid="save-origins"
            disabled={save.isPending}
            onClick={() => save.mutate(origins)}
          >
            {t('settings.save')}
          </Button>
        ) : null}
        {saveError ? (
          <div className="mt-1.5" data-testid="origins-error">
            <ErrorNote message={`${t('settings.saveFailed')}: ${saveError}`} />
          </div>
        ) : null}
      </div>

      <div>
        <Button
          size="sm"
          variant="secondary"
          data-testid="toggle-widget-preview"
          onClick={() => setPreview((v) => !v)}
        >
          {preview ? t('common.close') : t('settings.previewWidget')}
        </Button>
        {preview ? (
          <iframe
            title={t('settings.previewWidget')}
            data-testid="widget-preview"
            src={`/widget/index.html?channel=${channel.id}&colour=%232563eb`}
            className="mt-2 h-[460px] w-full max-w-[380px] rounded-xl border border-[var(--border)] bg-white"
          />
        ) : null}
      </div>
    </div>
  )
}
