/**
 * Guards for the browser bundle.
 *
 * The promise on the page is "no third-party anything, ever", so an accidental CDN link, font,
 * analytics snippet or tracking pixel has to fail the build rather than ship. Also syntax-checks
 * every module, refuses copy that overclaims, and keeps personal details out of a page strangers
 * load.
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

/* 1. Every browser module must parse. */
for (const file of assets.filter((path) => path.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${relative(root, file)}: ${String(error.stderr || error.message).trim()}`);
  }
}

/* 2. No outbound requests to anyone but this origin. */
const allowedHosts = /^(?:[a-z]+:\/\/)?(?:www\.)?332321\.xyz|localhost|127\.0\.0\.1/i;
const urlPattern = /\bhttps?:\/\/[^\s"'<>)]+/gi;
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
const bannedCopy = ['no data sent anywhere', 'no data ever leaves'];
/* Nothing personal belongs in a page strangers load. */
const personal = ['Aravinth', '@332321.xyz', 'simplelogin'];

for (const file of assets) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(urlPattern)) {
    if (allowedHosts.test(match[0])) continue;
    problems.push(`${relative(root, file)}: external URL ${match[0]}`);
    break;
  }
  for (const banned of bannedHosts) {
    if (text.includes(banned)) problems.push(`${relative(root, file)}: contains "${banned}"`);
  }
  for (const phrase of bannedCopy) {
    if (text.toLowerCase().includes(phrase)) problems.push(`${relative(root, file)}: overclaiming copy "${phrase}"`);
  }
  for (const who of personal) {
    if (text.includes(who)) problems.push(`${relative(root, file)}: personal detail "${who}" in a public asset`);
  }
  /* The CSP has no 'unsafe-inline' for scripts, so an inline handler would simply not run. */
  if (file.endsWith('.html')) {
    const inline = text.match(/\son[a-z]+\s*=/gi);
    if (inline) problems.push(`${relative(root, file)}: inline event handler ${inline[0].trim()}`);
  }
}

if (problems.length) {
  console.error('check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`check passed: ${assets.length} assets, no third-party references, no overclaiming copy`);
