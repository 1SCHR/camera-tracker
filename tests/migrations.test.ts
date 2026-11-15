// Checks that the schema builds and that the database itself refuses bad data.
// Each test gets a brand-new empty database, so tests can't affect each other.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, listMigrationFiles } from './helpers/test-db.ts';

const NOW = '2026-11-14T20:00:00Z';

let db: DatabaseSync;

// A minimal set of valid rows that the bad-row tests can point at:
// brand 1, product 1, variant 1, source 1, listing 1, user 1.
function insertBasicRows(): void {
  db.exec(`
    INSERT INTO brand (name, slug) VALUES ('Fujifilm', 'fujifilm');
    INSERT INTO product (brand_id, model_name, slug, type, mount)
      VALUES (1, 'X-T5', 'fujifilm-x-t5', 'body', 'Fujifilm X');
    INSERT INTO variant (product_id, kit_contents, color, gtin)
      VALUES (1, 'Body only', 'Black', '074101000001');
    INSERT INTO source (name, slug, base_url, access_type)
      VALUES ('Example Shop', 'example', 'https://shop.example', 'api');
    INSERT INTO listing (source_id, external_id, url, raw_title, seller_name, seller_type, first_seen_at)
      VALUES (1, 'SKU1', 'https://shop.example/p/1', 'Fujifilm X-T5 Body Black',
              'Example Shop', 'authorized_dealer', '${NOW}');
    INSERT INTO user (email, consent_at) VALUES ('fake@example.test', '${NOW}');
  `);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

beforeEach(() => {
  db = createTestDb();
});

describe('schema builds', () => {
  it('has migration files, starting with 0001', () => {
    const files = listMigrationFiles();
    expect(files[0]).toBe('0001_init.sql');
  });

  it('creates all 19 tables', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((row) => row.name);

    expect(names).toEqual([
      'alert_log', 'alert_rule', 'brand', 'click_log', 'condition', 'condition_map',
      'correction', 'listing', 'listing_check_day', 'login_token', 'msrp', 'observation',
      'product', 'release_item', 'restock_event', 'source', 'user', 'variant', 'watchlist',
    ]);
  });

  it('loads the nine unified conditions, and only Unknown is left out of averages', () => {
    const rows = db
      .prepare('SELECT code, in_averages FROM condition ORDER BY sort_order')
      .all() as { code: string; in_averages: number }[];

    expect(rows.map((row) => row.code)).toEqual([
      'new', 'new_gray', 'open_box', 'mfr_refurb', 'seller_refurb',
      'used_a', 'used_b', 'used_c', 'unknown',
    ]);
    const excluded = rows.filter((row) => row.in_averages === 0).map((row) => row.code);
    expect(excluded).toEqual(['unknown']);
  });

  it('leaves condition_map empty until sellers are mapped by hand', () => {
    expect(countRows('condition_map')).toBe(0);
  });

  it('accepts a set of valid rows', () => {
    expect(() => insertBasicRows()).not.toThrow();
  });
});

describe('safe defaults', () => {
  beforeEach(() => insertBasicRows());

  it('starts new sources paused, so nothing is collected before the terms sheet says OK (rule 7)', () => {
    const row = db.prepare('SELECT status, poll_minutes FROM source WHERE id = 1').get();
    expect(row).toEqual({ status: 'paused', poll_minutes: 30 });
  });

  it('puts new listings in the review queue with Unknown condition (rule 12)', () => {
    const row = db.prepare('SELECT match_status, condition_code FROM listing WHERE id = 1').get();
    expect(row).toEqual({ match_status: 'needs_review', condition_code: 'unknown' });
  });

  it('holds every new alert in test mode (rule 27)', () => {
    db.exec(`
      INSERT INTO alert_rule (user_id, variant_id, kind, channel) VALUES (1, 1, 'restock', 'email');
      INSERT INTO restock_event (listing_id, in_stock_at) VALUES (1, '${NOW}');
      INSERT INTO alert_log (alert_rule_id, user_id, restock_event_id, channel) VALUES (1, 1, 1, 'email');
    `);
    const row = db.prepare('SELECT status, is_test FROM alert_log WHERE id = 1').get();
    expect(row).toEqual({ status: 'held', is_test: 1 });
  });

  it('writes created_at in the UTC format we use everywhere', () => {
    const row = db.prepare('SELECT created_at FROM brand WHERE id = 1').get() as { created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// Each case is a statement that must fail, and part of the error we expect.
// Checking the error text makes sure it failed for the *right* reason.
const badRows: { name: string; sql: string; error: string }[] = [
  {
    name: 'product type typo',
    sql: "INSERT INTO product (brand_id, model_name, slug, type) VALUES (1, 'X', 'x', 'camra')",
    error: 'CHECK constraint failed',
  },
  {
    name: 'barcode with letters',
    sql: "INSERT INTO variant (product_id, kit_contents, gtin) VALUES (1, 'Kit', '07410ABC0001')",
    error: 'CHECK constraint failed',
  },
  {
    name: 'barcode of the wrong length',
    sql: "INSERT INTO variant (product_id, kit_contents, gtin) VALUES (1, 'Kit', '12345')",
    error: 'CHECK constraint failed',
  },
  {
    name: 'two identical variants with no color (rule 13 needs each variant once)',
    sql: `INSERT INTO variant (product_id, kit_contents) VALUES (1, 'Lens kit');
          INSERT INTO variant (product_id, kit_contents) VALUES (1, 'Lens kit')`,
    error: 'UNIQUE constraint failed',
  },
  {
    name: 'text in a price column (STRICT)',
    sql: `INSERT INTO observation (listing_id, observed_at, price_cents, in_stock)
          VALUES (1, '${NOW}', 'cheap', 1)`,
    error: 'cannot store TEXT value in INTEGER column',
  },
  {
    name: 'a zero or negative price',
    sql: `INSERT INTO observation (listing_id, observed_at, price_cents, in_stock)
          VALUES (1, '${NOW}', 0, 1)`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'a time not in UTC ISO format',
    sql: `INSERT INTO observation (listing_id, observed_at, price_cents, in_stock)
          VALUES (1, '11/14/2026 8pm', 159900, 1)`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'the same listing and time twice (rule 9 safety net)',
    sql: `INSERT INTO observation (listing_id, observed_at, price_cents, in_stock) VALUES (1, '${NOW}', 159900, 1);
          INSERT INTO observation (listing_id, observed_at, price_cents, in_stock) VALUES (1, '${NOW}', 159900, 1)`,
    error: 'UNIQUE constraint failed',
  },
  {
    name: 'the same source page saved as two listings (rule 9)',
    sql: `INSERT INTO listing (source_id, external_id, url, raw_title, seller_name, seller_type, first_seen_at)
          VALUES (1, 'SKU1', 'https://shop.example/p/1', 'Again', 'Example Shop', 'authorized_dealer', '${NOW}')`,
    error: 'UNIQUE constraint failed',
  },
  {
    name: 'a check day recorded twice for one listing (rule 11)',
    sql: `INSERT INTO listing_check_day (listing_id, check_date) VALUES (1, '2026-11-14');
          INSERT INTO listing_check_day (listing_id, check_date) VALUES (1, '2026-11-14')`,
    error: 'UNIQUE constraint failed',
  },
  {
    name: 'a "matched" listing with no variant (rule 12)',
    sql: "UPDATE listing SET match_status = 'matched' WHERE id = 1",
    error: 'CHECK constraint failed',
  },
  {
    name: 'a raw title long enough to be a description (rule 5)',
    sql: `UPDATE listing SET raw_title = '${'x'.repeat(301)}' WHERE id = 1`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'a condition code that is not on the unified scale',
    sql: "UPDATE listing SET condition_code = 'mint' WHERE id = 1",
    error: 'FOREIGN KEY constraint failed',
  },
  {
    name: 'a seller type we do not know',
    sql: "UPDATE listing SET seller_type = 'scalper' WHERE id = 1",
    error: 'CHECK constraint failed',
  },
  {
    name: 'a listing for a source that does not exist',
    sql: `INSERT INTO listing (source_id, external_id, url, raw_title, seller_name, seller_type, first_seen_at)
          VALUES (42, 'S', 'https://shop.example/s', 'T', 'S', 'marketplace', '${NOW}')`,
    error: 'FOREIGN KEY constraint failed',
  },
  {
    name: 'polling faster than every 5 minutes (rule 4)',
    sql: 'UPDATE source SET poll_minutes = 1 WHERE id = 1',
    error: 'CHECK constraint failed',
  },
  {
    name: 'a rumor whose title does not start with "Rumor:" (rule 15)',
    sql: `INSERT INTO release_item (brand_id, title, status, source_url, first_seen_at, last_verified_at)
          VALUES (1, 'X-T6 coming', 'Likely', 'https://news.example', '${NOW}', '${NOW}')`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'a rumor titled with lowercase "rumor:" (rule 15)',
    sql: `INSERT INTO release_item (brand_id, title, status, source_url, first_seen_at, last_verified_at)
          VALUES (1, 'rumor: X-T6', 'Likely', 'https://news.example', '${NOW}', '${NOW}')`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'a rumor with no source link (rule 15)',
    sql: `INSERT INTO release_item (brand_id, title, status, first_seen_at, last_verified_at)
          VALUES (1, 'Rumor: X-T6', 'Likely', '${NOW}', '${NOW}')`,
    error: 'NOT NULL constraint failed',
  },
  {
    name: 'a rumor verified before it was first seen',
    sql: `INSERT INTO release_item (brand_id, title, status, source_url, first_seen_at, last_verified_at)
          VALUES (1, 'Rumor: X-T6', 'Likely', 'https://news.example', '${NOW}', '2026-01-01T00:00:00Z')`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'a price-drop alert with no target price',
    sql: "INSERT INTO alert_rule (user_id, variant_id, kind, channel) VALUES (1, 1, 'price_below', 'email')",
    error: 'CHECK constraint failed',
  },
  {
    name: 'an alert that points at nothing',
    sql: `INSERT INTO alert_rule (user_id, variant_id, kind, channel) VALUES (1, 1, 'restock', 'email');
          INSERT INTO alert_log (alert_rule_id, user_id, channel) VALUES (1, 1, 'email')`,
    error: 'CHECK constraint failed',
  },
  {
    name: 'the same email signing up twice in different capitals',
    sql: `INSERT INTO user (email, consent_at) VALUES ('Fake@Example.test', '${NOW}')`,
    error: 'UNIQUE constraint failed',
  },
  {
    name: 'a subscriber with no consent time (rule 25)',
    sql: "INSERT INTO user (email) VALUES ('other@example.test')",
    error: 'NOT NULL constraint failed',
  },
];

describe('the database refuses bad rows', () => {
  beforeEach(() => insertBasicRows());

  for (const badRow of badRows) {
    it(`refuses ${badRow.name}`, () => {
      expect(() => db.exec(badRow.sql)).toThrow(badRow.error);
    });
  }
});
