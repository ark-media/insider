// API shape for a FAQ entry (camelCase). Single source of truth for the
// client/server contract: the server maps DB rows to it, the client renders it.
// Write-side shapes (the server's validated FaqInput and the client editor's
// FaqDraft) stay separate — they're not the same concern.
//
// `question` is plain text; `answer` is sanitized HTML (paragraphs + inline
// formatting and links) rendered on the /plus FAQ section. `category` is a
// plain-text section heading (e.g. "Choosing a Subscription") used to group
// questions in the accordion; empty string means ungrouped.
//
// `key` is a stable slug that code binds to — the help widget's topic table
// points at FAQs by key so that rewording a question, reordering the list, or
// reseeding the table (which changes every `id`) doesn't break the binding.
// Null for rows nobody references; unique when set.

export type Faq = {
  id: string
  key: string | null
  question: string
  answer: string
  category: string
  enabled: boolean
  displayOrder: number
  createdAt: string
  updatedAt: string
}
