#!/usr/bin/env node
/**
 * Export an engagement score report as a portable deliverable package: `<outDir>/<engagement>-redteam-reproduction-report.md` + `<outDir>/shots/`.
 *
 * In web markdown downloads, evidence screenshots use absolute paths.
 * This script copies shots/ to the output directory and rewires markdown links to relative paths.
 *
 * Usage:
 *   node scripts/export-engagement-report.mjs
 *   node scripts/export-engagement-report.mjs --out ~/deliverables/target-name
 *   node scripts/export-engagement-report.mjs --engagement <id>
 */
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RedteamStore } from "../lib/redteam/store-core.js";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const root = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "redteam");
const store = new RedteamStore(root);
const id = argOf("engagement", store.activeEngagementId());
if (!id) {
  console.error("No engagement available: create one via console or specify with --engagement <id>");
  process.exit(1);
}
const outDir = resolve(argOf("out", process.cwd()));
mkdirSync(outDir, { recursive: true });

const shotsSrc = join(root, "engagements", id, "shots");
const shotsDst = join(outDir, "shots");
if (existsSync(shotsSrc)) {
  rmSync(shotsDst, { recursive: true, force: true });
  cpSync(shotsSrc, shotsDst, { recursive: true });
}

const rep = store.scoreReport(id, { shotRef: "relative" });
const name = String(rep.target || id).replace(/[/\\:*?"<>|]/g, "_");
const outFile = join(outDir, name + "-redteam-reproduction-report.md");
writeFileSync(outFile, rep.markdown, "utf8");
store.close();

const imgs = (rep.markdown.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
console.log("✓ Report: " + outFile);
console.log("  Total " + rep.summary.points + " pts · " + rep.items.length + " items · " + imgs + " embedded screenshots"
  + (existsSync(shotsDst) ? " (shots/ contains " + readdirSync(shotsDst).length + " files; bundle with report)" : ""));
