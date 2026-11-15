// Seed loader command.
//
//   node src/seed/load.ts seed/fujifilm.json --check   check the file only
//   node src/seed/load.ts seed/fujifilm.json           check, then load into LOCAL D1
//
// Steps: check the file -> read what local D1 holds -> list the changes ->
// apply only those changes -> read D1 again and confirm nothing is left to do.
//
// This command only ever touches the LOCAL database. Loading production needs
// the owner's go-ahead and a backup first (CLAUDE.md rule 30), so there is
// deliberately no option for it here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { validateSeed } from './validate.ts';
import { describeChange, planLoad, SNAPSHOT_QUERIES } from './plan.ts';
import type { DbSnapshot, LoadPlan } from './plan.ts';
import { planToSql } from './sql.ts';
import type { CleanSeed } from './types.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DATABASE_NAME = 'camera-tracker-db';
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
// Inside .wrangler/, which is gitignored, next to the local database itself.
const WORK_DIR = join(ROOT, '.wrangler', 'seed');

function main(args: string[]): number {
  if (args.some((arg) => arg.includes('remote'))) {
    console.error('Refusing: this loader only writes to the local database (rule 30).');
    return 1;
  }

  const checkOnly = args.includes('--check');
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length !== 1 || files[0] === undefined) {
    console.error('Usage: node src/seed/load.ts <seed file> [--check]');
    return 1;
  }

  const seed = checkSeedFile(files[0]);
  if (seed === null) {
    return 1;
  }
  if (checkOnly) {
    return 0;
  }
  return loadIntoLocalD1(seed);
}

// ---------------------------------------------------------------------------
// Step 1: check the file
// ---------------------------------------------------------------------------

function checkSeedFile(file: string): CleanSeed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Could not read ${file} as JSON: ${(error as Error).message}`);
    return null;
  }

  const result = validateSeed(raw);
  if (!result.ok) {
    console.error(`${file} has ${result.errors.length} problem(s). Nothing was loaded.\n`);
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    return null;
  }

  const variantCount = result.seed.products.reduce((sum, p) => sum + p.variants.length, 0);
  const msrpCount = result.seed.products.reduce(
    (sum, p) => sum + p.variants.reduce((inner, v) => inner + v.msrp.length, 0),
    0,
  );
  console.log(
    `${file} is valid: ${result.seed.products.length} products, ${variantCount} variants, ${msrpCount} MSRP rows.`,
  );
  return result.seed;
}

// ---------------------------------------------------------------------------
// Steps 2-5: plan, apply, verify (local D1 only)
// ---------------------------------------------------------------------------

function loadIntoLocalD1(seed: CleanSeed): number {
  if (!existsSync(WRANGLER)) {
    console.error('Wrangler is not installed. Run "npm install" first.');
    return 1;
  }
  mkdirSync(WORK_DIR, { recursive: true });

  const before = readLocalSnapshot();
  if (before === null) {
    return 1;
  }

  const plan = planLoad(seed, before);
  printPlan(plan);
  if (plan.conflicts.length > 0) {
    console.error('\nNothing was loaded. Fix the conflicts above first.');
    return 1;
  }
  if (plan.changes.length === 0) {
    console.log('\nLocal database already matches the seed. Nothing to do.');
    return 0;
  }

  const sqlFile = join(WORK_DIR, 'load.sql');
  writeFileSync(sqlFile, planToSql(plan) + '\n');
  const applied = runWrangler(['d1', 'execute', DATABASE_NAME, '--local', '--file', relative(ROOT, sqlFile)]);
  if (applied.status !== 0) {
    console.error('\nWrangler failed while loading:\n' + applied.stderr + applied.stdout);
    return 1;
  }

  // Read the database again: if the load worked, a second plan finds nothing to do.
  const after = readLocalSnapshot();
  if (after === null) {
    return 1;
  }
  const leftover = planLoad(seed, after);
  if (leftover.changes.length > 0 || leftover.conflicts.length > 0) {
    console.error('\nLoaded, but the database still differs from the seed:');
    leftover.changes.forEach((change) => console.error(`  - ${describeChange(change)}`));
    leftover.conflicts.forEach((conflict) => console.error(`  - ${conflict}`));
    return 1;
  }

  console.log(`\nApplied ${plan.changes.length} change(s) to the local database. Checked: it now matches the seed.`);
  return 0;
}

function printPlan(plan: LoadPlan): void {
  console.log(`\nChanges (${plan.changes.length}):`);
  plan.changes.forEach((change) => console.log(`  + ${describeChange(change)}`));

  if (plan.notInSeed.length > 0) {
    console.log(`\nIn the database but not in the seed (left alone, ${plan.notInSeed.length}):`);
    plan.notInSeed.forEach((item) => console.log(`  ? ${item}`));
  }
  if (plan.conflicts.length > 0) {
    console.error(`\nConflicts (${plan.conflicts.length}):`);
    plan.conflicts.forEach((conflict) => console.error(`  ! ${conflict}`));
  }
}

// Reads the four snapshot queries from local D1 in one Wrangler call.
function readLocalSnapshot(): DbSnapshot | null {
  const queryFile = join(WORK_DIR, 'snapshot.sql');
  const queries = [SNAPSHOT_QUERIES.brands, SNAPSHOT_QUERIES.products, SNAPSHOT_QUERIES.variants, SNAPSHOT_QUERIES.msrps];
  writeFileSync(queryFile, queries.join(';\n') + ';\n');

  const result = runWrangler(['d1', 'execute', DATABASE_NAME, '--local', '--json', '--file', relative(ROOT, queryFile)]);
  if (result.status !== 0) {
    console.error(
      'Could not read the local database. Have the migrations been applied? (npm run db:migrate:local)\n' +
        result.stderr +
        result.stdout,
    );
    return null;
  }

  let parsed: { results: unknown[] }[];
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    console.error('Could not understand Wrangler\'s output:\n' + result.stdout);
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    console.error(`Expected 4 query results from Wrangler, got ${Array.isArray(parsed) ? parsed.length : 'none'}.`);
    return null;
  }

  return {
    brands: parsed[0]?.results as DbSnapshot['brands'],
    products: parsed[1]?.results as DbSnapshot['products'],
    variants: parsed[2]?.results as DbSnapshot['variants'],
    msrps: parsed[3]?.results as DbSnapshot['msrps'],
  };
}

// Runs Wrangler directly with Node (no shell), so nothing in the arguments can
// be misread as a shell command, and the spaces in the folder name are safe.
function runWrangler(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

process.exitCode = main(process.argv.slice(2));
