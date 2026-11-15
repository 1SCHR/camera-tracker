# CLAUDE.md — camera-tracker (working name)

Project rules for Claude Code. Read this at the start of every session. If a request conflicts with these rules, say so and ask before doing it.

## What this project is

A free price-history and restock site for new, open-box, refurbished and used camera gear. It answers: Is this a fair price? New, refurb or used? When will it be back in stock? What's coming next?

- Launch brand: **Fujifilm**. Then Sony, Nikon, Micro Four Thirds (OM System, Panasonic), others. Canon last.
- The database schema supports **every brand from day one**. Adding a brand means adding rows, not changing code.
- PC parts are **out of scope** for now.
- **US only at launch.** "Gray market" means new stock without a US manufacturer warranty.
- Solo project by a college student. Free tiers only. Keep it simple, readable and cheap to run.
- The full plan lives outside this repo. When a rule here and a suggestion conflict, this file wins.

## Stack (confirmed 2026-11-14)

- Language: TypeScript everywhere. Approved dependencies: TypeScript, Astro, Wrangler, Vitest, @types/node. The esbuild and workerd install scripts stay blocked by npm until I approve them.
- Code and scheduled jobs: **public** GitHub repository + GitHub Actions cron on a **30-minute** schedule. Anyone can read the code and the terms sheet, so nothing private goes in the repo.
- Database: Cloudflare D1 (SQLite). Schema changes go in numbered migration files in `migrations/`.
- Site: static site (Astro preferred) deployed on Cloudflare Pages. One page per product, built from the database.
- Serverless: Cloudflare Workers for signups, magic-link login, watchlists and alert delivery.
- Collectors: scripts that fetch prices and write only **changes** to the database.
- Newsletter: Beehiiv (free plan). Alerts: email, Telegram, web push.
- Environments: local, preview (per branch), production (main branch only).

## Non-negotiable rules

### Data and scraping
1. Prefer official APIs and affiliate feeds. Scrape only sources whose terms and robots.txt allow it.
2. Never log in to scrape. Never solve CAPTCHAs. Never rotate proxies or spoof identities to avoid a block.
3. Respect robots.txt. Identify the bot with a contact email in the user-agent.
4. Poll each page at most every 15–30 minutes. Hot refurb pages: no more than every 5 minutes. Back off on errors and 429s.
5. Store facts only: price, in-stock flag, condition, seller, URL, timestamp, and the listing's raw title. The raw title is allowed because it's a short factual identifier needed for matching and review, not a description. Never store product descriptions or images.
6. Respect each source's caching limits. Best Buy data: 72 hours. Amazon: no displayed prices until the account qualifies.
7. Every source must have a row in `docs/terms-sheet.md` before its collector is written. If the row is missing or says "not allowed", stop and ask.
8. If a retailer asks us to stop, stop.
9. Collectors are idempotent: running one twice must not duplicate rows. Write to `observation` only when price or stock changes.

### Accuracy and trust
10. Never show a price without its source and a "last checked" time.
11. Never show a fair-price badge without enough data: at least 5 listing-days spread over at least 14 days. Otherwise say "not enough price history yet". A **listing-day** is one UTC day on which the source successfully checked that listing. Days when the source was down, or the listing wasn't checked, don't count and are never filled in from an earlier price. Medians use listing-days too, not raw `observation` rows, because `observation` only stores changes.
12. Listings that can't be matched with confidence go to a review queue. They never appear in public averages.
13. Kit and body-only are separate variants. Gray-market prices are shown separately and labeled. Never blend them.
14. Don't call any seller a scalper. State the price and the markup versus MSRP.
15. Rumors carry four fields: status (Official, Likely, Unverified, Speculative), source link, first-seen date, last-verified date. Titles start with "Rumor:". A rumor never triggers a push alert.
16. Every correction to a published price or claim is recorded in the public corrections log.

### Alerts and ethics
17. Free and paid users get restock alerts at the **same time**. Never build anything that sells speed.
18. No auto-buy, no add-to-cart links, no queue-bypass tips. Links go to the product page only.
19. Hot new items link to authorized retailers only. Link to a manufacturer's store only if the manufacturer has given written permission (the Fujifilm US store's terms forbid links from commercial sites without it).
20. No public API, RSS or webhook for scarce items.
21. Signup uses double opt-in and Cloudflare Turnstile. Rate-limit alerts per user per day and per product.
22. Links are ranked by price and availability, never by commission.

### Security and secrets
23. No secrets in code, config files, commits, logs or chat. Use environment variables and the GitHub and Cloudflare secrets stores. If a secret ever appears in the repo, tell me immediately so I can rotate it.
24. `.env` and local database files are in `.gitignore`.
25. Collect the minimum subscriber data: email, consent time, watchlist. Never sell or share it.
26. Local development uses fake subscribers only.

### Things you must never do on your own
27. Never send an email, newsletter or alert to real people on your own. Alerts start in **test mode**: every alert is logged as `held` and nothing reaches real people until I turn on a single go-live switch myself. Never flip that switch, or make code that flips it. **Each newsletter** still needs my individual approval before it's sent, even after go-live.
28. Never post to any social site, forum or community.
29. Never apply to an affiliate program, sign a contract or accept terms on my behalf.
30. Never edit the production database or deploy to production without my explicit go-ahead and a backup.
31. Never add a dependency, paid service or new data source without asking first.

## Data model (summary)

Tables: `brand`, `product`, `variant`, `msrp`, `source`, `condition`, `condition_map`, `listing`, `observation`, `listing_check_day`, `restock_event`, `release_item`, `correction`, `user`, `login_token`, `watchlist`, `alert_rule`, `alert_log`, `click_log`.

- `msrp` is per variant and region, with a source and date, because kits and bodies differ and MSRPs change.
- `listing_check_day` records each UTC day a listing was successfully checked (rule 11).
- `condition_map` maps each source's raw grade to the unified scale. Seller mappings are filled in by hand after reading each grading page.

Unified condition scale (map every seller's raw grade to one of these and keep the raw label): New · New (gray market) · Open box · Manufacturer refurbished · Seller refurbished · Used A · Used B · Used C · Unknown. Unknown is excluded from averages.

Matching order: identifiers (GTIN/UPC/part number) first, title parsing second, human review for anything below the confidence threshold. Bundles, memory-card kits, "for parts" listings and accessories are excluded unless a human maps them.

Fair-price score: (90-day median price in the same condition from comparison sellers − current price) ÷ 90-day median. Shown only with the minimum data in rule 11.

Comparison sellers (who counts toward each condition's median):
- **New:** manufacturer and authorized dealers.
- **Open box:** authorized dealers (for example B&H, Adorama, Best Buy), the manufacturer, and established used dealers.
- **Manufacturer refurbished:** the manufacturer's official refurb store (for example Fujifilm's), and authorized dealers selling the manufacturer's own certified refurbs.
- **Seller refurbished and used (A/B/C):** established used dealers only (for example MPB, KEH, and the used departments of B&H and Adorama).
- **Marketplace listings** (for example eBay), in any condition, are **never** in a median. They're shown separately and labeled **"asking prices"**, because they're active listings, not sold prices.

Refurb labeling: only the manufacturer's own certified refurbs go in `mfr_refurb`. A dealer's own "refurbished" label goes in `seller_refurb`. Manufacturer refurbished is always its own condition and is never blended with used or seller refurbished.

## Seed data (product catalog)

- Seed products live in `seed/<brand>.json`, one product per entry with its variants and a list of dated MSRP rows.
- **Every value carries a source URL.** Anything that can't be found on an acceptable source stays `"unknown"`. Never guess, never fill in from memory. `null` means "doesn't apply" (for example, color on a lens sold in one color), which is different from unknown.
- The loader refuses a product if a required field (`model_name`, `type`, `status`, and `mount` for bodies and lenses) is unknown.
- Acceptable sources, recorded as `source_type`:
  - `manufacturer`: the manufacturer's own product pages, store and press releases. Everything except GTIN must come from here.
  - GTIN only, in addition: `gs1` (GS1's official lookup), `box` (read off a real box), and `retailer`. A `retailer` GTIN needs **two independent authorized retailers showing the same number**, and both URLs are recorded.
  - Every GTIN must pass its check digit. A wrong GTIN is costly because the matcher trusts barcodes most.
- MSRP: launch MSRP from the press release, current MSRP from the manufacturer store's regular price. A sale price is never an MSRP.
- Limited editions are skipped at launch. If one shows up in real listings, the review queue surfaces it.
- Scope for Fujifilm: current X and GFX bodies, their common kits, the most-traded XF/XC/GF lenses, and popular discontinued bodies (the used market matters most).
- Data is gathered in batches (about 10 products at first). I spot-check about one in ten entries against the source page before the next batch. Reading specs and part numbers off pages is where slipped digits and mixed-up kit names happen.
- Reading manufacturer pages by hand for the seed still needs a row in `docs/terms-sheet.md` first.

## Code conventions

- Small, readable functions. Comments explain **why**, not what.
- Collectors, matcher and fair-price math must have tests. Keep a hand-labeled set of listings (`tests/match_set`) and fail the build if matching accuracy drops below 95%.
- Store times in UTC. Show a clear time zone on the site.
- Validate all external data before writing it. Treat every scraped value as untrusted.
- Handle failures visibly: if a source breaks, mark it "not currently tracked" instead of showing stale numbers.
- No clever one-liners that I can't read. I'm learning this codebase and have to understand it.

## Working style

- Plan first. For any non-trivial task, propose a short plan and wait for my OK before writing code.
- Work in small steps. Run what you build, show me real output, then continue.
- Explain changes in plain language. Tell me what could go wrong.
- Commit often with clear messages. Never commit secrets, scraped dumps or `.env` files.
- When something is ambiguous, ask rather than guess, especially about terms of service, legal wording and anything that affects what real people see.
- If you're not sure a claim on a page is accurate, flag it rather than writing it as fact.

## Commands

Fill these in as the project takes shape:

- Install: `npm install`
- Run site locally: `TODO` (Astro isn't set up yet)
- Run tests: `npm test` (or `npm run test:watch` to rerun on save). Tests use Node's built-in SQLite with the real migration files.
- Type check: `npm run typecheck`
- Run one collector locally: `TODO`
- Apply migrations locally: `npm run db:migrate:local` (builds the local D1 copy in `.wrangler/`)
- List local D1 tables: `npm run db:tables:local`
- Deploy preview: push a branch. Production: merge to `main` (only with my approval).

## Open decisions (ask me, don't assume)

- Final project name and domain (`camera-tracker` is a working name).
- Which sources have written approval or a feed.- Whether to launch a Telegram channel.
