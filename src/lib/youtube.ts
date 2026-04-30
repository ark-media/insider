/**
 * Mock YouTube Data API client.
 *
 * Real implementation would call YouTube Data API v3 (videos.list) for the
 * Ark Media channel and project to the {@link YouTubeVideo} shape.
 */

export type YouTubeVideo = {
  id: string;
  title: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelTitle: string;
};

const FAKE_LATENCY_MS = 70;

function jitter(ms = FAKE_LATENCY_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 40));
}

const fixtures: YouTubeVideo[] = [
  {
    id: "yt-001",
    title: "Call Me Back — the day after",
    publishedAt: "2026-04-27",
    thumbnailUrl:
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    channelTitle: "Ark Media",
  },
  {
    id: "yt-002",
    title: "What's Your Number — 14%",
    publishedAt: "2026-04-22",
    thumbnailUrl:
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    channelTitle: "Ark Media",
  },
  {
    id: "yt-003",
    title: "For Heaven's Sake — what we owe each other",
    publishedAt: "2026-04-24",
    thumbnailUrl:
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    channelTitle: "Ark Media",
  },
];

export async function fetchLatestVideos(
  limit = 6,
): Promise<YouTubeVideo[]> {
  await jitter();
  return fixtures.slice(0, limit);
}
