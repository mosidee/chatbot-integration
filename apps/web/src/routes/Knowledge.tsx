import type { Language } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  ConfirmButton,
  cn,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  Spinner,
  Textarea,
} from '../components/ui'
import { api, type KnowledgeSource, type SearchHit, type SearchResult } from '../lib/api'

/**
 * Knowledge management.
 *
 * Ingestion status is shown per source with its failure reason, because the most likely
 * first upload is a Thai PDF that is really a scan, and an operator needs to see "this file
 * needs OCR" rather than wonder why the AI answers badly.
 */
export function Knowledge() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const sources = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => api.knowledge.sources(),
    // Ingestion runs in the worker, so the list polls while anything is in flight.
    refetchInterval: (query) => {
      const data = query.state.data
      const busy = data?.sources.some((s) => s.status === 'pending' || s.status === 'processing')
      return busy ? 2000 : false
    },
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] })

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-12">
      <h1 className="text-lg font-semibold">{t('knowledge.title')}</h1>

      <AddKnowledge onDone={refresh} />
      <TestSearch />

      <Card className="space-y-2">
        <h2 className="text-sm font-semibold">{t('knowledge.sources')}</h2>
        {sources.isLoading ? (
          <Spinner label={t('common.loading')} />
        ) : (sources.data?.sources.length ?? 0) === 0 ? (
          <EmptyState title={t('knowledge.empty')} hint={t('knowledge.emptyHint')} />
        ) : (
          sources.data?.sources.map((source) => (
            <SourceRow key={source.id} source={source} onChange={refresh} />
          ))
        )}
      </Card>
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  processing: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  pending: 'bg-[var(--surface-muted)] text-[var(--text-muted)]',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
}

function SourceRow({ source, onChange }: { source: KnowledgeSource; onChange: () => void }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const reindex = useMutation({
    mutationFn: () => api.knowledge.reindex(source.id),
    onSuccess: onChange,
  })
  const remove = useMutation({
    mutationFn: () => api.knowledge.deleteSource(source.id),
    onSuccess: onChange,
  })

  const entries = useQuery({
    queryKey: ['knowledge-entries', source.id],
    queryFn: () => api.knowledge.entries(source.id),
    enabled: expanded,
  })

  return (
    <div className="rounded-lg border border-[var(--border)] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="truncate text-sm font-medium">{source.title}</span>
        </button>
        <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] uppercase text-[var(--text-muted)]">
          {source.kind}
        </span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px] font-medium',
            STATUS_STYLES[source.status] ?? '',
          )}
        >
          {t(`knowledge.status.${source.status}`)}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">
          {source.chunkCount} {t('knowledge.chunks')}
        </span>
        <Button size="sm" variant="ghost" onClick={() => reindex.mutate()}>
          {t('knowledge.reindex')}
        </Button>
        <ConfirmButton
          testId={`knowledge-remove-${source.id}`}
          label={t('common.remove')}
          armedLabel={t('common.removeConfirm')}
          onConfirm={() => remove.mutate()}
        />
      </div>

      {source.error ? (
        <div className="mt-2">
          <ErrorNote message={source.error} />
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          {entries.isLoading ? (
            <Spinner label={t('common.loading')} />
          ) : (
            entries.data?.entries.map((entry) => (
              <EntryEditor key={entry.id} entry={entry} onChange={onChange} />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function EntryEditor({
  entry,
  onChange,
}: {
  entry: { id: string; question: string | null; body: string; enabled: boolean }
  onChange: () => void
}) {
  const { t } = useTranslation()
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.knowledge.updateEntry(entry.id, patch),
    onSuccess: onChange,
  })

  return (
    <div className="space-y-1.5">
      {entry.question !== null ? (
        <Input
          defaultValue={entry.question}
          placeholder={t('knowledge.question')}
          onBlur={(e) => {
            if (e.target.value !== entry.question) save.mutate({ question: e.target.value })
          }}
        />
      ) : null}
      <Textarea
        rows={entry.question === null ? 8 : 4}
        defaultValue={entry.body}
        onBlur={(e) => {
          if (e.target.value !== entry.body) save.mutate({ body: e.target.value })
        }}
      />
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={(e) => save.mutate({ enabled: e.target.checked })}
        />
        {t('knowledge.enabled')}
      </label>
    </div>
  )
}

function AddKnowledge({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const [question, setQuestion] = useState('')
  const [body, setBody] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const language = (i18n.language === 'th' ? 'th' : 'en') as Language

  const create = useMutation({
    mutationFn: () =>
      api.knowledge.createSource({
        title: title || question.slice(0, 80) || t('knowledge.untitled'),
        language,
        question: question || null,
        body,
      }),
    onSuccess: () => {
      setQuestion('')
      setBody('')
      setTitle('')
      setError(null)
      onDone()
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  const upload = useMutation({
    mutationFn: (file: File) => api.knowledge.uploadFile(file),
    onSuccess: () => {
      if (fileInput.current) fileInput.current.value = ''
      setError(null)
      onDone()
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  })

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">{t('knowledge.add')}</h2>

      <div>
        <Label htmlFor="kb-question">{t('knowledge.question')}</Label>
        <Input
          id="kb-question"
          value={question}
          placeholder={t('knowledge.questionPlaceholder')}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>

      <div>
        <Label htmlFor="kb-body">{t('knowledge.answer')}</Label>
        <Textarea
          id="kb-body"
          rows={4}
          value={body}
          placeholder={t('knowledge.answerPlaceholder')}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {error ? <ErrorNote message={error} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!body.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {t('knowledge.save')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload.mutate(file)
          }}
        />
        <Button disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
          {upload.isPending ? t('common.loading') : t('knowledge.uploadFile')}
        </Button>
        <span className="text-[11px] text-[var(--text-muted)]">{t('knowledge.formats')}</span>
      </div>
    </Card>
  )
}

/**
 * The test-search box shows the fused result and both halves, so an operator can see
 * whether a miss came from the meaning search or the literal one.
 */
function TestSearch() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)

  const search = useMutation({
    mutationFn: () => api.knowledge.search({ query }),
    onSuccess: setResult,
  })

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold">{t('knowledge.testSearch')}</h2>
      <div className="flex gap-2">
        <Input
          value={query}
          placeholder={t('knowledge.testSearchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) search.mutate()
          }}
        />
        <Button
          variant="primary"
          disabled={!query.trim() || search.isPending}
          onClick={() => search.mutate()}
        >
          {t('knowledge.search')}
        </Button>
      </div>

      {result ? (
        <div className="space-y-3">
          <p className="text-[11px] text-[var(--text-muted)]">
            {result.embeddingModel
              ? `${t('knowledge.embeddingModel')}: ${result.embeddingModel}`
              : t('knowledge.noEmbeddingModel')}
          </p>
          <HitList title={t('knowledge.fused')} hits={result.chunks} />
          <div className="grid gap-3 sm:grid-cols-2">
            <HitList title={t('knowledge.denseHalf')} hits={result.dense} compact />
            <HitList title={t('knowledge.keywordHalf')} hits={result.keyword} compact />
          </div>
        </div>
      ) : null}
    </Card>
  )
}

function HitList({
  title,
  hits,
  compact,
}: {
  title: string
  hits: SearchHit[]
  compact?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </h3>
      {hits.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)]">{t('knowledge.noHits')}</p>
      ) : (
        <ul className="space-y-1.5">
          {hits.map((hit) => (
            <li key={hit.id} className="rounded-lg border border-[var(--border)] p-2">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[12px] font-medium">{hit.sourceTitle}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                  {hit.denseScore !== null ? `d ${hit.denseScore.toFixed(3)}` : ''}
                  {hit.keywordScore !== null ? ` k ${hit.keywordScore.toFixed(3)}` : ''}
                </span>
              </div>
              <p className={cn('text-[13px]', compact ? 'line-clamp-2' : 'line-clamp-4')}>
                {hit.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
