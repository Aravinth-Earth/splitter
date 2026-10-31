# Contributing

A merged commit is a release: Workers Builds deploys `main` on merge. There is no manual `wrangler deploy`,
and a branch build only uploads a preview version — it never takes production traffic.

## The loop every cycle runs

1. **Pick a set of work items** small enough to land in one PR. Keep it under ~100 changed files.
2. **Test first.** Write the failing test, watch it fail, implement until it passes, then re-run the whole
   local suite. Each item brings three tests: the positive case, the negative case and the error case.
   Patch tests and code together until the local suite is green — a fix that weakens a test is not a fix.
3. **Commit in technical language only**: what changed, where, and how it was verified. No reasoning, no
   story, no conversation, no personal detail.
4. **Push and open the PR.**
5. **Deep review** by a focused reviewer against `docs/review-brief.md`: every finding is classified by
   severity, fixed, or filed as a backlog item when it cannot land in this PR. The review is re-run until
   nothing actionable is left.
6. **The owner merges.** A green run or a reviewer's verdict is not permission: the repository owner reads
   the pull request and merges it. No auto-merge, no admin bypass, no merge by a contributor's tooling.
7. **Verify the deployment**: exercise the live URL and run the whole regression suite against it, not just
   the new tests.
8. **Any failure is a bug**: a patch branch, its own review, merge, retest. Then the cycle restarts at step 1
   until the work items are done.

## Non-negotiables

- No third-party anything under `public/` — no CDN, no web font, no analytics, no inline handler.
- Nothing readable in a frame: names, amounts, descriptions and splits are sealed in the browser, and the
  group code never leaves it.
- Copy a reader can check: no claim the behaviour does not keep.
- `npm run check` green before a review is asked for.
