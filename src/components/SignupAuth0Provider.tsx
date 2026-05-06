import { Auth0Provider } from "@auth0/auth0-react";
import type { ReactNode } from "react";

export function SignupAuth0Provider({ children }: { children: ReactNode }) {
  return (
    <Auth0Provider
      domain="auth.ark-plus.xyz"
      clientId="1T1u9VRHbSWxOwy8OX5PVYw9BdPNtAvp"
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: 'https://ark-plus.xyz/api',
      }}
    >
      {children}
    </Auth0Provider>
  );
}
