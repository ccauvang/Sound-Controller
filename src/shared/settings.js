import { EQ_BANDS, EQ_GAIN_RANGE } from "./eq.js";

export const KEYS = { RESTORE: "restoreEnabled", DOMAINS: "domains", BACKUP: "backup" };
export const MAX_IMPORT_BYTES = 1000000;
const APP = "sound-controller-eq";
const SCHEMA = 1;
const VOLUME_RANGE = [0, 600];
const MAX_DOMAINS = 2000;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HOST_RE = /^(?=.{1,253}$)([a-z0-9_-]+\.)*[a-z0-9_-]+$/;

const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));
const flatEq = () => new Array(EQ_BANDS.length).fill(0);
const isFlat = (eq) => eq.every((g) => g === 0);
const validHost = (h) => typeof h === "string" && !BAD_KEYS.has(h) && HOST_RE.test(h);

export const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }; // blank and special tabs throw
};

// one write at a time - two hosts saving together would both read old data and one would be lost
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.catch(() => {}).then(fn));

// ---------- validation (used on import and when reading) ----------
function cleanDomain(d) {
  if (!Number.isFinite(d?.volume)) return null;
  const eq = Array.isArray(d.eq) && d.eq.length === EQ_BANDS.length
    ? d.eq.map((g) => (Number.isFinite(g) ? Math.round(clamp(g, EQ_GAIN_RANGE)) : 0))
    : flatEq();
  return { volume: Math.round(clamp(d.volume, VOLUME_RANGE)), eq };
};

function cleanDomains(raw) {
  const out = {};
  for (const [host, d] of Object.entries(raw ?? {}).slice(0, MAX_DOMAINS)) {
    const key = host.toLowerCase();
    if (!validHost(key)) continue; // bad row is skipped, rest still imports
    const clean = cleanDomain(d);
    if (clean) out[key] = clean;
  };
  return out;
};

// ---------- reads and writes ----------
export async function loadSettings() {
  const s = await chrome.storage.local.get({ [KEYS.RESTORE]: true });
  return { restoreEnabled: s[KEYS.RESTORE] !== false };
};

export const setRestoreEnabled = (on) => chrome.storage.local.set({ [KEYS.RESTORE]: !!on });

export async function getDomain(host) {
  if (!validHost(host)) return null;
  const domains = (await chrome.storage.local.get({ [KEYS.DOMAINS]: {} }))[KEYS.DOMAINS];
  return Object.hasOwn(domains, host) ? cleanDomain(domains[host]) : null; // hasOwn - a host named "constructor" must not hit Object.prototype
};

export function saveDomainVolume(host, volume) {
  if (!validHost(host)) return Promise.resolve();
  return serial(async () => {
    const domains = (await chrome.storage.local.get({ [KEYS.DOMAINS]: {} }))[KEYS.DOMAINS];
    const prev = Object.hasOwn(domains, host) ? cleanDomain(domains[host]) : null;
    const eq = prev?.eq ?? flatEq();
    if (volume === 100 && isFlat(eq)) delete domains[host]; // default state needs no row
    else domains[host] = { volume, eq };
    await chrome.storage.local.set({ [KEYS.DOMAINS]: domains });
  });
};

// ---------- export / import ----------
export async function buildExport() {
  const s = await chrome.storage.local.get({ [KEYS.RESTORE]: true, [KEYS.DOMAINS]: {} });
  return {
    app: APP,
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    settings: { restoreEnabled: s[KEYS.RESTORE] !== false },
    domains: cleanDomains(s[KEYS.DOMAINS])
  };
};

export function parseImport(text) {
  if (text.length > MAX_IMPORT_BYTES) throw new Error("File too big");
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error("Not a valid JSON file"); };
  if (raw?.app !== APP || raw.schema !== SCHEMA) throw new Error("Not a Sound Controller settings file");
  const d = raw.domains ?? {};
  if (typeof d !== "object" || Array.isArray(d)) throw new Error("Bad file: domains must be an object");
  const domains = cleanDomains(d);
  return {
    restoreEnabled: raw.settings?.restoreEnabled !== false,
    domains,
    skipped: Object.keys(d).length - Object.keys(domains).length
  };
};

export async function importSettings(text, replace) {
  const parsed = parseImport(text); // throws here = nothing written at all
  const cur = await chrome.storage.local.get({ [KEYS.RESTORE]: true, [KEYS.DOMAINS]: {} });
  const domains = replace ? parsed.domains : cleanDomains({ ...cleanDomains(cur[KEYS.DOMAINS]), ...parsed.domains });
  await chrome.storage.local.set({ [KEYS.BACKUP]: { restoreEnabled: cur[KEYS.RESTORE] !== false, domains: cur[KEYS.DOMAINS] } });
  await chrome.storage.local.set({
    [KEYS.DOMAINS]: domains,
    [KEYS.RESTORE]: replace ? parsed.restoreEnabled : cur[KEYS.RESTORE] !== false // merge keeps the user's current switch
  });
  return { imported: Object.keys(parsed.domains).length, skipped: parsed.skipped };
};

export async function hasBackup() {
  return (await chrome.storage.local.get(KEYS.BACKUP))[KEYS.BACKUP] != null;
};

export async function undoImport() {
  const b = (await chrome.storage.local.get(KEYS.BACKUP))[KEYS.BACKUP];
  if (!b) throw new Error("Nothing to undo");
  await chrome.storage.local.set({ [KEYS.RESTORE]: b.restoreEnabled !== false, [KEYS.DOMAINS]: cleanDomains(b.domains) });
  await chrome.storage.local.remove(KEYS.BACKUP);
};