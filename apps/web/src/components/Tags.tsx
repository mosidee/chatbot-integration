import { normaliseTag } from '@ci/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { cn, Icon } from './ui'

/**
 * Conversation tags in the console: the chips, the box that adds one, and the inbox filter.
 *
 * Tags are free text, normalised on the server (`normaliseTag`) and shown as stored. The
 * suggestions come from the workspace's own tags, most used first, so the team converges on
 * one word for one thing without anybody having to define the list in advance.
 */

/** The workspace's tags, shared by the suggestions, the filter and the settings card. */
export function useWorkspaceTags(enabled = true) {
  return useQuery({
    queryKey: ['conversation-tags'],
    queryFn: () => api.conversations.tags(),
    staleTime: 30_000,
    enabled,
  })
}

export function TagChip({
  tag,
  onRemove,
  onSelect,
  removeLabel,
  selectLabel,
  small = false,
}: {
  tag: string
  onRemove?: () => void
  onSelect?: () => void
  removeLabel?: string
  selectLabel?: string
  small?: boolean
}) {
  const chip = cn(
    'inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-muted)] text-[var(--text-muted)]',
    small ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs',
  )
  return (
    <span className={chip} data-testid={`tag-chip-${tag}`}>
      {onSelect ? (
        <button
          type="button"
          className="truncate hover:text-[var(--text)]"
          title={selectLabel}
          aria-label={selectLabel}
          data-testid={`tag-select-${tag}`}
          onClick={onSelect}
        >
          {tag}
        </button>
      ) : (
        <span className="truncate">{tag}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          className="rounded-full hover:text-[var(--text)]"
          aria-label={removeLabel}
          data-testid={`tag-remove-${tag}`}
          onClick={onRemove}
        >
          <Icon name="close" className="size-3" />
        </button>
      ) : null}
    </span>
  )
}

/**
 * A text box with the workspace's tags offered underneath as you type.
 *
 * A listbox of our own rather than a `<datalist>`: a datalist hides its options until
 * hover and filters them by whatever the box already holds in ways that differ per browser.
 * Enter or a comma adds what is typed, or the highlighted suggestion; arrows move through
 * the suggestions; Escape closes them.
 */
export function TagInput({
  exclude,
  onAdd,
  disabled,
  placeholder,
  testId,
}: {
  exclude: readonly string[]
  onAdd: (tag: string) => void
  disabled?: boolean
  placeholder: string
  testId: string
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const tags = useWorkspaceTags()
  const typed = normaliseTag(text)
  const suggestions = (tags.data?.tags ?? [])
    .map((row) => row.tag)
    .filter((tag) => !exclude.includes(tag) && (!typed || tag.includes(typed)))
    .slice(0, 8)

  const commit = (value: string | null) => {
    const tag = value ? normaliseTag(value) : null
    if (!tag || exclude.includes(tag)) {
      setText('')
      return
    }
    onAdd(tag)
    setText('')
    setActive(-1)
  }

  return (
    <div className="relative">
      <input
        type="text"
        data-testid={testId}
        className="h-7 w-36 rounded-full border border-dashed border-[var(--border)] bg-transparent px-2.5 text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-brand-500)] focus:outline-none"
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        maxLength={60}
        disabled={disabled}
        value={text}
        onFocus={() => setOpen(true)}
        // Late enough that a click on a suggestion lands before the list goes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          const value = event.target.value
          // A comma ends a tag, as Enter does; a pasted "a, b" adds both.
          if (value.includes(',')) {
            for (const part of value.split(',').slice(0, -1)) commit(part)
            setText(value.split(',').at(-1) ?? '')
          } else {
            setText(value)
          }
          setActive(-1)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(active >= 0 ? (suggestions[active] ?? text) : text)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActive((index) => Math.min(index + 1, suggestions.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index) => Math.max(index - 1, -1))
          } else if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && suggestions.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 top-8 z-20 max-h-60 w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {suggestions.map((tag, index) => (
            <div
              key={tag}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              data-testid={`tag-suggestion-${tag}`}
              className={cn(
                'cursor-pointer truncate px-3 py-1.5 text-xs',
                index === active ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
              )}
              // mousedown, not click: it fires before the input's blur closes the list.
              onMouseDown={(event) => {
                event.preventDefault()
                commit(tag)
              }}
            >
              {tag}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The tag strip under a conversation's header.
 *
 * Viewers see the chips and nothing to change them with. Clicking a chip's name filters the
 * inbox by it; the cross removes it from this conversation.
 */
export function ConversationTags({
  conversationId,
  tags,
  canEdit,
  onFilter,
  onError,
}: {
  conversationId: string
  tags: string[]
  canEdit: boolean
  onFilter: (tag: string) => void
  onError: (error: unknown) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // Keeps the strip from flickering back between the request and the refetch.
  const [shown, setShown] = useState<string[] | null>(null)
  const pending = useRef(0)
  const current = shown ?? tags

  const settle = (next: string[]) => {
    pending.current -= 1
    if (pending.current === 0) setShown(null)
    queryClient.setQueryData(['conversation', conversationId], (old: unknown) =>
      old && typeof old === 'object' && 'conversation' in old
        ? {
            ...(old as { conversation: object }),
            conversation: { ...(old as { conversation: object }).conversation, tags: next },
          }
        : old,
    )
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    void queryClient.invalidateQueries({ queryKey: ['conversation-tags'] })
  }
  const fail = (error: unknown) => {
    pending.current -= 1
    if (pending.current === 0) setShown(null)
    onError(error)
  }

  const add = useMutation({
    mutationFn: (tag: string) => api.conversations.addTag(conversationId, tag),
    onMutate: (tag) => {
      pending.current += 1
      setShown([...current, tag])
    },
    onSuccess: (result) => settle(result.tags),
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (tag: string) => api.conversations.removeTag(conversationId, tag),
    onMutate: (tag) => {
      pending.current += 1
      setShown(current.filter((value) => value !== tag))
    },
    onSuccess: (result) => settle(result.tags),
    onError: fail,
  })

  if (!canEdit && current.length === 0) return null

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5"
      data-testid="conversation-tags"
    >
      <span className="sr-only">{t('tags.label')}</span>
      {current.map((tag) => (
        <TagChip
          key={tag}
          tag={tag}
          onSelect={() => onFilter(tag)}
          selectLabel={t('tags.filterBy', { tag })}
          {...(canEdit
            ? { onRemove: () => remove.mutate(tag), removeLabel: t('tags.remove', { tag }) }
            : {})}
        />
      ))}
      {canEdit ? (
        <TagInput
          testId="tag-input"
          exclude={current}
          placeholder={t('tags.add')}
          onAdd={(tag) => add.mutate(tag)}
        />
      ) : null}
    </div>
  )
}

/**
 * The inbox's tag filter: the chosen tags, each removable, and a box to add another.
 * A conversation must carry every chosen tag.
 */
export function TagFilter({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (tags: string[]) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="tag-filter">
      {selected.map((tag) => (
        <TagChip
          key={tag}
          tag={tag}
          onRemove={() => onChange(selected.filter((value) => value !== tag))}
          removeLabel={t('tags.removeFilter', { tag })}
        />
      ))}
      <TagInput
        testId="tag-filter-input"
        exclude={selected}
        placeholder={t('tags.filter')}
        onAdd={(tag) => onChange([...selected, tag])}
      />
      {selected.length > 1 ? (
        <button
          type="button"
          className="text-[11px] text-[var(--text-muted)] underline hover:text-[var(--text)]"
          data-testid="tag-filter-clear"
          onClick={() => onChange([])}
        >
          {t('tags.clearFilter')}
        </button>
      ) : null}
    </div>
  )
}
