import type { NormalizedMessage } from '@ci/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  Spinner,
  Textarea,
} from '../components/ui'
import { api, type UploadResult } from '../lib/api'

/**
 * Act as a customer without a platform account.
 *
 * Messages sent here take the same ingestion path a real LINE or Messenger webhook does,
 * so what is being tested is the real pipeline, not a shortcut.
 */
export function Simulator() {
  const { t } = useTranslation()
  const [externalId, setExternalId] = useState('sim-customer-1')
  const [displayName, setDisplayName] = useState('Nok')
  const [text, setText] = useState('')
  const [sentCount, setSentCount] = useState(0)
  const [attachment, setAttachment] = useState<UploadResult | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const channels = useQuery({
    queryKey: ['simulator-channels'],
    queryFn: () => api.simulator.channels(),
  })

  const channelId = channels.data?.channels[0]?.id

  const upload = useMutation({
    mutationFn: (file: File) => api.uploads.upload(file),
    onSuccess: (result) => {
      setAttachment(result)
      setUploadError(null)
    },
    onError: (caught) => setUploadError(caught instanceof Error ? caught.message : String(caught)),
  })

  const send = useMutation({
    mutationFn: async (body: string) => {
      if (!channelId) throw new Error('no test channel')

      // An attachment makes it an image message, which is what exercises the vision slot.
      const message: NormalizedMessage = attachment
        ? {
            kind: 'image',
            text: body || null,
            attachments: [
              {
                storageKey: attachment.storageKey,
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
        : { kind: 'text', text: body }

      return api.simulator.send(channelId, { externalId, displayName, message })
    },
    onSuccess: () => {
      setText('')
      setAttachment(null)
      if (fileInput.current) fileInput.current.value = ''
      setSentCount((n) => n + 1)
    },
  })

  if (channels.isLoading) {
    return (
      <div className="p-6">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  if (!channelId) return <EmptyState title={t('simulator.noChannel')} />

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="mb-1 text-lg font-semibold">{t('simulator.title')}</h1>
      <p className="mb-4 text-sm text-[var(--text-muted)]">{t('simulator.description')}</p>

      <Card className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="sim-name">{t('simulator.customerName')}</Label>
            <Input
              id="sim-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="sim-id">{t('simulator.customerId')}</Label>
            <Input id="sim-id" value={externalId} onChange={(e) => setExternalId(e.target.value)} />
          </div>
        </div>

        <div>
          <Textarea
            rows={3}
            value={text}
            placeholder={t('conversation.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault()
                send.mutate(text.trim())
              }
            }}
          />
        </div>

        {attachment ? (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-2">
            <img
              src={api.uploads.urlFor(attachment.storageKey)}
              alt={attachment.fileName}
              className="size-12 rounded object-cover"
            />
            <span className="min-w-0 flex-1 truncate text-[13px]">{attachment.fileName}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('common.remove')}
              onClick={() => setAttachment(null)}
            >
              ✕
            </Button>
          </div>
        ) : null}
        {uploadError ? <ErrorNote message={uploadError} /> : null}

        <div className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) upload.mutate(file)
            }}
          />
          <Button
            variant="primary"
            disabled={(!text.trim() && !attachment) || send.isPending}
            onClick={() => send.mutate(text.trim())}
          >
            {t('simulator.send')}
          </Button>
          <Button
            variant="secondary"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            {upload.isPending ? t('common.loading') : t('simulator.attachImage')}
          </Button>
          {sentCount > 0 ? (
            <span className="text-sm text-[var(--text-muted)]">{sentCount}</span>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
