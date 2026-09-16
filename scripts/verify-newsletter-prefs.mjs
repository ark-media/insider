/**
 * Browser smoke test for /account/newsletters.
 * Run: bun run dev, then APP_BASE_URL=http://localhost:5174 bun run scripts/verify-newsletter-prefs.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:5173";

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(`${BASE}/account/newsletters`, {
    waitUntil: "domcontentloaded",
  });

  await Promise.race([
    page.waitForURL(/\/plus\/?/, { timeout: 10_000 }),
    page.getByText("Pick what lands in your inbox.").waitFor({ timeout: 10_000 }),
  ]).catch(() => {});

  const url = page.url();
  const onPlus = /\/plus\/?$/.test(new URL(url).pathname);
  const hasPrefsHeading =
    (await page.getByText("Pick what lands in your inbox.").count()) > 0;
  const hasLoadingOrToggle =
    (await page.getByText("Loading preferences…").count()) > 0 ||
    (await page.getByRole("switch").count()) > 0;

  await browser.close();

  const ok = onPlus || (hasPrefsHeading && hasLoadingOrToggle);

  console.log(
    JSON.stringify(
      {
        ok,
        finalUrl: url,
        redirectedToPlus: onPlus,
        hasPrefsHeading,
        hasLoadingOrToggle,
        consoleErrors: consoleErrors.slice(0, 5),
        note: onPlus
          ? "Guest redirect to /plus — expected without Auth0 session."
          : "Authenticated — prefs UI rendered.",
      },
      null,
      2,
    ),
  );

  if (!ok) process.exit(1);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
