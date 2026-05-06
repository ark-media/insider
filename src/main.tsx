import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { router } from './router'
import { Gate } from './Gate.tsx'
import { SignupAuth0Provider } from './components/SignupAuth0Provider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gate>
      <SignupAuth0Provider>
        <RouterProvider router={router} />
      </SignupAuth0Provider>
    </Gate>
  </StrictMode>,
)
