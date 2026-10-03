import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { useWorkspaceTags } from './Tags'
import { Button, Card, ConfirmButton, EmptyState, ErrorNote, Input, Spinner } from './ui'

/**
 * Every tag in the workspace, for an admin to tidy: rename (onto an existing tag merges the
 * two) or delete from every conversation. Free-text tags drift — `refund`, `refunds` — and
 * this is where they are brought back together.
 */
export function TagsCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const tags = useWorkspaceTags()
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation-tags'] })
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    void queryClient.invalidateQueries({ queryKey: ['conversation'] })
  }
  const failed = (caught: unknown) =>
    setError(caught instanceof Error ? caught.message : String(caught))

  const rename = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => api.settings.renameTag(from, to),
    onMutate: () => setError(null),
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: (tag: string) => api.settings.deleteTag(tag),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: failed,
  })

  return (
    <Card className="space-y-3" testId="tags-card">
      <div>
        <h2 className="text-sm font-semibold">{t('tags.cardTitle')}</h2>
        <p className="text-[13px] text-[var(--text-muted)]">{t('tags.cardHint')}</p>
      </div>
      {error ? <ErrorNote message={error} /> : null}
      {tags.isLoading ? (
        <Spinner />
      ) : tags.isError ? (
        <ErrorNote message={t('tags.loadFailed')} />
      ) : (tags.data?.tags.length ?? 0) === 0 ? (
        <EmptyState title={t('tags.empty')} />
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {tags.data?.tags.map((row) => (
            <li key={row.tag} className="flex flex-wrap items-center gap-2 py-2">
              {editing === row.tag ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (name.trim()) rename.mutate({ from: row.tag, to: name })
                  }}
                >
                  <Input
                    autoFocus
                    aria-label={t('tags.newName')}
                    data-testid={`tag-rename-input-${row.tag}`}
                    className="h-8 max-w-60"
                    value={name}
                    maxLength={60}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    type="submit"
                    data-testid={`tag-rename-save-${row.tag}`}
                    disabled={rename.isPending}
                  >
                    {t('tags.save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    {t('tags.cancel')}
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">{row.tag}</span>
                  <span className="text-[12px] tabular-nums text-[var(--text-muted)]">
                    {t('tags.used', { count: row.count })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`tag-rename-${row.tag}`}
                    onClick={() => {
                      setEditing(row.tag)
                      setName(row.tag)
                    }}
                  >
                    {t('tags.rename')}
                  </Button>
                  <ConfirmButton
                    label={t('tags.delete')}
                    armedLabel={t('tags.confirmDelete')}
                    testId={`tag-delete-${row.tag}`}
                    disabled={remove.isPending}
                    onConfirm={() => remove.mutate(row.tag)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
