/**
 * Per-run Playwright walk. Copy to .clickthrough/inbox/walk.ts and add plan steps.
 * Pin: npm:playwright@1.58.0
 *
 * Required env:
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  (probe JSON chrome / playwright.chrome)
 *   CLICKTHROUGH_BASE_URL                (user-confirmed http(s) origin)
 *
 * Never run with deno -A. See reference.md for the allowlist.
 */
import { chromium, type Browser, type Page } from "npm:playwright@1.58.0";

const GOTO_MS = 15_000;
const CLOSE_MS = 8_000;

const chrome =
  Deno.env.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")?.trim() ||
  Deno.env.get("CHROME_PATH")?.trim() ||
  "";
const baseURL = Deno.env.get("CLICKTHROUGH_BASE_URL")?.trim() || "";

if (!chrome) {
  console.error("clickthrough walk: set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH from probe JSON chrome");
  Deno.exit(1);
}
if (!baseURL) {
  console.error("clickthrough walk: set CLICKTHROUGH_BASE_URL to the confirmed origin");
  Deno.exit(1);
}

let parsed: URL;
try {
  parsed = new URL(baseURL);
} catch {
  console.error("clickthrough walk: CLICKTHROUGH_BASE_URL is not a URL");
  Deno.exit(1);
}
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
  console.error("clickthrough walk: only http(s) origins are allowed");
  Deno.exit(1);
}

const origin = parsed.origin;

function isTrustedLocal(url: URL): boolean {
  const h = url.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "host.docker.internal" ||
    h === "dwp.solutions" ||
    h.endsWith(".dwp.solutions")
  );
}

function launchArgs(url: URL): string[] {
  const args = ["--disable-dev-shm-usage"];
  if (isTrustedLocal(url)) args.unshift("--no-sandbox");
  return args;
}

function chromeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const home = Deno.env.get("HOME");
  if (home) env.HOME = home;
  for (const key of [
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
    "CHROME_PATH",
    "CLICKTHROUGH_BASE_URL",
    "DISPLAY",
  ]) {
    const v = Deno.env.get(key);
    if (v) env[key] = v;
  }
  return env;
}

function assertSameOrigin(page: Page, confirmed: string) {
  const raw = page.url();
  if (!raw || raw === "about:blank" || raw.startsWith("about:")) return;
  const next = new URL(raw).origin;
  if (next !== confirmed) {
    throw new Error(`clickthrough walk: off-origin ${next} (confirmed ${confirmed})`);
  }
}

async function closeBrowser(browser: Browser | undefined) {
  if (!browser) return;
  await Promise.race([
    browser.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("browser.close timeout")), CLOSE_MS)),
  ]).catch(() => {});
}

let browser: Browser | undefined;
let exitCode = 0;
try {
  browser = await chromium.launch({
    executablePath: chrome,
    args: launchArgs(parsed),
    env: chromeEnv(),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(GOTO_MS);
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: GOTO_MS });
  assertSameOrigin(page, origin);
  // Do not fail from a framenavigated listener. Re-assert origin after each later navigation.
  await Deno.mkdir(".clickthrough/inbox/shots", { recursive: true });
  await page.screenshot({ path: ".clickthrough/inbox/shots/origin.png" });
  assertSameOrigin(page, origin);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  await closeBrowser(browser);
}
Deno.exit(exitCode);
