import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { SpeedInsights } from '@vercel/speed-insights/react'
import './index.css'
import { router } from './router'
import { Gate } from './Gate.tsx'
import { SignupAuth0Provider } from './components/SignupAuth0Provider.tsx'
import { initObservability } from './lib/observability'
import { ThemeProvider } from './lib/theme.tsx'

initObservability()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Gate>
        <SignupAuth0Provider>
          <RouterProvider router={router} />
        </SignupAuth0Provider>
      </Gate>
      <SpeedInsights />
    </ThemeProvider>
  </StrictMode>,
)
