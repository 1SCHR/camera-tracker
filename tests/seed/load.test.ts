// Loads the fake seed into a real (in-memory) SQLite database built from our
// migrations, and checks the owner's three loading rules:
//   - changed values are updated and listed,
//   - an MSRP is never overwritten,
//   - rows removed from the seed are reported, not deleted.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb } from '../helpers/test-db.ts';
import { validateSeed } from '../../src/seed/validate.ts';
import { planLoad, describeChange, SNAPSHOT_QUERIES } from '../../src/seed/plan.ts';
import type { DbSnapshot, LoadPlan } from '../../src/seed/plan.ts';
import { planToSql, sqlValue } from '../../src/seed/sql.ts';
import type { CleanSeed } from '../../src/seed/types.ts';

let db: DatabaseSync;

beforeEach(() => {
  db = createTestDb();
});

function fakeSeedJson(): any {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'fake-seed.json'), 'utf8'));
}

function clean(json: unknown): CleanSeed {
  const result = validateSeed(json, { allowedHosts: ['seed.example'] });
  if (!result.ok) {
    throw new Error('Fixture failed validation:\n' + result.errors.join('\n'));
  }
  return result.seed;
}

// SQLite can't tell TypeScript what columns a query returns, so we state the
// row shape ourselves. The snapshot queries are written to match these shapes.
function rows<T>(sql: string): T[] {
  return db.prepare(sql).all() as unknown as T[];
}

function readSnapshot(): DbSnapshot {
  return {
    brands: rows<DbSnapshot['brands'][number]>(SNAPSHOT_QUERIES.brands),
    products: rows<DbSnapshot['products'][number]>(SNAPSHOT_QUERIES.products),
    variants: rows<DbSnapshot['variants'][number]>(SNAPSHOT_QUERIES.variants),
    msrps: rows<DbSnapshot['msrps'][number]>(SNAPSHOT_QUERIES.msrps),
  };
}

// Does what the real loader does: plan against the database, then apply.
function load(json: unknown): LoadPlan {
  const plan = planLoad(clean(json), readSnapshot());
  if (plan.conflicts.length === 0) {
    db.exec(planToSql(plan));
  }
  return plan;
}

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('first load', () => {
  it('creates the brand, products, variants and MSRPs', () => {
    const plan = load(fakeSeedJson());

    expect(plan.conflicts).toEqual([]);
    expect(count('brand')).toBe(1);
    expect(count('product')).toBe(3);
    expect(count('variant')).toBe(3); // the compact's variants are "unknown"
    expect(count('msrp')).toBe(2);
  });

  it('stores facts the way the schema expects', () => {
    load(fakeSeedJson());

    const body = db.prepare("SELECT type, mount, status, announced_on FROM product WHERE slug = 'testbrand-tb-1'").get();
    expect(body).toEqual({ type: 'body', mount: 'Testbrand T', status: 'current', announced_on: '2025-03-10' });

    const compact = db.prepare("SELECT mount, announced_on FROM product WHERE slug = 'testbrand-tb-compact'").get();
    expect(compact).toEqual({ mount: null, announced_on: null });

    const msrp = db.prepare(
      "SELECT m.price_cents, m.source_url FROM msrp m JOIN variant v ON v.id = m.variant_id WHERE v.kit_contents = 'Body only'",
    ).get();
    expect(msrp).toEqual({ price_cents: 99995, source_url: 'https://seed.example/news/tb-1-launch' });

    // New products are not public until someone publishes the brand.
    expect(db.prepare('SELECT is_published FROM brand').get()).toEqual({ is_published: 0 });
  });
});

describe('running the loader twice (idempotent)', () => {
  it('plans no changes and leaves every row count the same', () => {
    load(fakeSeedJson());
    const countsBefore = ['brand', 'product', 'variant', 'msrp'].map(count);

    const secondPlan = load(fakeSeedJson());

    expect(secondPlan.changes).toEqual([]);
    expect(secondPlan.notInSeed).toEqual([]);
    expect(['brand', 'product', 'variant', 'msrp'].map(count)).toEqual(countsBefore);
  });
});

describe('changed values', () => {
  it('updates a changed product field and lists exactly that change', () => {
    load(fakeSeedJson());
    const seed = fakeSeedJson();
    seed.products[0].status.value = 'discontinued';

    const plan = load(seed);

    expect(plan.changes.map(describeChange)).toEqual([
      'change testbrand-tb-1 status: "current" -> "discontinued"',
    ]);
    expect(db.prepare("SELECT status FROM product WHERE slug = 'testbrand-tb-1'").get()).toEqual({ status: 'discontinued' });
  });

  it('updates a variant field once it becomes known', () => {
    load(fakeSeedJson());
    const seed = fakeSeedJson();
    seed.products[0].variants[1].mpn = { value: 'TB1-KIT-18', source: 'pr_tb1' };

    const plan = load(seed);

    expect(plan.changes.map(describeChange)).toEqual([
      'change testbrand-tb-1 [with TB 18mm F2] mpn: (empty) -> "TB1-KIT-18"',
    ]);
  });
});

describe('MSRP rows are never overwritten (rule 14)', () => {
  it('adds a new dated row for a new price and keeps the old one', () => {
    load(fakeSeedJson());
    const seed = fakeSeedJson();
    seed.products[0].variants[0].msrp.push({
      region: 'US', price: '1049.95', currency: 'USD', as_of: '2025-09-01', source: 'pr_tb1',
    });

    const plan = load(seed);

    expect(plan.changes.map(describeChange)).toEqual([
      'add MSRP testbrand-tb-1 [Body only, Black] US 2025-09-01 1,049.95 USD',
    ]);
    const prices = db.prepare(
      "SELECT m.as_of, m.price_cents FROM msrp m JOIN variant v ON v.id = m.variant_id WHERE v.kit_contents = 'Body only' ORDER BY m.as_of",
    ).all();
    expect(prices).toEqual([
      { as_of: '2025-03-10', price_cents: 99995 },
      { as_of: '2025-09-01', price_cents: 104995 },
    ]);
  });

  it('refuses a different price on a date that is already recorded, and writes nothing', () => {
    load(fakeSeedJson());
    const seed = fakeSeedJson();
    seed.products[0].variants[0].msrp[0].price = '949.95';
    seed.products[0].status.value = 'discontinued'; // a valid change in the same run

    const plan = load(seed);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain('already recorded as 999.95 USD');
    expect(() => planToSql(plan)).toThrow('conflicts');
    // Nothing from this run was applied, not even the valid status change.
    expect(db.prepare("SELECT status FROM product WHERE slug = 'testbrand-tb-1'").get()).toEqual({ status: 'current' });
    expect(count('msrp')).toBe(2);
  });
});

describe('rows removed from the seed', () => {
  it('reports them and leaves them in the database', () => {
    load(fakeSeedJson());
    const seed = fakeSeedJson();
    seed.products[0].variants.splice(1, 1); // drop the kit variant (and its MSRP)

    const plan = load(seed);

    expect(plan.changes).toEqual([]);
    expect(plan.notInSeed).toEqual([
      'variant testbrand-tb-1 [with TB 18mm F2]',
      'MSRP testbrand-tb-1 [with TB 18mm F2] US 2025-03-10 1,199.95 USD',
    ]);
    expect(count('variant')).toBe(3);
    expect(count('msrp')).toBe(2);
  });
});

describe('SQL quoting', () => {
  it('writes values safely, including single quotes', () => {
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(true)).toBe('1');
    expect(sqlValue(139995)).toBe('139995');
    expect(sqlValue("Ocean's Blue")).toBe("'Ocean''s Blue'");
    expect(() => sqlValue(1399.95)).toThrow('whole numbers');
  });

  it('round-trips a value with a quote through the database', () => {
    const seed = fakeSeedJson();
    seed.products[0].variants[0].color.value = "Ocean's Blue";
    load(seed);

    expect(db.prepare("SELECT color FROM variant WHERE kit_contents = 'Body only'").get()).toEqual({ color: "Ocean's Blue" });
    expect(load(seed).changes).toEqual([]); // still idempotent
  });
});
