#!/usr/bin/env node
// SSRF boundary: stealthFetch only accepts http: and https: URLs. It does not
// guard private IPs, metadata hosts such as 169.254.x.x, or localhost; callers
// must treat the URL as already inside their trust boundary.

import { pathToFileURL } from "node:url";

export class CloakBrowserUnavailableError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_UNTIL = "load";
const SUPPORTED_PLATFORMS = new Set([
  "linux:x64",
  "linux:arm64",
  "darwin:x64",
  "darwin:arm64",
  "win32:x64",
]);
const EXIT_CODES = {
  not_installed: 3,
  unsupported_platform: 4,
  runtime_error: 5,
  blocked_scheme: 6,
};

function isSupportedPlatform(platform, arch) {
  return SUPPORTED_PLATFORMS.has(`${platform}:${arch}`);
}

function isModuleNotFound(error) {
  return (
    error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND"
  );
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function responseStatus(response) {
  if (!response) return null;
  if (typeof response.status === "function") return response.status();
  return response.status ?? null;
}

function responseUrl(response, fallbackUrl) {
  if (!response) return fallbackUrl;
  if (typeof response.url === "function") return response.url();
  return response.url ?? fallbackUrl;
}

function parseAllowedFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, scheme: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, scheme: parsed.protocol };
  }
  return { ok: true, href: parsed.href };
}

async function closeBrowser(browser) {
  if (!browser || typeof browser.close !== "function") return;
  try {
    await browser.close();
  } catch {
    // best effort: fetch callers only need the primary result signal
  }
}

export async function stealthFetch(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waitUntil = opts.waitUntil ?? DEFAULT_WAIT_UNTIL;
  const loadCloakBrowser = opts._import ?? (() => import("cloakbrowser"));
  const platform = opts._platform ?? process.platform;
  const arch = opts._arch ?? process.arch;

  if (!isSupportedPlatform(platform, arch)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      platform,
      arch,
    };
  }

  const parsedUrl = parseAllowedFetchUrl(url);
  if (!parsedUrl.ok) {
    return {
      ok: false,
      reason: "blocked_scheme",
      scheme: parsedUrl.scheme,
    };
  }

  let cloakbrowser;
  try {
    cloakbrowser = await loadCloakBrowser();
  } catch (error) {
    if (isModuleNotFound(error)) return { ok: false, reason: "not_installed" };
    return { ok: false, reason: "runtime_error", error: String(error) };
  }

  let browser;
  try {
    const launch = cloakbrowser?.launch;
    if (typeof launch !== "function") {
      throw new CloakBrowserUnavailableError("cloakbrowser launch unavailable");
    }
    browser = await launch();
    const page = await browser.newPage();
    const response = await page.goto(parsedUrl.href, {
      waitUntil,
      timeout: timeoutMs,
    });
    const html = await page.content();
    return {
      ok: true,
      engine: "cloakbrowser",
      url: parsedUrl.href,
      finalUrl: responseUrl(response, parsedUrl.href),
      status: responseStatus(response),
      html,
      text: htmlToText(html),
    };
  } catch (error) {
    return { ok: false, reason: "runtime_error", error: String(error) };
  } finally {
    await closeBrowser(browser);
  }
}

export function exitCodeFor(result) {
  return EXIT_CODES[result?.reason] ?? 5;
}

export async function main(argv = process.argv) {
  const url = argv[2];
  if (!url) {
    console.error("usage: stealth-fetch <url>");
    process.exitCode = 2;
    return;
  }

  const result = await stealthFetch(url);
  if (result.ok) {
    console.log(JSON.stringify(result));
    process.exitCode = 0;
    return;
  }

  console.error(`[stealth-fetch] 폴백: ${result.reason}`);
  console.log(JSON.stringify(result));
  process.exitCode = exitCodeFor(result);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
