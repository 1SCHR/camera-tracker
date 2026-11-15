// Works out what loading a seed would change, without changing anything.
//
// The loader shows you this list, and ONLY the changes on it are turned into
// SQL. Three rules from the project owner shape it:
//   1. Changed product or variant values are updated, and listed.
//   2. An MSRP is never overwritten. A new price needs a new dated row, so a
//      different price on an existing date is a conflict and stops the load
//      (rule 14 depends on knowing which price applied when).
//   3. Rows that are in the database but no longer in the seed are left alone
//      and reported. Removing them is a separate step the owner approves.

import type { CleanSeed, CleanVariant } from './types.ts';

// What the database holds now, read with the queries below.
export interface DbProduct {
  slug: string;
  brand_slug: string;
  model_name: string;
  type: string;
  mount: string | null;
  announced_on: string | null;
  status: string;
}
export interface DbVariant {
  brand_slug: string;
  product_slug: string;
  kit_contents: string;
  color: string | null;
  is_bundle: number;
  gtin: string | null;
  mpn: string | null;
}
export interface DbMsrp {
  brand_slug: string;
  product_slug: string;
  kit_contents: string;
  color: string | null;
  region: string;
  as_of: string;
  price_cents: number;
  currency: string;
  source_url: string;
}
export interface DbSnapshot {
  brands: { slug: string; name: string }[];
  products: DbProduct[];
  variants: DbVariant[];
  msrps: DbMsrp[];
}

// Read by both the real loader (through Wrangler) and the tests (through
// Node's SQLite), so both see the database the same way.
export const SNAPSHOT_QUERIES = {
  brands: 'SELECT slug, name FROM brand ORDER BY slug',
  products: `SELECT p.slug, b.slug AS brand_slug, p.model_name, p.type, p.mount, p.announced_on, p.status
             FROM product p JOIN brand b ON b.id = p.brand_id ORDER BY p.slug`,
  variants: `SELECT b.slug AS brand_slug, p.slug AS product_slug, v.kit_contents, v.color, v.is_bundle, v.gtin, v.mpn
             FROM variant v JOIN product p ON p.id = v.product_id JOIN brand b ON b.id = p.brand_id
             ORDER BY p.slug, v.kit_contents, v.color`,
  msrps: `SELECT b.slug AS brand_slug, p.slug AS product_slug, v.kit_contents, v.color,
                 m.region, m.as_of, m.price_cents, m.currency, m.source_url
          FROM msrp m JOIN variant v ON v.id = m.variant_id JOIN product p ON p.id = v.product_id
          JOIN brand b ON b.id = p.brand_id ORDER BY p.slug, v.kit_contents, v.color, m.as_of`,
};

// Which product and variant fields the loader may update. Kept as fixed lists
// so the SQL writer only ever uses known column names.
export type ProductField = 'model_name' | 'type' | 'mount' | 'announced_on' | 'status';
export type VariantField = 'is_bundle' | 'gtin' | 'mpn';

// How a variant is identified: its product, kit and color (empty if none).
export interface VariantRef {
  productSlug: string;
  kitContents: string;
  color: string | null;
}

export type Change =
  | { kind: 'insert-brand'; slug: string; name: string }
  | {
      kind: 'insert-product';
      brandSlug: string;
      slug: string;
      values: Record<ProductField, string | null>;
    }
  | { kind: 'update-product'; slug: string; field: ProductField; from: string | null; to: string | null }
  | { kind: 'insert-variant'; ref: VariantRef; isBundle: boolean; gtin: string | null; mpn: string | null }
  | {
      kind: 'update-variant';
      ref: VariantRef;
      field: VariantField;
      from: string | number | null;
      to: string | number | null;
    }
  | {
      kind: 'insert-msrp';
      ref: VariantRef;
      region: string;
      asOf: string;
      priceCents: number;
      currency: string;
      sourceUrl: string;
    };

export interface LoadPlan {
  changes: Change[];
  // Problems that stop the whole load. Nothing is written if there are any.
  conflicts: string[];
  // In the database but not in the seed. Reported only, never deleted.
  notInSeed: string[];
}

export function planLoad(seed: CleanSeed, db: DbSnapshot): LoadPlan {
  const plan: LoadPlan = { changes: [], conflicts: [], notInSeed: [] };

  planBrand(plan, seed, db);
  planProducts(plan, seed, db);
  planVariantsAndMsrps(plan, seed, db);
  reportRowsNotInSeed(plan, seed, db);

  return plan;
}

function planBrand(plan: LoadPlan, seed: CleanSeed, db: DbSnapshot): void {
  const existing = db.brands.find((brand) => brand.slug === seed.brand.slug);
  if (!existing) {
    plan.changes.push({ kind: 'insert-brand', slug: seed.brand.slug, name: seed.brand.name });
  } else if (existing.name !== seed.brand.name) {
    plan.conflicts.push(
      `Brand "${seed.brand.slug}" is named "${existing.name}" in the database but "${seed.brand.name}" in the seed. Rename brands by hand.`,
    );
  }
}

function planProducts(plan: LoadPlan, seed: CleanSeed, db: DbSnapshot): void {
  for (const product of seed.products) {
    const values: Record<ProductField, string | null> = {
      model_name: product.modelName,
      type: product.type,
      mount: product.mount,
      announced_on: product.announcedOn,
      status: product.status,
    };

    const existing = db.products.find((row) => row.slug === product.slug);
    if (!existing) {
      plan.changes.push({ kind: 'insert-product', brandSlug: seed.brand.slug, slug: product.slug, values });
      continue;
    }
    if (existing.brand_slug !== seed.brand.slug) {
      plan.conflicts.push(`Product "${product.slug}" belongs to brand "${existing.brand_slug}" in the database.`);
      continue;
    }

    for (const field of Object.keys(values) as ProductField[]) {
      const from = existing[field];
      const to = values[field];
      if (from !== to) {
        plan.changes.push({ kind: 'update-product', slug: product.slug, field, from, to });
      }
    }
  }
}

function planVariantsAndMsrps(plan: LoadPlan, seed: CleanSeed, db: DbSnapshot): void {
  for (const product of seed.products) {
    for (const variant of product.variants) {
      const ref: VariantRef = {
        productSlug: product.slug,
        kitContents: variant.kitContents,
        color: variant.color,
      };
      planVariant(plan, ref, variant, db);
      planMsrps(plan, ref, variant, db);
    }
  }
}

function planVariant(plan: LoadPlan, ref: VariantRef, variant: CleanVariant, db: DbSnapshot): void {
  const existing = db.variants.find((row) => sameVariant(row, ref));
  if (!existing) {
    plan.changes.push({
      kind: 'insert-variant',
      ref,
      isBundle: variant.isBundle,
      gtin: variant.gtin,
      mpn: variant.mpn,
    });
    return;
  }

  const wanted: Record<VariantField, string | number | null> = {
    is_bundle: variant.isBundle ? 1 : 0,
    gtin: variant.gtin,
    mpn: variant.mpn,
  };
  for (const field of Object.keys(wanted) as VariantField[]) {
    if (existing[field] !== wanted[field]) {
      plan.changes.push({ kind: 'update-variant', ref, field, from: existing[field], to: wanted[field] });
    }
  }
}

function planMsrps(plan: LoadPlan, ref: VariantRef, variant: CleanVariant, db: DbSnapshot): void {
  for (const row of variant.msrp) {
    const existing = db.msrps.find(
      (dbRow) => sameVariant(dbRow, ref) && dbRow.region === row.region && dbRow.as_of === row.asOf,
    );

    if (!existing) {
      plan.changes.push({ kind: 'insert-msrp', ref, ...row });
      continue;
    }

    // Same date already recorded: it must match exactly. Never overwrite.
    const samePrice = existing.price_cents === row.priceCents && existing.currency === row.currency;
    const sameSource = existing.source_url === row.sourceUrl;
    if (!samePrice || !sameSource) {
      plan.conflicts.push(
        `MSRP for ${describeVariant(ref)} (${row.region}, ${row.asOf}) is already recorded as ` +
          `${formatPrice(existing.price_cents, existing.currency)} from ${existing.source_url}; the seed says ` +
          `${formatPrice(row.priceCents, row.currency)} from ${row.sourceUrl}. A new price needs a new row ` +
          `with a new as_of date (rule 14). If the old row was wrong, fix it by hand and log a correction (rule 16).`,
      );
    }
  }
}

function reportRowsNotInSeed(plan: LoadPlan, seed: CleanSeed, db: DbSnapshot): void {
  const brandSlug = seed.brand.slug;

  for (const row of db.products) {
    if (row.brand_slug === brandSlug && !seed.products.some((p) => p.slug === row.slug)) {
      plan.notInSeed.push(`product ${row.slug}`);
    }
  }

  const seedRefs: VariantRef[] = seed.products.flatMap((product) =>
    product.variants.map((variant) => ({
      productSlug: product.slug,
      kitContents: variant.kitContents,
      color: variant.color,
    })),
  );
  for (const row of db.variants) {
    if (row.brand_slug === brandSlug && !seedRefs.some((ref) => sameVariant(row, ref))) {
      plan.notInSeed.push(`variant ${describeVariant(refFromRow(row))}`);
    }
  }

  for (const row of db.msrps) {
    if (row.brand_slug !== brandSlug) {
      continue;
    }
    const stillInSeed = seed.products.some((product) =>
      product.variants.some(
        (variant) =>
          sameVariant(row, { productSlug: product.slug, kitContents: variant.kitContents, color: variant.color }) &&
          variant.msrp.some((m) => m.region === row.region && m.asOf === row.as_of),
      ),
    );
    if (!stillInSeed) {
      plan.notInSeed.push(
        `MSRP ${describeVariant(refFromRow(row))} ${row.region} ${row.as_of} ${formatPrice(row.price_cents, row.currency)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Describing changes for people
// ---------------------------------------------------------------------------

export function describeChange(change: Change): string {
  switch (change.kind) {
    case 'insert-brand':
      return `add brand ${change.name}`;
    case 'insert-product':
      return `add product ${change.slug} (${change.values.type}, ${change.values.status})`;
    case 'update-product':
      return `change ${change.slug} ${change.field}: ${show(change.from)} -> ${show(change.to)}`;
    case 'insert-variant':
      return `add variant ${describeVariant(change.ref)}`;
    case 'update-variant':
      return `change ${describeVariant(change.ref)} ${change.field}: ${show(change.from)} -> ${show(change.to)}`;
    case 'insert-msrp':
      return `add MSRP ${describeVariant(change.ref)} ${change.region} ${change.asOf} ${formatPrice(change.priceCents, change.currency)}`;
  }
}

export function describeVariant(ref: VariantRef): string {
  const color = ref.color === null ? '' : `, ${ref.color}`;
  return `${ref.productSlug} [${ref.kitContents}${color}]`;
}

export function formatPrice(cents: number, currency: string): string {
  const dollars = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, '0');
  return `${dollars.toLocaleString('en-US')}.${remainder} ${currency}`;
}

function show(value: string | number | null): string {
  return value === null ? '(empty)' : `"${value}"`;
}

// Two variants are the same if product, kit and color match. An empty color
// and no color are the same thing, as in the database's unique index.
function sameVariant(row: { product_slug: string; kit_contents: string; color: string | null }, ref: VariantRef): boolean {
  return (
    row.product_slug === ref.productSlug &&
    row.kit_contents === ref.kitContents &&
    (row.color ?? '') === (ref.color ?? '')
  );
}

function refFromRow(row: { product_slug: string; kit_contents: string; color: string | null }): VariantRef {
  return { productSlug: row.product_slug, kitContents: row.kit_contents, color: row.color };
}
