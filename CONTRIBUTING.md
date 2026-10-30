# Contributing

This repository ships from `main` on merge: Workers Builds builds and deploys, so **a merged commit is a
release**. There is no manual deploy step, and no manual merge.

## The loop every change goes through

1. Branch, commit, open a PR against `main`. Keep it under ~100 changed files — the review bot's per-review
   limit is 100–300 files (it varies with the repository's stars), and past the limit the PR gets no review at
   all.
2. Let the mechanical checks finish (Workers Builds, and any Actions added later). Fix anything red **before**
   asking for a review — a review spent on a broken build is a review wasted.
3. Ask for the review: comment `@coderabbitai review` (incremental) or `@coderabbitai full review` (from
   scratch). A public repository under 10 stars never gets an automatic review, so this step is mandatory.
4. Work the review. Every comment gets a fix, or a reply on its own thread explaining why the finding does not
   hold — with the evidence. Then trigger the review again. Repeat until CodeRabbit approves.
5. Merge. `main` is protected: one approving review and a green Workers Builds check are required, and the
   deployment happens from the merge, never from a terminal.

## What a change has to bring

- **A failing test first, then the change**, and the test proves three things: the positive case, the negative
  case and the error case. A story with only a happy-path test is not done.
- `npm run check` green.
- No third-party anything under `public/` — no CDN, no web font, no analytics, no inline handler.
- Nothing readable in a frame: names, amounts, descriptions and splits are sealed in the browser before they
  are sent, and the group code never leaves it.
- Copy that a reader can check: no claim the behaviour does not keep.
