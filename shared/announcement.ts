// API shape for an announcement banner (camelCase). Single source of truth for
// the client/server contract: the server maps DB rows to it, the client renders
// it. Write-side shapes (the server's validated AnnouncementInput and the client
// editor's AnnouncementDraft) stay separate — they're not the same concern.

export type Announcement = {
  id: string
  body: string
  actionUrl: string | null
  barColor: string
  textColor: string
  dismissible: boolean
  enabled: boolean
  startsAt: string
  endsAt: string
  createdAt: string
  updatedAt: string
}
