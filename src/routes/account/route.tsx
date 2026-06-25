import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HardLaunchOnly } from "../../lib/launchMode";

// Layout for the whole /account section. During soft launch the account area
// is removed — members only need /setup (which is gated separately and stays
// reachable) — so every /account/* route redirects to the soft-launch landing.
export const Route = createFileRoute("/account")({
  component: () => (
    <HardLaunchOnly>
      <Outlet />
    </HardLaunchOnly>
  ),
});
