/**
 * The Ark Media team. Portraits live in `/public/team` (square 1024px).
 *
 * NOTE: names are provisional — the Drive files were labeled by first name only.
 * The four public figures below are spelled out with confidence; the rest keep
 * their first name until confirmed. `role` is intentionally left undefined
 * everywhere rather than guessed — fill in titles (and any full names) and they
 * surface automatically in the grid.
 */
export type TeamMember = {
  name: string;
  /** Title/role. Renders under the name when present. */
  role?: string;
  /** Square portrait served from /public/team. */
  photo: string;
};

export const team: TeamMember[] = [
  { name: "Dan Senor", photo: "/team/dan.jpg" },
  { name: "Amit Segal", photo: "/team/amit.jpg" },
  { name: "Nadav Eyal", photo: "/team/nadav.jpg" },
  { name: "Michal Lev-Ram", photo: "/team/michal.jpg" },
  { name: "Andrej", photo: "/team/andrej.jpg" },
  { name: "Ava", photo: "/team/ava.jpg" },
  { name: "Gabe", photo: "/team/gabe.jpg" },
  { name: "Ilan", photo: "/team/ilan.jpg" },
  { name: "Martin", photo: "/team/martin.jpg" },
  { name: "Matt", photo: "/team/matt.jpg" },
  { name: "Maya", photo: "/team/maya.jpg" },
  { name: "Moshe", photo: "/team/moshe.jpg" },
];
