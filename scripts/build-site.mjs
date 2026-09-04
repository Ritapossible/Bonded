#!/usr/bin/env node
/**
 * Copies site/ to dist-site/ with __SITE_URL__ resolved to the absolute origin the
 * deployment is actually served from.
 *
 * Open Graph requires an absolute og:image, and hardcoding one means the card silently
 * points at the wrong host the moment the project is renamed or a custom domain is added.
 * Vercel exposes the production hostname to the build, so the source keeps a placeholder
 * and the deployment resolves it. Outside Vercel the fallback keeps the output valid.
 */
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "site");
const OUTPUT = join(ROOT, "dist-site");
const FALLBACK_ORIGIN = "https://bonded.vercel.app";
const SUBSTITUTED_EXTENSIONS = [".html", ".txt", ".xml", ".webmanifest"];

/** The origin this deployment will be reachable at, without a trailing slash. */
function resolveOrigin() {
  const explicit = process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  // Vercel sets the production domain on every environment; VERCEL_URL is the
  // per-deployment hostname, which is right for previews but wrong for production.
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) return `https://${production}`;

  const deployment = process.env.VERCEL_URL;
  if (deployment) return `https://${deployment}`;

  return FALLBACK_ORIGIN;
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const origin = resolveOrigin();

await rm(OUTPUT, { recursive: true, force: true });
await cp(SOURCE, OUTPUT, { recursive: true });

let substituted = 0;
for await (const path of walk(OUTPUT)) {
  if (!SUBSTITUTED_EXTENSIONS.some((extension) => path.endsWith(extension))) continue;
  const before = await readFile(path, "utf8");
  const after = before.replaceAll("__SITE_URL__", origin);
  if (after === before) continue;
  await writeFile(path, after);
  substituted += 1;
  process.stderr.write(`  ${relative(OUTPUT, path)}\n`);
}

process.stderr.write(`site built at ${origin} (${substituted} file(s) substituted)\n`);

if (substituted === 0) {
  process.stderr.write("no __SITE_URL__ placeholder found — check site/ before deploying\n");
  process.exit(1);
}
