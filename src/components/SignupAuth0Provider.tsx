import { Auth0Provider } from "@auth0/auth0-react";
import type { AppState } from "@auth0/auth0-react";
import type { ReactNode } from "react";
import { AUTH0_AUDIENCE } from "../../shared/auth0-claims";

function handleRedirectCallback(appState?: AppState) {
  const returnTo = appState?.returnTo as string | undefined;
  if (returnTo && returnTo !== window.location.pathname + window.location.search) {
    window.location.replace(returnTo);
  }
}

export function SignupAuth0Provider({ children }: { children: ReactNode }) {
  return (
    <Auth0Provider
      domain="auth.ark-plus.xyz"
      clientId="1T1u9VRHbSWxOwy8OX5PVYw9BdPNtAvp"
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: AUTH0_AUDIENCE,
      }}
      onRedirectCallback={handleRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
}
