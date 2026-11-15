// Turns a load plan into SQL statements.
//
// Only the changes in the plan become SQL, so the database changes exactly as
// listed to you and in no other way. Rows are found by slug, kit and color,
// never by ID number, because IDs differ between local and production.
//
// Values are written as SQL text, so every value goes through sqlValue(),
// which quotes strings safely. Column names only ever come from the fixed
// field lists in plan.ts, never from the seed file.

import type { Change, LoadPlan, VariantRef } from './plan.ts';

export function planToSql(plan: LoadPlan): string {
  if (plan.conflicts.length > 0) {
    throw new Error('Refusing to write SQL for a plan that has conflicts.');
  }
  return plan.changes.map(changeToSql).join('\n');
}

function changeToSql(change: Change): string {
  switch (change.kind) {
    case 'insert-brand':
      return `INSERT INTO brand (name, slug) VALUES (${sqlValue(change.name)}, ${sqlValue(change.slug)});`;

    case 'insert-product': {
      const v = change.values;
      return (
        'INSERT INTO product (brand_id, slug, model_name, type, mount, announced_on, status) VALUES (' +
        `(SELECT id FROM brand WHERE slug = ${sqlValue(change.brandSlug)}), ${sqlValue(change.slug)}, ` +
        `${sqlValue(v.model_name)}, ${sqlValue(v.type)}, ${sqlValue(v.mount)}, ` +
        `${sqlValue(v.announced_on)}, ${sqlValue(v.status)});`
      );
    }

    case 'update-product':
      return `UPDATE product SET ${change.field} = ${sqlValue(change.to)} WHERE slug = ${sqlValue(change.slug)};`;

    case 'insert-variant':
      return (
        'INSERT INTO variant (product_id, kit_contents, color, is_bundle, gtin, mpn) VALUES (' +
        `${productIdSql(change.ref.productSlug)}, ${sqlValue(change.ref.kitContents)}, ` +
        `${sqlValue(change.ref.color)}, ${sqlValue(change.isBundle)}, ${sqlValue(change.gtin)}, ${sqlValue(change.mpn)});`
      );

    case 'update-variant':
      return `UPDATE variant SET ${change.field} = ${sqlValue(change.to)} WHERE ${variantWhereSql(change.ref)};`;

    case 'insert-msrp':
      return (
        'INSERT INTO msrp (variant_id, region, price_cents, currency, source_url, as_of) VALUES (' +
        `${variantIdSql(change.ref)}, ${sqlValue(change.region)}, ${sqlValue(change.priceCents)}, ` +
        `${sqlValue(change.currency)}, ${sqlValue(change.sourceUrl)}, ${sqlValue(change.asOf)});`
      );
  }
}

function productIdSql(productSlug: string): string {
  return `(SELECT id FROM product WHERE slug = ${sqlValue(productSlug)})`;
}

// Matches the database's unique index: product + kit + color (empty if none).
function variantWhereSql(ref: VariantRef): string {
  return (
    `product_id = ${productIdSql(ref.productSlug)} AND kit_contents = ${sqlValue(ref.kitContents)} ` +
    `AND COALESCE(color, '') = ${sqlValue(ref.color ?? '')}`
  );
}

function variantIdSql(ref: VariantRef): string {
  return `(SELECT id FROM variant WHERE ${variantWhereSql(ref)})`;
}

// Writes one value as SQL. Strings are wrapped in single quotes, and any
// single quote inside is doubled, which is how SQL escapes it.
export function sqlValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`Only whole numbers are written to SQL, got ${value}.`);
    }
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}
