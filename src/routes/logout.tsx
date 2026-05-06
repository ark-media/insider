import { createFileRoute } from '@tanstack/react-router'
import { useSubscriberAuth } from '../lib/subscriberAuth'
import { useEffect } from 'react'

export const Route = createFileRoute('/logout')({
  component: LogoutComponent,
})

function LogoutComponent() {
  const { signOut } = useSubscriberAuth()

  useEffect(() => {
    signOut()
  }, [signOut])

  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy-900">
      <p className="text-white">Signing out…</p>
    </div>
  )
}
