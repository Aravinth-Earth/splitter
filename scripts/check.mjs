/**
 * Guards for the browser bundle.
 *
 * The promise on the page is "no third-party anything, ever", so an accidental CDN link, font,
 * analytics snippet or tracking pixel has to fail the build rather than ship. Also syntax-checks
 * every module, refuses copy that overclaims, and keeps personal details out of a page strangers
 * load.
 *
 * Every absence check is paired with a presence check: a scan that inspects nothing passes
 * vacuously, which is the failure mode this file exists to prevent.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');

const problems = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const assets = walk(publicDir);

/* 0. A scan over nothing proves nothing. */
if (assets.length === 0) {
  console.error(`check failed: no assets found under ${publicDir}`);
  process.exit(1);
}

/* 1. Every browser module must parse. */
for (const file of assets.filter((path) => path.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${relative(root, file)}: ${String(error.stderr || error.message).trim()}`);
  }
}

/* 2. No outbound requests to anyone but this origin. The host is compared whole, so
   `332321.xyz.attacker.example` and a `localhost` that only appears in a path cannot pass. */
const allowedHosts = new Set(['332321.xyz', 'www.332321.xyz', 'localhost', '127.0.0.1']);
const urlPattern = /\bhttps?:\/\/[^\s"'<>)]+/gi;
/* `src="//host/x"` loads a third party without ever spelling a scheme. */
const protocolRelativePattern = /\b(?:src|href)\s*=\s*["']\/\/[^"']+/gi;
const bannedHosts = [
  'google-analytics',
  'googletagmanager',
  'gtag(',
  'plausible.io',
  'posthog',
  'sentry.io',
  'cdn.jsdelivr',
  'unpkg.com',
  'cdnjs',
  'goatcounter',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];
/* Copy that would be a lie: ciphertext does go to our own Worker. */
const bannedCopy = ['no data sent anywhere', 'no data ever leaves', 'only ever holds ciphertext'];
/* Nothing personal belongs in a page strangers load. */
const personal = ['aravinth', '@332321.xyz', 'simplelogin'];

for (const file of assets) {
  const text = readFileSync(file, 'utf8');
  /* Rendered whitespace collapses, so a phrase split across a line break still reads as itself. */
  const flat = text.toLowerCase().replace(/\s+/g, ' ');

  for (const match of text.matchAll(urlPattern)) {
    let host;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      problems.push(`${relative(root, file)}: unparseable URL ${match[0]}`);
      continue;
    }
    if (allowedHosts.has(host)) continue;
    problems.push(`${relative(root, file)}: external URL ${match[0]}`);
    break;
  }

  for (const match of text.matchAll(protocolRelativePattern)) {
    problems.push(`${relative(root, file)}: protocol-relative URL ${match[0].trim()}`);
    break;
  }

  for (const banned of bannedHosts) {
    if (flat.includes(banned)) problems.push(`${relative(root, file)}: contains "${banned}"`);
  }
  for (const phrase of bannedCopy) {
    if (flat.includes(phrase)) problems.push(`${relative(root, file)}: overclaiming copy "${phrase}"`);
  }
  for (const who of personal) {
    if (flat.includes(who)) problems.push(`${relative(root, file)}: personal detail "${who}" in a public asset`);
  }
  /* The CSP has no 'unsafe-inline' for scripts, so an inline handler would simply not run. */
  if (file.endsWith('.html')) {
    const inline = text.match(/\son[a-z]+\s*=/gi);
    if (inline) problems.push(`${relative(root, file)}: inline event handler ${inline[0].trim()}`);
  }
}

/* 4. Every Worker route is one Cloudflare accepts. Wildcards are allowed only at the beginning of
   the hostname and at the end of the path; a host-only pattern such as `app.example.com*` is
   refused by the API (code 10022) at deploy time, after the merge and outside every local dry
   run. Catch it here instead. */
const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');
const routePatterns = [...wrangler.matchAll(/^\s*pattern\s*=\s*"([^"]+)"/gm)].map((match) => match[1]);
if (routePatterns.length === 0) {
  problems.push('wrangler.toml: no Worker route pattern found, so the route guard proves nothing');
}
for (const pattern of routePatterns) {
  const slash = pattern.indexOf('/');
  if (slash === -1) {
    problems.push(`wrangler.toml: route "${pattern}" has no path; Cloudflare allows a wildcard only at the end of the path`);
    continue;
  }
  const host = pattern.slice(0, slash);
  const path = pattern.slice(slash);
  const hostStars = (host.match(/\*/g) || []).length;
  const pathStars = (path.match(/\*/g) || []).length;
  if (hostStars && !(hostStars === 1 && host.startsWith('*.'))) {
    problems.push(`wrangler.toml: route "${pattern}" may use a wildcard only at the start of the hostname`);
  }
  if (pathStars && !(pathStars === 1 && path.endsWith('*'))) {
    problems.push(`wrangler.toml: route "${pattern}" may use a wildcard only at the end of the path`);
  }
}

if (problems.length) {
  console.error('check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`check passed: ${assets.length} assets, no third-party references, no overclaiming copy, route patterns valid`);
