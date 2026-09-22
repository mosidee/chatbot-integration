import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { SaveStatus, useSaveState } from './ui'

/**
 * Who looks after this customer.
 *
 * The relationship rather than the thread: it outlives every conversation they have, and it
 * decides where they sit in everybody's inbox. Changing it does not move a conversation
 * somebody is already answering; the next one this customer starts belongs to the new owner.
 *
 * The member list comes from the settings endpoint an agent may already read, not the admin
 * one, because picking a colleague is not administering a workspace.
 */
export function CustomerAssignee({
  customerId,
  assigneeUserId,
  canWrite,
  onAssigned,
}: {
  customerId: string
  assigneeUserId: string | null
  canWrite: boolean
  onAssigned: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const members = useQuery({
    queryKey: ['members-list'],
    queryFn: () => api.settings.members(),
    staleTime: 300_000,
  })

  const save = useSaveState()

  const assign = useMutation({
    mutationFn: (userId: string | null) => api.customers.assign(customerId, userId),
    ...save.handlers,
    onSuccess: () => {
      save.handlers.onSuccess()
      // The inbox is ordered by this, so the list is now wrong until it is refetched.
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      onAssigned()
    },
  })

  const owner = members.data?.members.find((member) => member.userId === assigneeUserId)

  if (!canWrite) {
    return (
      <p className="text-[13px] text-[var(--text-muted)]" data-testid="customer-owner">
        {t('sidebar.owner')}: {owner?.name ?? t('sidebar.unassigned')}
      </p>
    )
  }

  return (
    <label className="block text-[13px]">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {t('sidebar.owner')}
      </span>
      <select
        data-testid="customer-assignee"
        value={assigneeUserId ?? ''}
        disabled={assign.isPending}
        onChange={(event) => assign.mutate(event.target.value === '' ? null : event.target.value)}
        className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[13px]"
      >
        <option value="">{t('sidebar.unassigned')}</option>
        {(members.data?.members ?? []).map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.name}
          </option>
        ))}
      </select>
      {/* The select snaps back to the old owner when this fails, which on its own reads as
          a control that ignored the click. */}
      <SaveStatus state={save.state} className="mt-1" />
    </label>
  )
}
