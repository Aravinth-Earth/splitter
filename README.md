# Splitter

Split money with people you are actually with. One person creates a group, shares a 16-character code,
everyone's expenses land on every screen live, and the server holds nothing it can read.

The code **is** the key. The browser stretches it into an AES-256-GCM key, seals every name, amount and split
before anything leaves the page, and the Worker only ever sees ciphertext plus the ids, revisions and timestamps
it needs to route and order it. No accounts, no email, no analytics, no third-party script.

**Live:** <https://www.332321.xyz/w/expense-splitter/> · **Status:** in development — the page above still serves
the older local-only version until the cutover.

## What the server knows, and what it cannot do

| The server holds | The server never sees |
| --- | --- |
| a group id (a hash of the code), member ids, one revision number per record, which member wrote which record, sealed blob lengths, timestamps | the code, the key, group names, member names, descriptions, amounts, payers, splits |

Three consequences worth stating before you trust it:

- **A leaked code cannot be revoked.** Anyone holding it can decrypt everything and cannot be locked out. Rotating
  the code (re-sealing every record under a new key) is planned work, not shipped behaviour.
- **The server enforces structure, not meaning.** It can refuse an oversized blob, an unknown record kind, a stale
  revision or an unapproved writer. It cannot check that a split sums to its amount, because it cannot read either
  number. That check is the client's.
- **A malicious server can withhold or replay an old version** to a device that never saw the newer one. It still
  cannot read anything.

## Shape

- **Worker** serves the page and the API on the site's own origin, with the site's CSP.
- **One Durable Object per group**, one storage key per record, plus a singleton registry that caps how many groups
  may be live.
- **No build step** in the browser bundle: plain ES modules, no bundler, no dependency.
- **Money is integer paise** end to end; the remainder of a division goes to the largest share.
- **Conflicts are per record**: a write names the revision it was based on, and a refused write is merged
  field-by-field rather than overwriting a peer.

## Requirements and roadmap

The work-item tree (epic → feature → user story → task) is maintained in a private tracker, not in this repo.
Issues are disabled here. Bug reports and questions are welcome by email, not as issues.

## Development

```bash
npm run dev     # wrangler dev
npm run check   # guards: no third-party refs, no inline handlers, no personal details, no banned copy
npm test        # node:test — crypto, and the Worker's routes against a throwaway wrangler dev
```

`npm run e2e` — two real Chromium profiles against a live Worker — is planned, not written yet.

**Deploys come from `main`.** Workers Builds is connected to this repository, so a merge to `main` builds and
deploys. A manual `wrangler deploy` is break-glass only; prove what is live with

```bash
curl -s https://www.332321.xyz/w/expense-splitter/api/health   # {"ok":true,"version":"…"}
```

## Licence

AGPL-3.0-or-later. If you run a modified version as a network service, Section 13 requires you to offer its
source to the people using it.
