import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { router } from './router'
import { Gate } from './Gate.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      afterSignOutUrl="/"
    >
      <Gate>
        <RouterProvider router={router} />
      </Gate>
    </ClerkProvider>
  </StrictMode>,
)
