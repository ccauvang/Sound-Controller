import { TARGET, ACTION } from "../shared/messages.js";
import { VOLUME_STEPS, VOLUME_DEFAULT, indexOfVolume } from "../shared/volume.js";
import { EQ_BANDS, EQ_GAIN_RANGE, EQ_PRESETS } from "../shared/eq.js";
import { hostOf, loadSettings, setRestoreEnabled, buildExport, importSettings, undoImport, hasBackup, getTheme, setTheme, MAX_IMPORT_BYTES } from "../shared/settings.js";

const $ = (id) => document.getElementById(id);
const MAX_INDEX = VOLUME_STEPS.length - 1;
const MARK = (indexOfVolume(VOLUME_DEFAULT) / MAX_INDEX) * 100;
const FALLBACK_ICON = "../../assets/icon/icon-16.png";
const captured = new Set(); // tabs with a live capture - only these can be changed without opening popup on them
const HINT_LOCKED = 'Locked. Click "Open it", then open this popup on that tab once.';
const HINT_CURRENT = "Current tab. Use the controls above.";

// per tab state lives here until the capture step moves it into the service worker - popup close wipes it
const state = new Map();
const getState = (id) => {
    if (!state.has(id)) state.set(id, { volume: VOLUME_DEFAULT, eqOn: false, eq: [...EQ_PRESETS.flat] });
    return state.get(id);
};

const say = (el, text, isError = true) => {
    el.textContent = text;
    el.classList.toggle("error", isError);
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ""; }, 4000);
};

const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

const isFlat = (eq) => eq.every((g) => g === 0);

function setIcon(img, url) {
    img.onerror = () => { img.onerror = null; img.src = FALLBACK_ICON; }; // dead favicon urls are common
    img.src = url || FALLBACK_ICON;
};

// ---------- slider helpers (slider works on step index, not percent) ----------
function paint(range) {
    range.style.setProperty("--fill", `${(range.value / MAX_INDEX) * 100}%`);
    range.style.setProperty("--mark", `${MARK}%`);
    range.classList.toggle("boost", VOLUME_STEPS[range.value] > 100);
    range.classList.toggle("supperboost", VOLUME_STEPS[range.value] >= 500);
};

function setRange(range, volume) {
    range.value = indexOfVolume(volume);
    paint(range);
};

function nudge(range, dir) {
    range.value = Math.min(MAX_INDEX, Math.max(0, Number(range.value) + dir));
    range.dispatchEvent(new Event("input"));
};

function setupRange(range, onVolume) {
    range.min = 0;
    range.max = MAX_INDEX;
    range.step = 1;
    range.addEventListener("input", () => {
        paint(range);
        onVolume(VOLUME_STEPS[range.value]);
    });
    range.addEventListener("wheel", (e) => {
        if (range.disabled) return; // nudge fires input by script - disabled flag does not stop it. return before preventDefault so the popup still scrolls
        e.preventDefault(); // else the popup scrolls too
        nudge(range, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
};

// ---------- volume fan-out ----------
let masterTab = null;
const rows = new Map();

async function applyVolume(tabId, volume, force = false) {
    const state = getState(tabId);
    const prev = state.volume;
    state.volume = volume;
    syncMaster(tabId);
    syncRow(tabId);

    let res;
    try {
        res = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.SET_VOLUME, tabId, volume, force });
    } catch (e) {
        res = { error: e.message }; // falls into the revert branch below
    };

    if (res?.error) {
        state.volume = prev;
        syncMaster(tabId);
        syncRow(tabId);
        const msg = res.error.includes("invoked") ? "Cannot capture this tab. Open the popup on it first." : res.error;
        say(masterTab?.id === tabId ? $("volMsg") : $("listMsg"), msg);
        return;
    };
    if (res?.captured) {
        captured.add(tabId);
        syncRow(tabId);
    };
};

function syncMaster(tabId) {
    if (!masterTab || masterTab.id !== tabId) return;
    const state = getState(tabId);
    setRange($("volRange"), state.volume);
    $("volText").textContent = state.volume;
    $("volText").classList.toggle("boost", state.volume > 100);
    $("volText").classList.toggle("supperboost", state.volume >= 500);
    $("volText").classList.toggle("mute", state.volume == 0);
    eqSliders.forEach((s, i) => { s.value = state.eq[i]; });
    $("eqToggle").setAttribute("aria-expanded", String(state.eqOn));
    $("eqBody").classList.toggle("open", state.eqOn);
};

function syncRow(tabId) {
    const row = rows.get(tabId);
    if (!row) return;
    const state = getState(tabId);
    const isMaster = masterTab?.id === tabId;
    // master row is a mirror only - two sliders on one tab would fight, the big one above owns it
    const blocked = isMaster || !captured.has(tabId);
    setRange(row.range, state.volume);
    row.vol.textContent = `${state.volume}%`;
    row.vol.classList.toggle("boost", state.volume > 100);
    row.vol.classList.toggle("supperboost", state.volume >= 500);
    row.eq.hidden = !(state.eqOn && !isFlat(state.eq));
    row.range.disabled = blocked;
    row.open.hidden = isMaster; // already on this tab
    row.hint.hidden = !blocked;
    row.hint.textContent = isMaster ? HINT_CURRENT : HINT_LOCKED;
};

// ---------- master controls ----------
const volRange = $("volRange");
setupRange(volRange, (v) => masterTab && applyVolume(masterTab.id, v));
$("volDown").onclick = () => nudge(volRange, -1);
$("volUp").onclick = () => nudge(volRange, 1);
$("volReset").onclick = () => masterTab && applyVolume(masterTab.id, VOLUME_DEFAULT);

// ---------- EQ ----------
const eqSliders = [];

async function pushEq() {
    const tabId = masterTab.id;
    const state = getState(tabId);
    const eq = state.eqOn ? state.eq : EQ_PRESETS.flat; // closed panel = bypass, values kept for reopen
    syncRow(tabId);
    let res;
    try {
        res = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.SET_EQ, tabId, eq, volume: state.volume });
    } catch (e) {
        return say($("volMsg"), e.message);
    };
    if (res?.error) return say($("volMsg"), res.error);
    if (res?.captured) {
        captured.add(tabId);
        syncRow(tabId);
    };
};

function buildEq() {
    EQ_BANDS.forEach((hz, i) => {
        const band = document.createElement("div");
        band.className = "band";
        const track = document.createElement("div");
        track.className = "band__track";
        const input = document.createElement("input");
        input.type = "range";
        input.className = "slider eq-slider";
        input.min = EQ_GAIN_RANGE[0];
        input.max = EQ_GAIN_RANGE[1];
        input.step = 1;
        input.value = 0;
        input.setAttribute("aria-label", `${fmtHz(hz)} Hz`);
        input.addEventListener("input", () => {
            if (!masterTab) return;
            getState(masterTab.id).eq[i] = Number(input.value);
            pushEq();
        });
        const label = document.createElement("small");
        label.textContent = fmtHz(hz);
        track.append(input);
        band.append(track, label);
        $("eqBands").append(band);
        eqSliders.push(input);
    });

    for (const [name, gains] of Object.entries(EQ_PRESETS)) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = name;
        chip.addEventListener("click", () => {
            if (!masterTab) return;
            getState(masterTab.id).eq = [...gains];
            eqSliders.forEach((s, i) => { s.value = gains[i]; });
            pushEq();
        });
        $("eqPresets").append(chip);
    };
};

$("eqToggle").onclick = () => {
    if (!masterTab) return;
    const state = getState(masterTab.id);
    state.eqOn = !state.eqOn;
    $("eqToggle").setAttribute("aria-expanded", String(state.eqOn));
    $("eqBody").classList.toggle("open", state.eqOn);
    pushEq();
};

// ---------- auto restore switch ----------
const restoreSw = $("restoreSwitch");
const setSwitchUi = (on) => restoreSw.setAttribute("aria-checked", String(on));

restoreSw.onclick = async () => {
    const on = restoreSw.getAttribute("aria-checked") !== "true";
    setSwitchUi(on);
    await setRestoreEnabled(on);
};

// ---------- theme ----------
const root = document.documentElement;
const systemLight = matchMedia("(prefers-color-scheme: light)");
const currentTheme = () => root.dataset.theme ?? (systemLight.matches ? "light" : "dark");

$("theme").onclick = async () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    await setTheme(next);
};

async function refreshSettingsUi() {
    setSwitchUi((await loadSettings()).restoreEnabled);
    $("undoImport").hidden = !(await hasBackup());
};

// ---------- audible list ----------
function buildRow(tab) {
    const li = document.createElement("li");
    li.className = "row";
    li.innerHTML = `
    <button class="row__head" type="button" aria-expanded="false">
      <img class="row__icon" width="16" height="16" alt="Tab Icon" draggable="false">
      <span class="row__name"></span>
      <span class="row__vol"></span>
      <span class="row__eq" hidden>EQ</span>
    </button>
        <div class="collapse"><div class="collapse__inner">
      <div class="row__body">
        <input class="slider" type="range" aria-label="Tab volume">
        <button class="btn row__open" type="button">Open it</button>
      </div>
      <p class="row__hint" hidden>Locked. Click "Open it", then open this popup on that tab once.</p>
    </div></div>`;

    const row = {
        li, tab,
        head: li.querySelector(".row__head"),
        icon: li.querySelector(".row__icon"),
        name: li.querySelector(".row__name"),
        vol: li.querySelector(".row__vol"),
        eq: li.querySelector(".row__eq"),
        range: li.querySelector(".slider"),
        hint: li.querySelector(".row__hint"),
        open: li.querySelector(".row__open")
    };

    setupRange(row.range, (v) => applyVolume(tab.id, v));

    row.head.addEventListener("click", () => {
        const open = !li.classList.contains("open");
        for (const r of rows.values()) { // one open at a time keeps the popup short
            r.li.classList.remove("open");
            r.head.setAttribute("aria-expanded", "false");
        };
        li.classList.toggle("open", open);
        row.head.setAttribute("aria-expanded", String(open));
    });

    li.querySelector(".row__open").addEventListener("click", async () => {
        await chrome.tabs.update(row.tab.id, { active: true });
        await chrome.windows.update(row.tab.windowId, { focused: true });
    });

    return row;
};

function removeRow(id) {
    const row = rows.get(id);
    if (!row) return;
    rows.delete(id);
    const { li } = row;
    li.style.height = `${li.offsetHeight}px`; // css cannot animate from auto, needs a fixed start
    void li.offsetHeight; // force reflow so the transition has a start frame
    li.classList.add("leaving");
    li.addEventListener("transitionend", (e) => { if (e.propertyName === "height") li.remove(); });
    setTimeout(() => li.remove(), 400); // transitionend can miss when motion is reduced
};

function applyTabs(tabs) {
    const ids = new Set(tabs.map((t) => t.id));
    for (const id of [...rows.keys()]) if (!ids.has(id)) removeRow(id);

    for (const tab of tabs) {
        let row = rows.get(tab.id);
        if (!row) {
            row = buildRow(tab);
            rows.set(tab.id, row);
            $("list").append(row.li);
        };
        row.tab = tab;
        row.name.textContent = tab.title || hostOf(tab.url); // textContent - tab titles are untrusted
        row.li.title = tab.title;
        row.li.classList.toggle("muted", tab.muted);
        setIcon(row.icon, tab.favIconUrl);
        syncRow(tab.id);
    };
    $("empty").hidden = rows.size > 0;
};

async function load() {
    const tabs = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.GET_AUDIBLE_TABS }).catch(() => []);
    applyTabs(Array.isArray(tabs) ? tabs : []); // worker error comes back as an object, not an array
};

async function openOnTab(tab) {
    // popup open on this tab is the only moment chrome allows capture - restore the saved volume, or at least unlock
    const res = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.RESTORE_TAB, tabId: tab.id });
    if (res?.error) return say($("volMsg"), res.error);
    if (res?.volume != null) {
        captured.add(tab.id);
        const state = getState(tab.id);
        state.volume = res.volume;
        state.eq = [...res.eq];
        state.eqOn = !isFlat(res.eq);
        syncMaster(tab.id);
        syncRow(tab.id);
    } else if (tab.audible) {
        applyVolume(tab.id, getState(tab.id).volume, true); // no saved row, still unlock the tab for other popups
    };
};

// ---------- boot ----------
async function hydrate() {
    // popup state dies on close - ask the worker what is really playing at what gain
    const live = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.GET_AUDIO_STATES });
    if (!live || live.error) return;
    for (const [id, a] of Object.entries(live)) {
        const state = getState(Number(id));
        captured.add(Number(id));
        state.volume = a.volume;
        state.eq = [...a.eq];
        state.eqOn = !isFlat(a.eq);
    };
};

async function initMaster() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    masterTab = tab ?? null;
    const ok = !!tab && /^https?:/.test(tab.url ?? "");
    $("controls").inert = !ok;
    $("targetName").textContent = ok ? tab.title : "This page cannot be controlled";
    setIcon($("targetIcon"), tab?.favIconUrl);
    if (ok) syncMaster(tab.id);
    // popup open on this tab = the only moment chrome allows capture, so take it now
    if (ok && !captured.has(tab.id)) await openOnTab(tab);
};

$("gear").onclick = () => {
    const open = $("settings").classList.toggle("open");
    $("gear").setAttribute("aria-expanded", String(open));
};

// ---------- export / import ----------
$("exportBtn").onclick = async () => {
    const data = await buildExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "sound-controller-settings.json" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say($("settingsMsg"), `Exported ${Object.keys(data.domains).length} sites`, false);
};

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
    const file = $("importFile").files[0];
    $("importFile").value = ""; // same file twice must still fire change
    if (!file) return;
    try {
        if (file.size > MAX_IMPORT_BYTES) throw new Error("File too big");
        const r = await importSettings(await file.text(), $("importReplace").checked);
        say($("settingsMsg"), `Imported ${r.imported} sites${r.skipped ? `, skipped ${r.skipped} bad rows` : ""}. Applies when you open each site.`, false);
    } catch (e) {
        say($("settingsMsg"), e.message);
    };
    await refreshSettingsUi();
};

$("undoImport").onclick = async () => {
    try { await undoImport(); say($("settingsMsg"), "Import undone", false); } catch (e) { say($("settingsMsg"), e.message); };
    await refreshSettingsUi();
};

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== TARGET.POPUP) return;
    if (msg.action === ACTION.AUDIBLE_CHANGED) load(); // live refresh while popup open
    if (msg.action === ACTION.TAB_RESET) {
        // popup state is stale after the worker reset the tab - a later eq tick would resend old bands
        const state = getState(msg.tabId);
        state.volume = msg.volume;
        state.eq = [...msg.eq];
        state.eqOn = !isFlat(msg.eq);
        syncMaster(msg.tabId);
        syncRow(msg.tabId);
    };
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== masterTab?.id) return;
    // title and favicon land after the url change - the reset message cannot carry them
    if (changeInfo.title) $("targetName").textContent = changeInfo.title;
    if (changeInfo.favIconUrl) setIcon($("targetIcon"), changeInfo.favIconUrl);
});

root.dataset.theme = currentTheme(); // sync first so system-light users see no dark flash
const savedTheme = await getTheme();
if (savedTheme) root.dataset.theme = savedTheme;

buildEq();
await refreshSettingsUi();
await hydrate();
await initMaster();
await load();