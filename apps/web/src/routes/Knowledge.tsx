import type { Language } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
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
  SaveStatus,
  Spinner,
  Textarea,
  useSaveState,
} from '../components/ui'
import { ApiError, api, type KnowledgeSource, type SearchHit, type SearchResult } from '../lib/api'
import { useCan } from '../lib/capabilities'

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
  // Adding, editing, reindexing, removing and the test search are an agent's. A viewer
  // reads the knowledge base and is told so, rather than shown editors that will refuse.
  const canEdit = useCan('editKnowledge')

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-12">
      <h1 className="text-lg font-semibold">{t('knowledge.title')}</h1>

      {canEdit ? (
        <>
          <AddKnowledge onDone={refresh} />
          <TestSearch />
        </>
      ) : (
        <p className="text-[13px] text-[var(--text-muted)]" data-testid="knowledge-read-only">
          {t('knowledge.readOnly')}
        </p>
      )}

      <Card className="space-y-2">
        <h2 className="text-sm font-semibold">{t('knowledge.sources')}</h2>
        {sources.isLoading ? (
          <Spinner label={t('common.loading')} />
        ) : sources.isError ? (
          // A failed load is not an empty knowledge base.
          <div className="space-y-2">
            <ErrorNote message={t('knowledge.loadFailed')} />
            <Button size="sm" onClick={() => void sources.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (sources.data?.sources.length ?? 0) === 0 ? (
          <EmptyState title={t('knowledge.empty')} hint={t('knowledge.emptyHint')} />
        ) : (
          sources.data?.sources.map((source) => (
            <SourceRow key={source.id} source={source} onChange={refresh} canEdit={canEdit} />
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

function SourceRow({
  source,
  onChange,
  canEdit,
}: {
  source: KnowledgeSource
  onChange: () => void
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const save = useSaveState()

  const reindex = useMutation({
    mutationFn: () => api.knowledge.reindex(source.id),
    ...save.handlers,
    onSuccess: () => {
      save.handlers.onSuccess()
      onChange()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.knowledge.deleteSource(source.id),
    ...save.handlers,
    onSuccess: () => {
      save.handlers.onSuccess()
      onChange()
    },
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
          data-testid={`knowledge-source-${source.id}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          {/* `block`, so truncation works at all: an inline span has no width to truncate
              against, and a long PDF name wrapped across the row instead. */}
          <span className="block truncate text-sm font-medium">{source.title}</span>
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
        {canEdit ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => reindex.mutate()}>
              {t('knowledge.reindex')}
            </Button>
            <ConfirmButton
              testId={`knowledge-remove-${source.id}`}
              label={t('common.remove')}
              armedLabel={t('common.removeConfirm')}
              onConfirm={() => remove.mutate()}
            />
          </>
        ) : null}
      </div>

      <SaveStatus state={save.state} className="mt-1" />

      {source.error ? (
        <div className="mt-2">
          <ErrorNote message={source.error} />
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          {entries.isLoading ? (
            <Spinner label={t('common.loading')} />
          ) : entries.isError ? (
            <div className="space-y-2">
              <ErrorNote message={t('knowledge.loadFailed')} />
              <Button size="sm" onClick={() => void entries.refetch()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            entries.data?.entries.map((entry) =>
              canEdit ? (
                <EntryEditor
                  key={entry.id}
                  entry={entry}
                  onChange={() => {
                    // The entry itself, which is what the editor shows, and the source row,
                    // whose status and chunk count the save changes.
                    void queryClient.invalidateQueries({
                      queryKey: ['knowledge-entries', source.id],
                    })
                    onChange()
                  }}
                />
              ) : (
                <div key={entry.id} className="space-y-1 text-[13px]">
                  {entry.question ? <p className="font-medium">{entry.question}</p> : null}
                  <p className="whitespace-pre-wrap">{entry.body}</p>
                </div>
              ),
            )
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
  entry: { id: string; question: string | null; body: string; enabled: boolean; updatedAt: string }
  onChange: () => void
}) {
  const { t } = useTranslation()
  const status = useSaveState()
  /**
   * Controlled, and brought up to date whenever the saved entry changes and the field is
   * not being edited. With `defaultValue` a failed save left the box showing text the server
   * never took, and a change from elsewhere never appeared at all.
   */
  const [question, setQuestion] = useState(entry.question ?? '')
  const [body, setBody] = useState(entry.body)
  const [editing, setEditing] = useState<'question' | 'body' | null>(null)
  const [conflict, setConflict] = useState(false)
  useEffect(() => {
    if (editing !== 'question') setQuestion(entry.question ?? '')
    if (editing !== 'body') setBody(entry.body)
  }, [entry.question, entry.body, editing])

  /**
   * The version a field showed when somebody started editing it, sent with the save so that
   * one made over a colleague's newer text is refused rather than silently replacing it.
   * Taken at focus, not at blur: the entries query refetches in the background, and by the
   * blur it may already hold the colleague's revision while the field holds the old text.
   */
  const startedFrom = useRef(entry.updatedAt)
  /**
   * What this editor's own saves turned each revision into. A second save that started from
   * the version the first one replaced is still this person's own chain, not a conflict.
   */
  const successors = useRef(new Map<string, string>())

  /** One save at a time, so each can follow the revision the previous one returned. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const save = useMutation({
    mutationFn: ({ patch, base }: { patch: Record<string, unknown>; base: string }) => {
      const run = queue.current
        .catch(() => undefined)
        .then(async () => {
          let revision = base
          for (let next = successors.current.get(revision); next; ) {
            revision = next
            next = successors.current.get(revision)
          }
          const saved = await api.knowledge.updateEntry(entry.id, { ...patch, revision })
          if (saved.revision) successors.current.set(revision, saved.revision)
          return saved
        })
      queue.current = run
      return run
    },
    ...status.handlers,
    onSuccess: (data, variables, context) => {
      setConflict(false)
      status.handlers.onSuccess(data, variables, context)
      onChange()
    },
    onError: (error, variables, context) => {
      status.handlers.onError(error, variables, context)
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true)
        onChange()
      }
    },
  })

  return (
    <div className="space-y-1.5">
      {entry.question !== null ? (
        <Input
          aria-label={t('knowledge.question')}
          value={question}
          placeholder={t('knowledge.question')}
          onFocus={() => {
            startedFrom.current = entry.updatedAt
            setEditing('question')
          }}
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={() => {
            setEditing(null)
            if (question !== entry.question) {
              save.mutate({ patch: { question }, base: startedFrom.current })
            }
          }}
        />
      ) : null}
      <Textarea
        data-testid="entry-body"
        aria-label={t('knowledge.answer')}
        rows={entry.question === null ? 8 : 4}
        value={body}
        onFocus={() => {
          startedFrom.current = entry.updatedAt
          setEditing('body')
        }}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => {
          setEditing(null)
          if (body !== entry.body) save.mutate({ patch: { body }, base: startedFrom.current })
        }}
      />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={entry.enabled}
            onChange={(e) =>
              save.mutate({ patch: { enabled: e.target.checked }, base: entry.updatedAt })
            }
          />
          {t('knowledge.enabled')}
        </label>
        {/* These fields save on blur, so without this the only sign anything happened was
            the text staying where it was typed — which it also does when the save fails. */}
        <SaveStatus state={status.state} />
      </div>
      {conflict ? (
        <div data-testid="entry-conflict">
          <ErrorNote message={t('knowledge.entryConflict')} />
        </div>
      ) : null}
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
  const [result, setResult] = useState<{ query: string; result: SearchResult } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const search = useMutation({
    mutationFn: (asked: string) => api.knowledge.search({ query: asked }),
    // The previous answer goes as the new question is asked: left up, it read as the answer
    // to a search that had in fact failed.
    onMutate: () => {
      setResult(null)
      setError(null)
    },
    onSuccess: (found, asked) => setResult({ query: asked, result: found }),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
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
            if (e.key === 'Enter' && query.trim() && !search.isPending) search.mutate(query.trim())
          }}
        />
        <Button
          variant="primary"
          disabled={!query.trim() || search.isPending}
          onClick={() => search.mutate(query.trim())}
        >
          {t('knowledge.search')}
        </Button>
      </div>

      {error ? <ErrorNote message={`${t('knowledge.searchFailed')}: ${error}`} /> : null}

      {result ? (
        <div className="space-y-3" data-testid="test-search-result">
          <p className="text-[11px] text-[var(--text-muted)]">
            {t('knowledge.resultsFor', { query: result.query })}
          </p>
          {/* What the AI would be given, first. How each half scored is for somebody
              chasing a miss, so it is one click further. */}
          <HitList title={t('knowledge.fused')} hits={result.result.chunks} />
          <details className="rounded-lg border border-[var(--border)] p-2">
            <summary className="cursor-pointer text-[12px] text-[var(--text-muted)]">
              {t('knowledge.howItScored')}
            </summary>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              {result.result.embeddingModel
                ? `${t('knowledge.embeddingModel')}: ${result.result.embeddingModel}`
                : t('knowledge.noEmbeddingModel')}
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <HitList title={t('knowledge.denseHalf')} hits={result.result.dense} compact scores />
              <HitList
                title={t('knowledge.keywordHalf')}
                hits={result.result.keyword}
                compact
                scores
              />
            </div>
          </details>
        </div>
      ) : null}
    </Card>
  )
}

function HitList({
  title,
  hits,
  compact,
  scores,
}: {
  title: string
  hits: SearchHit[]
  compact?: boolean
  /** Scores only where somebody is diagnosing a search, not beside the answer itself. */
  scores?: boolean
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
                {scores ? (
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                    {hit.denseScore !== null ? `d ${hit.denseScore.toFixed(3)}` : ''}
                    {hit.keywordScore !== null ? ` k ${hit.keywordScore.toFixed(3)}` : ''}
                  </span>
                ) : null}
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
