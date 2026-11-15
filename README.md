# Splitter

Split money with people you are actually with. One person creates a group, shares a 16-character code,
everyone's expenses land on every screen live, and the server holds nothing it can read.

The code **is** the key. The browser stretches it into an AES-256-GCM key, seals every name, amount and split
before anything leaves the page, and the Worker only ever sees ciphertext plus the ids, revisions and timestamps
it needs to route and order it. No accounts, no email, no analytics, no third-party script.

**Live:** <https://expense-splitter.332321.xyz/> · **Status:** in development — groups, the ledger, balances,
settlements, edits, delete, charts, export and import are live. The introduction to the product lives at
<https://www.332321.xyz/w/expense-splitter/>.

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

## Export and import

**Export JSON** downloads one readable file. It is built in the browser from decrypted values, so anyone who
opens it can read every name and amount; the page says so before the button. The filename is
`splitter-YYYY-MM-DD-HHMM.json` in local time, never the group name.

**Import JSON** is offered to the organizer. The whole file is validated before anything is written: a bad
schema, a missing field, a non-integer amount or a split that does not total its expense changes nothing and
names the first failing field. Importing into a group that already has records asks first and states the count.
Imported people become approved roster participants with no login secret, so every device resolves their names
but nobody can sign in as them. A name already in the group gets a suffix (`Name (2)`), never a silent merge.
Every imported record is re-sealed under the current group key, so a file from another group cannot be read
with its key. Importing does not rename the target group or change its currency; a file whose currency differs
from the group's is refused.

`splitter.group/1`:

| Path | Meaning |
| --- | --- |
| `schema` | the literal `splitter.group/1` |
| `group.name` | the group's display name |
| `group.currency` | `INR`, `EUR`, `USD` or `GBP` |
| `members[].name` | a participant's display name, unique in the file |
| `members[].status` | `approved`, `pending` or `removed` |
| `expenses[].description` | what was bought, at most 120 characters |
| `expenses[].amountPaise` | the amount as an integer number of paise |
| `expenses[].paidBy[].name` | a member name |
| `expenses[].paidBy[].amountPaise` | that payer's integer paise; the list totals `amountPaise` |
| `expenses[].split[].name` | a member name |
| `expenses[].split[].amountPaise` | that member's integer paise; the list totals `amountPaise` |
| `expenses[].date` | `YYYY-MM-DD` |
| `expenses[].time` | `HH:MM` |
| `expenses[].note` | free text, at most 500 characters |
| `settlements[].from` | the payer's member name |
| `settlements[].to` | the receiver's member name |
| `settlements[].amountPaise` | the payment as integer paise |
| `settlements[].date` | `YYYY-MM-DD` |
| `settlements[].time` | `HH:MM` |
| `settlements[].note` | free text, at most 500 characters |
| `exportedAt` | ISO-8601 timestamp with the writer's offset |

The file carries no group code, group id, member id, key, ciphertext, IV or room URL.

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

### Deploy

**Workers Builds is the only deploy path.** The Cloudflare GitHub app is installed on this repository, and the
Workers Builds connection builds `main` on every merge. A branch push only uploads a preview version; it never
takes production traffic, and no Cloudflare credential is stored in the repository or used from a laptop.

If a merged build does not appear live, open the failed **Workers Builds: splitter** check on the commit (or the
build in the Cloudflare dashboard) and retry it there. Do not run `wrangler deploy` locally: it deploys under a
personal OAuth login, bypasses the version the merge produced, and leaves production with no commit to point at.

Prove what is live with

```bash
curl -s https://expense-splitter.332321.xyz/api/health   # {"ok":true,"version":"…"}
```

## Licence

AGPL-3.0-or-later. If you run a modified version as a network service, Section 13 requires you to offer its
source to the people using it.
