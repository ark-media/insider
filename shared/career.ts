// API shape for a careers/job posting (camelCase). Single source of truth for
// the client/server contract: the server maps DB rows to it, the client renders
// it. Write-side shapes (the server's validated CareerInput and the client
// editor's CareerDraft) stay separate — they're not the same concern.
//
// `summary` is the short blurb on the /careers list; `description` is sanitized
// HTML for the /careers/<slug> detail page; `applyUrl` is the external
// application link (for Ark, the per-role TestGorilla assessment).

export type Career = {
  id: string
  slug: string
  title: string
  team: string | null
  location: string | null
  employmentType: string | null
  summary: string
  description: string
  applyUrl: string | null
  enabled: boolean
  displayOrder: number
  createdAt: string
  updatedAt: string
}
