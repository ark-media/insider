import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { SpeedInsights } from '@vercel/speed-insights/react'
import './index.css'
import { router } from './router'
import { Gate } from './Gate.tsx'
import {
  initObservability,
  pauseReplayIfSensitive,
  resumeReplayIfSafe,
  stashUrlCredentials,
} from './lib/observability'
import { ThemeProvider } from './lib/theme.tsx'

// ORDER MATTERS. Sentry reads location.href synchronously inside init (pageload
// span, request context) and PostHog sends its first $pageview from it, so the
// gift credentials have to be out of the address bar before either SDK exists.
// /redeem picks them up from the holder instead of the URL.
stashUrlCredentials()
initObservability()

// No session replay on /account* or /admin*. Pause before the sensitive route
// loads; resume only after the page that replaced it has rendered (see the
// comment on pauseReplayIfSensitive for why those are different events).
// onBeforeLoad rather than onBeforeNavigate: the latter is skipped for
// redirects, and a redirect INTO /account is still an arrival.
router.subscribe('onBeforeLoad', ({ toLocation }) => pauseReplayIfSensitive(toLocation.pathname))
router.subscribe('onRendered', ({ toLocation }) => resumeReplayIfSafe(toLocation.pathname))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Gate>
        <RouterProvider router={router} />
      </Gate>
      <SpeedInsights />
    </ThemeProvider>
  </StrictMode>,
)
