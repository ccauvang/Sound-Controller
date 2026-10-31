import { TARGET, ACTION } from "./shared/messages.js";
import { loadSettings, getDomain, saveDomainVolume, saveDomainEq, hostOf } from "./shared/settings.js";
import { EQ_PRESETS } from "./shared/eq.js";

const toInfo = (tab) => {
    let hostname = "";
    try { hostname = new URL(tab.url).hostname; } catch { }; // blank and special tabs can throw - empty host is fine
    return {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        hostname,
        favIconUrl: tab.favIconUrl ?? "",
        muted: tab.mutedInfo?.muted ?? false
    };
};

async function getAudibleTabs() {
    const tabs = await chrome.tabs.query({ audible: true });
    return tabs.map(toInfo);
};

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
let creating = null;
let offscreenUp = false; // cached - getContexts on every tick is wasted work

async function hasOffscreen() {
    if (offscreenUp) return true;
    const found = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return (offscreenUp = found.length > 0);
};

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    creating ??= chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Capture tab audio to change volume and apply EQ"
    }).then(() => { offscreenUp = true; }).finally(() => { creating = null; });
    await creating;
};

const toOffscreen = async (msg) => {
    try { return await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, ...msg }); }
    catch (e) { offscreenUp = false; throw e; } // doc gone - recheck next time
};
const hostFor = async (tabId) => hostOf((await chrome.tabs.get(tabId)).url ?? "");

// live tab = 1 message. not captured = offscreen says needStream, only then ask chrome for one
async function tryLive(tabId, msg) {
    if (!(await hasOffscreen())) return false;
    let res;
    try { res = await toOffscreen({ ...msg, tabId }); } catch { return false; } // doc died - cold path recreates it
    if (res?.error) throw new Error(res.error);
    return res?.ok === true;
};

async function captureAndSend(tabId, msg) {
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const res = await toOffscreen({ ...msg, tabId, streamId, host: await hostFor(tabId) });
    if (res?.error) throw new Error(res.error);
};

async function doSetVolume(tabId, volume, { force = false, persist = true } = {}) {
    const msg = { action: ACTION.SET_VOLUME, volume };
    if (!(await tryLive(tabId, msg))) {
        if (volume === 100 && !force) {
            if (persist) persistVolume(tabId, volume); // user picked 100 on an uncaptured tab - still forget the saved value
            return { ok: true, captured: false };
        };
        await captureAndSend(tabId, msg);
    };
    if (persist) persistVolume(tabId, volume);
    updateBadgeLater(tabId);
    return { ok: true, captured: true };
};

async function doSetEq(tabId, eq, volume, { persist = true } = {}) {
    const msg = { action: ACTION.SET_EQ, eq, volume };
    if (!(await tryLive(tabId, msg))) {
        if (eq.every((g) => g === 0)) {
            if (persist) persistEq(tabId, eq); // flat on uncaptured tab - nothing to capture, still forget saved eq
            return { ok: true, captured: false };
        };
        await captureAndSend(tabId, msg);
    };
    if (persist) persistEq(tabId, eq);
    updateBadgeLater(tabId);
    return { ok: true, captured: true };
};

// one chain per tab - parallel first ticks would capture the same tab twice and leak a stream
const queues = new Map();

function enqueue(tabId, job) {
    const prev = queues.get(tabId) ?? Promise.resolve();
    const next = prev.catch(() => { }).then(job);
    queues.set(tabId, next);
    return next;
};

const latestVol = new Map(); // tabId -> newest wanted volume
const setVolume = (tabId, volume, opts) => {
    latestVol.set(tabId, volume);
    return enqueue(tabId, () => {
        if (!opts?.force && latestVol.get(tabId) !== volume) return { ok: true, skipped: true }; // newer tick queued behind this one
        return doSetVolume(tabId, volume, opts);
    });
};
const setEq = (tabId, eq, volume, opts) => enqueue(tabId, () => doSetEq(tabId, eq, volume, opts)); // same queue as volume - first capture must not race
const saveTimers = new Map(); // tabId -> timer

async function persistLater(tabId, kind, save) {
    try {
        if (!(await loadSettings()).restoreEnabled) return;
        const tab = await chrome.tabs.get(tabId);
        if (!/^https?:/.test(tab.url ?? "")) return;
        const host = hostOf(tab.url);
        const key = `${host}|${kind}`; // kind in key - an eq tick must not cancel a pending volume write
        clearTimeout(saveTimers.get(key));
        saveTimers.set(key, setTimeout(() => { saveTimers.delete(key); save(host); }, 300));
    } catch { }; // tab closed mid-drag - nothing to save
};

function persistVolume(tabId, volume) {
    clearTimeout(saveTimers.get(tabId));
    // drag fires dozens of ticks - storage read and tabs.get run once after drag stops, not per tick
    saveTimers.set(tabId, setTimeout(async () => {
        saveTimers.delete(tabId);
        try {
            if (!(await loadSettings()).restoreEnabled) return;
            const tab = await chrome.tabs.get(tabId);
            if (!/^https?:/.test(tab.url ?? "")) return;
            await saveDomainVolume(hostOf(tab.url), volume);
        } catch { }; // tab closed before timer fired - nothing to save
    }, 300));
};

const persistEq = (tabId, eq) => persistLater(tabId, "eq", (host) => saveDomainEq(host, eq));

async function restoreTab(tabId) {
    if (!(await loadSettings()).restoreEnabled) return { volume: null };
    const tab = await chrome.tabs.get(tabId);
    const saved = await getDomain(hostOf(tab.url));
    if (!saved) return { volume: null };
    await setVolume(tabId, saved.volume, { force: true, persist: false });
    await setEq(tabId, saved.eq, saved.volume, { persist: false });
    return { volume: saved.volume, eq: saved.eq };
};

async function getAudioStates() {
    if (!(await hasOffscreen())) return {}; // do not create the document just to ask it
    return toOffscreen({ action: ACTION.GET_AUDIO_STATES });
};

const BADGE_COLORS = {
    normal: ["#1E90FF", "#FFFFFF"],
    boost: ["#FFB020", "#000000"],
    loud: ["#FF3D3D", "#FFFFFF"]
};

const badgeTimers = new Map();
const updateBadgeLater = (tabId) => {
    clearTimeout(badgeTimers.get(tabId));
    badgeTimers.set(tabId, setTimeout(() => { badgeTimers.delete(tabId); updateBadge(tabId); }, 150)); // drag = 1 paint, not 60
};

async function updateBadge(tabId) {
    try {
        const audioStates = (await getAudioStates())[tabId];
        if (!audioStates) return;
        const changed = !!audioStates && (audioStates.volume !== 100 || audioStates.eq.some((g) => g !== 0)); // captured at default = effectively off, no badge
        const text = !changed ? "" : audioStates.volume !== 100 ? String(audioStates.volume) : "EQ";
        await chrome.action.setBadgeText({ tabId, text });
        if (!changed) return;
        const [bg, fg] = audioStates.volume >= 500 ? BADGE_COLORS.loud : audioStates.volume > 100 ? BADGE_COLORS.boost : BADGE_COLORS.normal;
        await chrome.action.setBadgeBackgroundColor({ tabId, color: bg });
        await chrome.action.setBadgeTextColor({ tabId, color: fg });
    } catch { }; // tab closed mid-update
};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // audible only appears in changeInfo when it flips - skip all other updates
    if (changeInfo.audible === undefined) return;
    chrome.runtime.sendMessage({ target: TARGET.POPUP, action: ACTION.AUDIBLE_CHANGED }).catch(() => { }); // popup closed = no receiver, throws
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!/^https?:/.test(changeInfo.url ?? "")) return; // url only appears when it changes
    try {
        if (!(await hasOffscreen())) return;
        const host = hostOf(changeInfo.url);
        // sync even when restore is off - else the stored host goes stale and a later switch-on misfires
        const res = await toOffscreen({ action: ACTION.SYNC_HOST, tabId, host });
        if (!res?.changed) return;
        if (!(await loadSettings()).restoreEnabled) return; // restore off = plain per-tab volume, keep it across sites
        const saved = await getDomain(host);
        const volume = saved?.volume ?? 100;
        const eq = saved?.eq ?? [...EQ_PRESETS.flat];
        // persist off - this is a restore, not a user change; saving would write the default back
        await setVolume(tabId, volume, { persist: false });
        await setEq(tabId, eq, volume, { persist: false });
        chrome.runtime.sendMessage({ target: TARGET.POPUP, action: ACTION.TAB_RESET, tabId, volume, eq }).catch(() => { });
    } catch { }; // tab closed mid-navigation
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // chrome wipes per-tab badge on navigation, capture survives it - paint again or user thinks ext is off
    if (changeInfo.status) updateBadgeLater(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    queues.delete(tabId);
    latestVol.delete(tabId);
    clearTimeout(badgeTimers.get(tabId));
    badgeTimers.delete(tabId);
    if (await hasOffscreen()) toOffscreen({ action: ACTION.TAB_CLOSED, tabId }).catch(() => { });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.target !== TARGET.SERVICE_WORKER) return;
    const jobs = {
        [ACTION.GET_AUDIBLE_TABS]: () => getAudibleTabs(),
        [ACTION.SET_VOLUME]: () => setVolume(msg.tabId, msg.volume, { force: msg.force }),
        [ACTION.RESTORE_TAB]: () => restoreTab(msg.tabId),
        [ACTION.GET_AUDIO_STATES]: () => getAudioStates(),
        [ACTION.SET_EQ]: () => setEq(msg.tabId, msg.eq, msg.volume),
    };
    const job = jobs[msg.action];
    if (!job) return;
    job().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true; // async reply
});