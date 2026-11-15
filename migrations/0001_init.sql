-- Migration 0001: initial schema for camera-tracker.
--
-- Conventions used in every table (see CLAUDE.md):
--   * Prices are whole cents (INTEGER), so money math never has rounding errors.
--   * Times are UTC text like '2026-11-14T20:48:00Z'. D1 has no date type, and
--     this format sorts correctly as plain text. Dates (no time) are 'YYYY-MM-DD'.
--   * Booleans are INTEGER 0 or 1.
--   * Fixed lists of allowed values use CHECK, so the database itself refuses
--     bad data even if a bug in our code tries to write it.
--   * STRICT tables refuse values of the wrong type (e.g. text in a price column).
--     Scraped data is untrusted, so we want the database to complain loudly.
--
-- Do not add BEGIN/COMMIT here: Wrangler already runs each migration in a transaction.


-- ============================================================
-- Catalog: what products exist
-- ============================================================

CREATE TABLE brand (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL UNIQUE,
  -- Lets us load a brand's rows before it appears on the site.
  is_published  INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

CREATE TABLE product (
  id            INTEGER PRIMARY KEY,
  brand_id      INTEGER NOT NULL REFERENCES brand(id),
  model_name    TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL CHECK (type IN ('body', 'lens', 'compact', 'accessory')),
  -- Plain text (e.g. 'Fujifilm X', 'Sony E') so a new brand needs no code change.
  -- Empty for compacts with a fixed lens and most accessories.
  mount         TEXT,
  announced_on  TEXT CHECK (announced_on IS NULL OR announced_on LIKE '____-__-__'),
  status        TEXT NOT NULL DEFAULT 'current'
                CHECK (status IN ('current', 'discontinued', 'rumored')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (brand_id, model_name)
) STRICT;

CREATE INDEX product_brand_idx ON product (brand_id);

-- One row per thing you can actually buy: body only, each kit, each color.
-- Rule 13: kit and body-only are always separate variants.
CREATE TABLE variant (
  id            INTEGER PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES product(id),
  kit_contents  TEXT NOT NULL,          -- e.g. 'Body only', 'with XF 16-50mm', 'Lens only'
  color         TEXT,                   -- e.g. 'Black', 'Silver'; empty if only one color
  is_bundle     INTEGER NOT NULL DEFAULT 0 CHECK (is_bundle IN (0, 1)),
  -- Barcode. Digits only, in one of the standard GTIN lengths (UPC is 12).
  gtin          TEXT UNIQUE CHECK (
                  gtin IS NULL
                  OR (gtin NOT GLOB '*[^0-9]*' AND length(gtin) IN (8, 12, 13, 14))
                ),
  mpn           TEXT,                   -- manufacturer part number
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

CREATE INDEX variant_product_idx ON variant (product_id);
-- Stops two identical variants. COALESCE because SQLite treats two empty
-- colors as "different", which would let duplicates through.
CREATE UNIQUE INDEX variant_unique_idx
  ON variant (product_id, kit_contents, COALESCE(color, ''));

-- MSRP lives here, not on product: kits and bodies have different MSRPs, and
-- MSRPs change over time. Rule 14 needs the MSRP that applied at the time.
CREATE TABLE msrp (
  id            INTEGER PRIMARY KEY,
  variant_id    INTEGER NOT NULL REFERENCES variant(id),
  region        TEXT NOT NULL DEFAULT 'US' CHECK (length(region) = 2),
  price_cents   INTEGER NOT NULL CHECK (price_cents > 0),
  currency      TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  source_url    TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  as_of         TEXT NOT NULL CHECK (as_of LIKE '____-__-__'),
  UNIQUE (variant_id, region, as_of)
) STRICT;


-- ============================================================
-- Sources and the unified condition scale
-- ============================================================

CREATE TABLE source (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  slug                TEXT NOT NULL UNIQUE,
  base_url            TEXT NOT NULL CHECK (base_url LIKE 'https://%'),
  access_type         TEXT NOT NULL CHECK (access_type IN ('api', 'feed', 'scrape')),
  region              TEXT NOT NULL DEFAULT 'US' CHECK (length(region) = 2),
  -- Rule 4: never faster than every 5 minutes.
  poll_minutes        INTEGER NOT NULL DEFAULT 30 CHECK (poll_minutes >= 5),
  -- Rule 6: e.g. 72 for Best Buy. Empty means the source sets no limit.
  cache_limit_hours   INTEGER CHECK (cache_limit_hours IS NULL OR cache_limit_hours > 0),
  -- New sources start 'paused' until their terms-sheet row says "allowed" (rule 7).
  -- 'stopped_by_request' is for rule 8 and must never be switched back on by code.
  status              TEXT NOT NULL DEFAULT 'paused'
                      CHECK (status IN ('active', 'paused', 'not_tracked', 'stopped_by_request')),
  last_success_at     TEXT CHECK (last_success_at IS NULL OR last_success_at LIKE '____-__-__T__:__:__Z'),
  last_error_at       TEXT CHECK (last_error_at IS NULL OR last_error_at LIKE '____-__-__T__:__:__Z'),
  consecutive_errors  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

-- The fixed unified scale. The code is the key (e.g. 'used_a') so rows that
-- point here stay readable when you look at them directly.
CREATE TABLE condition (
  code          TEXT PRIMARY KEY,
  label         TEXT NOT NULL UNIQUE,
  -- Lower = better condition. Used for "notify me for Used B or better".
  sort_order    INTEGER NOT NULL UNIQUE,
  -- Unknown is the only condition left out of averages.
  in_averages   INTEGER NOT NULL CHECK (in_averages IN (0, 1))
) STRICT;

INSERT INTO condition (code, label, sort_order, in_averages) VALUES
  ('new',           'New',                      1, 1),
  ('new_gray',      'New (gray market)',        2, 1),
  ('open_box',      'Open box',                 3, 1),
  ('mfr_refurb',    'Manufacturer refurbished', 4, 1),
  ('seller_refurb', 'Seller refurbished',       5, 1),
  ('used_a',        'Used A',                   6, 1),
  ('used_b',        'Used B',                   7, 1),
  ('used_c',        'Used C',                   8, 1),
  ('unknown',       'Unknown',                 99, 0);

-- Maps each source's own grade (e.g. 'Like New', 'Excellent+') to our scale.
-- Deliberately empty: filled in by hand after reading each grading page.
CREATE TABLE condition_map (
  id              INTEGER PRIMARY KEY,
  source_id       INTEGER NOT NULL REFERENCES source(id),
  raw_label       TEXT NOT NULL,
  condition_code  TEXT NOT NULL REFERENCES condition(code),
  notes           TEXT,
  mapped_by       TEXT NOT NULL,
  mapped_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (source_id, raw_label)
) STRICT;


-- ============================================================
-- Listings and price history
-- ============================================================

-- One row per product page at a source. Unmatched listings wait here with
-- match_status = 'needs_review'. That status *is* the review queue (rule 12).
CREATE TABLE listing (
  id                   INTEGER PRIMARY KEY,
  source_id            INTEGER NOT NULL REFERENCES source(id),
  -- The source's own ID (SKU, item number). Unique per source, which is what
  -- makes collectors idempotent: seeing the same page twice updates one row.
  external_id          TEXT NOT NULL,
  url                  TEXT NOT NULL CHECK (url LIKE 'https://%'),
  variant_id           INTEGER REFERENCES variant(id),   -- empty until matched
  -- Rule 5: a short factual identifier, never a description. The length cap
  -- stops a description being stored here by accident.
  raw_title            TEXT NOT NULL CHECK (length(raw_title) BETWEEN 1 AND 300),
  raw_condition_label  TEXT,
  condition_code       TEXT NOT NULL DEFAULT 'unknown' REFERENCES condition(code),
  warranty_region      TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (warranty_region IN ('US', 'international', 'unknown')),
  seller_name          TEXT NOT NULL,
  -- Decides which medians a listing can join (see CLAUDE.md "Comparison sellers").
  -- 'marketplace' listings are shown only as "asking prices", never in a median.
  seller_type          TEXT NOT NULL
                       CHECK (seller_type IN ('manufacturer', 'authorized_dealer', 'used_dealer', 'marketplace')),
  currency             TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  match_status         TEXT NOT NULL DEFAULT 'needs_review'
                       CHECK (match_status IN ('matched', 'needs_review', 'rejected', 'excluded')),
  match_confidence     REAL CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
  match_method         TEXT CHECK (match_method IS NULL OR match_method IN ('gtin', 'mpn', 'title', 'human')),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  first_seen_at        TEXT NOT NULL CHECK (first_seen_at LIKE '____-__-__T__:__:__Z'),
  -- Rule 10. Updated on every successful check. At 30-minute polling this is
  -- 48 writes per listing per day; D1's free plan allows ~100,000 writes a day,
  -- so this is fine up to roughly 2,000 listings. Revisit before we get there.
  last_checked_at      TEXT CHECK (last_checked_at IS NULL OR last_checked_at LIKE '____-__-__T__:__:__Z'),
  UNIQUE (source_id, external_id),
  -- A listing can't be "matched" without saying what it matched to.
  CHECK (match_status != 'matched' OR variant_id IS NOT NULL)
) STRICT;

CREATE INDEX listing_variant_idx ON listing (variant_id);
CREATE INDEX listing_match_status_idx ON listing (match_status);

-- Rule 9: a row is written ONLY when price or stock differs from this
-- listing's previous row. The collector code enforces that; the UNIQUE below
-- is a second safety net against writing the same moment twice.
CREATE TABLE observation (
  id           INTEGER PRIMARY KEY,
  listing_id   INTEGER NOT NULL REFERENCES listing(id),
  observed_at  TEXT NOT NULL CHECK (observed_at LIKE '____-__-__T__:__:__Z'),
  -- Empty when a page says "sold out" without showing a price.
  price_cents  INTEGER CHECK (price_cents IS NULL OR price_cents > 0),
  in_stock     INTEGER NOT NULL CHECK (in_stock IN (0, 1)),
  UNIQUE (listing_id, observed_at)
) STRICT;

-- Rule 11: one row per UTC day on which this listing was successfully checked.
-- Because `observation` only stores changes, it can't tell "price stayed the
-- same" apart from "source was down". This table can: a day with no row here
-- doesn't count, and is never filled in from an earlier price.
-- At most one write per listing per day.
CREATE TABLE listing_check_day (
  listing_id   INTEGER NOT NULL REFERENCES listing(id),
  check_date   TEXT NOT NULL CHECK (check_date LIKE '____-__-__'),
  PRIMARY KEY (listing_id, check_date)
) STRICT;

-- Built from observations when a listing goes from out of stock to in stock.
-- Kept as its own table so alerts and "usually back in N days" stay fast.
-- No variant_id here on purpose: we join through listing, so if a listing is
-- re-matched to a different variant, its restock history moves with it.
CREATE TABLE restock_event (
  id               INTEGER PRIMARY KEY,
  listing_id       INTEGER NOT NULL REFERENCES listing(id),
  in_stock_at      TEXT NOT NULL CHECK (in_stock_at LIKE '____-__-__T__:__:__Z'),
  out_of_stock_at  TEXT CHECK (out_of_stock_at IS NULL OR out_of_stock_at LIKE '____-__-__T__:__:__Z'),
  price_cents      INTEGER CHECK (price_cents IS NULL OR price_cents > 0),
  UNIQUE (listing_id, in_stock_at),
  CHECK (out_of_stock_at IS NULL OR out_of_stock_at >= in_stock_at)
) STRICT;


-- ============================================================
-- Rumors, announcements and corrections
-- ============================================================

-- Rule 15. Rumors never trigger push alerts; that's enforced in alert code.
CREATE TABLE release_item (
  id                INTEGER PRIMARY KEY,
  brand_id          INTEGER NOT NULL REFERENCES brand(id),
  product_id        INTEGER REFERENCES product(id),  -- linked once it's announced
  title             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('Official', 'Likely', 'Unverified', 'Speculative')),
  source_url        TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  first_seen_at     TEXT NOT NULL CHECK (first_seen_at LIKE '____-__-__T__:__:__Z'),
  last_verified_at  TEXT NOT NULL CHECK (last_verified_at LIKE '____-__-__T__:__:__Z'),
  correction_note   TEXT,
  is_retracted      INTEGER NOT NULL DEFAULT 0 CHECK (is_retracted IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Anything not Official must be titled "Rumor: ...". substr is used instead
  -- of LIKE because LIKE ignores case and would accept "rumor:".
  CHECK (status = 'Official' OR substr(title, 1, 6) = 'Rumor:'),
  CHECK (last_verified_at >= first_seen_at)
) STRICT;

CREATE INDEX release_item_brand_idx ON release_item (brand_id, status);

-- Rule 16: the public corrections log. Rows are only ever added, never edited.
CREATE TABLE correction (
  id            INTEGER PRIMARY KEY,
  table_name    TEXT NOT NULL,
  row_id        INTEGER NOT NULL,
  field_name    TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT NOT NULL,
  is_public     INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  corrected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;


-- ============================================================
-- Subscribers and alerts
-- ============================================================

-- Rule 25: email, consent time and watchlist only. Nothing else about people.
CREATE TABLE user (
  id               INTEGER PRIMARY KEY,
  -- NOCASE so 'Pat@x.com' and 'pat@x.com' can't sign up twice.
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email LIKE '%_@_%'),
  consent_at       TEXT NOT NULL CHECK (consent_at LIKE '____-__-__T__:__:__Z'),
  -- Empty until the double opt-in link is clicked (rule 21). Send nothing before that.
  confirmed_at     TEXT CHECK (confirmed_at IS NULL OR confirmed_at LIKE '____-__-__T__:__:__Z'),
  unsubscribed_at  TEXT CHECK (unsubscribed_at IS NULL OR unsubscribed_at LIKE '____-__-__T__:__:__Z'),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

-- Magic links. We store only a hash of the token, so someone who reads the
-- database can't use it to log in as anyone.
CREATE TABLE login_token (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES user(id),
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('confirm_signup', 'login')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at  TEXT NOT NULL CHECK (expires_at LIKE '____-__-__T__:__:__Z'),
  used_at     TEXT CHECK (used_at IS NULL OR used_at LIKE '____-__-__T__:__:__Z')
) STRICT;

-- What a person follows (shown on their account page).
CREATE TABLE watchlist (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES user(id),
  variant_id  INTEGER NOT NULL REFERENCES variant(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (user_id, variant_id)
) STRICT;

-- When to notify them. Separate from watchlist so you can follow an item
-- without being pinged. There is deliberately no "plan" or "tier" column:
-- everyone is alerted at the same time (rule 17).
CREATE TABLE alert_rule (
  id                    INTEGER PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES user(id),
  variant_id            INTEGER NOT NULL REFERENCES variant(id),
  kind                  TEXT NOT NULL CHECK (kind IN ('restock', 'price_below')),
  -- The worst condition this person will accept, e.g. 'used_b' = Used B or better.
  worst_condition_code  TEXT NOT NULL DEFAULT 'new' REFERENCES condition(code),
  target_price_cents    INTEGER CHECK (target_price_cents IS NULL OR target_price_cents > 0),
  channel               TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'push')),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (kind != 'price_below' OR target_price_cents IS NOT NULL)
) STRICT;

CREATE INDEX alert_rule_variant_idx ON alert_rule (variant_id, is_active);

-- Every alert we would send. Rule 27: status starts as 'held' (test mode),
-- and nothing leaves 'held' until the go-live switch is turned on by hand.
-- Rate limits (rule 21) are checked by counting recent rows here.
CREATE TABLE alert_log (
  id                INTEGER PRIMARY KEY,
  alert_rule_id     INTEGER NOT NULL REFERENCES alert_rule(id),
  user_id           INTEGER NOT NULL REFERENCES user(id),
  restock_event_id  INTEGER REFERENCES restock_event(id),
  observation_id    INTEGER REFERENCES observation(id),
  channel           TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'push')),
  status            TEXT NOT NULL DEFAULT 'held'
                    CHECK (status IN ('held', 'queued', 'sent', 'failed', 'rate_limited')),
  is_test           INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at           TEXT CHECK (sent_at IS NULL OR sent_at LIKE '____-__-__T__:__:__Z'),
  -- Every alert must point at the thing that caused it.
  CHECK (restock_event_id IS NOT NULL OR observation_id IS NOT NULL)
) STRICT;

CREATE INDEX alert_log_user_idx ON alert_log (user_id, created_at);
CREATE INDEX alert_log_rule_idx ON alert_log (alert_rule_id, created_at);

-- Counts clicks, not people: no user id, no IP address.
-- Link ranking must never read this table (rule 22).
CREATE TABLE click_log (
  id          INTEGER PRIMARY KEY,
  listing_id  INTEGER NOT NULL REFERENCES listing(id),
  clicked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  page        TEXT                       -- the site path the click came from
) STRICT;

CREATE INDEX click_log_listing_idx ON click_log (listing_id, clicked_at);
