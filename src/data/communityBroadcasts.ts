export type CommunityBroadcast = {
  id: string;
  authorName: string;
  authorRole: string;
  publishedAt: string;
  /** Short pull-quote / preview shown on /community */
  excerpt: string;
  body: string;
  /** Member-authored posts marked public by the editorial team. */
  visibility: "public-with-permission";
};

/**
 * Selected member posts marked public for use on /community.
 * In production, these would be pulled from Circle's headless admin token.
 */
export const communityBroadcasts: CommunityBroadcast[] = [
  {
    id: "cb-001",
    authorName: "Sarah K.",
    authorRole: "Member, Tel Aviv",
    publishedAt: "2026-04-26",
    excerpt:
      "What it actually feels like to be a member of this community in week 82.",
    body:
      "I joined Ark+ for the podcast feed and stayed for the room. There's a thread running right now about the Cairo readout that has three people I'd never have met otherwise, all sharper than I am, and one of them is in the room with me on a watch party tonight. This is what I was looking for and didn't know how to ask for.",
    visibility: "public-with-permission",
  },
  {
    id: "cb-002",
    authorName: "Daniel R.",
    authorRole: "Member, Toronto",
    publishedAt: "2026-04-22",
    excerpt:
      "Three things the show didn't say, that the room is saying.",
    body:
      "After the episode dropped on Sunday, the discussion thread filled up with three things that didn't make the cut — and one of them turned out to be the most useful read of the week. The community sometimes does the work the show can't.",
    visibility: "public-with-permission",
  },
  {
    id: "cb-003",
    authorName: "Lior B.",
    authorRole: "Member, Jerusalem",
    publishedAt: "2026-04-18",
    excerpt:
      "An invitation to the Friday-morning members' coffee in Jerusalem.",
    body:
      "Friday morning, 9am, same coffee shop as last month. Five members from the community have started meeting in person. If you're an Ark+ member and you're in the city, the invitation is open.",
    visibility: "public-with-permission",
  },
];
