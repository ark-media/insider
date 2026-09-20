import { createFileRoute } from '@tanstack/react-router'
import { useSubscriberAuth } from '../lib/subscriberAuth'
import { useEffect, useState } from 'react'
import { StatusPage } from '../components/StatusPage'

export const Route = createFileRoute('/logout')({
  component: LogoutComponent,
})

// /logout used to sign the visitor out the moment it rendered. That made it a
// forced-logout gadget: the server's /api/auth/logout refuses cross-site
// requests (Sec-Fetch-Site), but a cross-site LINK to /logout is just a page
// load, and the request this page then fires is same-origin — so any site, or
// any email, could end a member's session with one <a href>. Nuisance-grade on
// its own, but it is also the first half of a login-CSRF.
//
// So the automatic sign-out now needs evidence the visit started INSIDE the
// app. Either of:
//   - the document didn't load at /logout — i.e. the router brought us here
//     from another page of ours. The Navigation Timing entry is the URL the
//     document was actually loaded with; pushState can't rewrite it and a
//     cross-site page can't influence it.
//   - the referrer is our own origin (a plain <a href="/logout"> on one of our
//     pages). Redirects keep the
//     ORIGINAL referrer, so bouncing through an open redirect doesn't launder a
//     foreign one into ours, and Referrer-Policy can only blank it, not forge it.
// Anything else — a typed URL, a bookmark, a link from another site or an
// email — gets a one-button confirmation instead. (The masthead and /account
// "Sign out" controls don't come through here at all: they call signOut()
// directly, so they stay one click.)
function arrivedFromInsideApp(): boolean {
  try {
    const [entry] = performance.getEntriesByType('navigation')
    if (entry && new URL(entry.name).pathname !== '/logout') return true
  } catch {
    // No Navigation Timing (or an unparseable entry) — fall through.
  }
  try {
    if (!document.referrer) return false
    return new URL(document.referrer).origin === window.location.origin
  } catch {
    return false
  }
}

function LogoutComponent() {
  const { signOut } = useSubscriberAuth()
  // Decided once: both signals describe how the document was reached, which
  // can't change while this component is mounted.
  const [automatic] = useState(arrivedFromInsideApp)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (automatic) signOut()
  }, [automatic, signOut])

  return automatic || confirmed ? (
    <div className="flex min-h-dvh items-center justify-center bg-navy-900">
      <p className="text-fg-strong">Signing out…</p>
    </div>
  ) : (
    <StatusPage
      eyebrow="Sign out"
      title="Sign out of Ark Media?"
      message="This will end your session on this device. You can sign back in any time with your email."
      actions={
        <>
          <button
            type="button"
            onClick={() => {
              setConfirmed(true)
              signOut()
            }}
            className="inline-flex items-center gap-2 bg-cyan px-5 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Sign out
          </button>
          <a
            href="/"
            className="inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Stay signed in
          </a>
        </>
      }
    />
  )
}
