import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout for the whole /account section.
export const Route = createFileRoute("/account")({
  component: Outlet,
});
