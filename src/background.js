import { TARGET, ACTION } from "./shared/messages.js";
import { loadSettings, getDomain, saveDomainVolume, hostOf } from "./shared/settings.js";

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

async function hasOffscreen() {
    const found = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return found.length > 0;
};

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    // two quick slider ticks would both try to create - chrome allows only one document
    creating ??= chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Capture tab audio to change volume and apply EQ"
    }).finally(() => { creating = null; });
    await creating;
};

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, ...msg });

async function doSetVolume(tabId, volume, { force = false, persist = true } = {}) {
    const live = (await hasOffscreen()) && (await toOffscreen({ action: ACTION.HAS_TAB, tabId }));
    if (!live && volume === 100 && !force) {
        if (persist) persistVolume(tabId, volume); // user picked 100 on an uncaptured tab - still forget the saved value
        return { ok: true, captured: false };
    };
    await ensureOffscreen();
    const streamId = live ? null : await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const res = await toOffscreen({ action: ACTION.SET_VOLUME, tabId, volume, streamId });
    if (res?.error) throw new Error(res.error);
    if (persist) persistVolume(tabId, volume);
    return { ok: true, captured: true };
};

// one chain per tab - parallel first ticks would capture the same tab twice and leak a stream
const queues = new Map();

function setVolume(tabId, volume, opts) {
    const prev = queues.get(tabId) ?? Promise.resolve();
    const next = prev.catch(() => { }).then(() => doSetVolume(tabId, volume, opts));
    queues.set(tabId, next);
    return next;
};

const saveTimers = new Map(); // host -> timer

async function persistVolume(tabId, volume) {
    try {
        if (!(await loadSettings()).restoreEnabled) return;
        const tab = await chrome.tabs.get(tabId);
        if (!/^https?:/.test(tab.url ?? "")) return;
        const host = hostOf(tab.url);
        clearTimeout(saveTimers.get(host));
        // slider drag fires dozens of ticks - only the last one is worth a write
        saveTimers.set(host, setTimeout(() => { saveTimers.delete(host); saveDomainVolume(host, volume); }, 300));
    } catch { }; // tab closed mid-drag - nothing to save
};

async function restoreTab(tabId) {
    if (!(await loadSettings()).restoreEnabled) return { volume: null };
    const tab = await chrome.tabs.get(tabId);
    const saved = await getDomain(hostOf(tab.url));
    if (!saved) return { volume: null };
    await setVolume(tabId, saved.volume, { force: true, persist: false });
    return { volume: saved.volume };
};

async function getAudioStates() {
    if (!(await hasOffscreen())) return {}; // do not create the document just to ask it
    return toOffscreen({ action: ACTION.GET_AUDIO_STATES });
};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // audible only appears in changeInfo when it flips - skip all other updates
    if (changeInfo.audible === undefined) return;
    console.log("[audible]", changeInfo.audible ? "START" : "STOP", toInfo(tab));
    console.log("[audible] now playing:", await getAudibleTabs());
    chrome.runtime.sendMessage({ target: TARGET.POPUP, action: ACTION.AUDIBLE_CHANGED }).catch(() => { }); // popup closed = no receiver, throws
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    console.log("[closed]", tabId);
    queues.delete(tabId);
    if (await hasOffscreen()) toOffscreen({ action: ACTION.TAB_CLOSED, tabId }).catch(() => { });
});

getAudibleTabs().then((tabs) => console.log("[boot] audible:", tabs));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== TARGET.SERVICE_WORKER) return;
    const jobs = {
        [ACTION.GET_AUDIBLE_TABS]: () => getAudibleTabs(),
        [ACTION.SET_VOLUME]: () => setVolume(msg.tabId, msg.volume, { force: msg.force }),
        [ACTION.RESTORE_TAB]: () => restoreTab(msg.tabId),
        [ACTION.GET_AUDIO_STATES]: () => getAudioStates()
    };
    const job = jobs[msg.action];
    if (!job) return;
    job().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true; // async reply
});