# Project plan and log

Status as of 2026-11-07: `v1.0.0` is released. Nothing is in progress.

## Current state

- Release: [v1.0.0](https://github.com/rightkik/cursor-critters/releases/tag/v1.0.0), tagged on `34c6929`
- Demo and tuner: live on GitHub Pages, deployed from `main` at the repo root
- CDN install: jsDelivr `@1.0.0`, with both files checked against the tag
- Measured gzip sizes: 10,150 bytes for the JS and 1,302 bytes for the CSS (`gzip -9n`)
- Link sharing: Open Graph tags on the demo, and `docs/social-preview.png` as the GitHub social preview

## Decisions

- The first tag is `v1.0.0`, not `v1.1.0`, because no earlier version was ever released.
- `homepage` in `package.json` points at the demo, not the author's site.
- The demo footer credits PRESS.in.th and Rptic with brand-name links. The PRESS.in.th link goes to `/category/business/`, which is mostly English like the demo.
- The README, `package.json` `author` and the `src/` headers credit press.in.th only.
- Do not link `press.in.th/404` as a credit. It shows a critter, but it returns HTTP 404 with `noindex`.

## Next

1. Launch posts, for example Show HN and r/webdev. These can link the demo or the repo directly.
2. On hold until the owner asks: a page on press.in.th about how the physics works, in English. After that, consider pointing the demo footer link at it.

Not planned for now: npm publishing and README badges.

## Rules for future changes

- Any change to `src/` needs a new version tag and an updated CDN version in the README, because the `@1.0.0` files are fixed.
- Keep zero dependencies, no build step, and the public API, DOM ids and CSS class names.
- New HTML or CSS must meet WCAG AA contrast.
- Do not state sizes or timings that have not been measured.

## Log

### 2026-11-07

- Corrected the size figures in the README, `package.json` and the repo description.
- Pointed `homepage` at the demo.
- Added Rptic to the demo footer and raised muted text contrast from 4.12:1 to 6.15:1.
- Tagged and published `v1.0.0`, then added the jsDelivr install option to the README.
- Added Open Graph tags and a social preview image rendered by the library itself.
- Linked the demo footer to the press.in.th business section.
- Checked on the live site: Pages deployment, the demo, the tuner, and the README GIF.
