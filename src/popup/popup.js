import { TARGET, ACTION } from "../shared/messages.js";
import { VOLUME_STEPS, VOLUME_DEFAULT, indexOfVolume } from "../shared/volume.js";
import { EQ_BANDS, EQ_GAIN_RANGE, EQ_PRESETS } from "../shared/eq.js";
import {
    hostOf,
    loadSettings,
    setRestoreEnabled,
    buildExport,
    importSettings,
    undoImport,
    hasBackup,
    getTheme,
    setTheme,
    loadProfiles,
    saveProfile,
    deleteProfile,
    renameProfile,
    MAX_PROFILE_NAME,
    MAX_PROFILES,
    MAX_IMPORT_BYTES
} from "../shared/settings.js";

const $ = (id) => document.getElementById(id);
const MAX_INDEX = VOLUME_STEPS.length - 1;
const MARK = (indexOfVolume(VOLUME_DEFAULT) / MAX_INDEX) * 100;
const FALLBACK_ICON = "../../assets/icon/icon-16.png";
const captured = new Set(); // tabs with a live capture - only these can be changed without opening popup on them
const HINT_LOCKED = 'Locked. Click "Open it", then open this popup on that tab once.';
const HINT_CURRENT = "Current tab. Use the controls above.";

// per tab state lives here until the capture step moves it into the service worker - popup close wipes it
const state = new Map();
let profiles = [];
let knownKeys = new Set(); // gains of every built-in preset and custom profile - one lookup tells if sliders match something saved
const eqKey = (eq) => eq.join(","); // plain string, cannot collide like a hash
const safeEq = (eq) => (Array.isArray(eq) && eq.length === EQ_BANDS.length ? [...eq] : [...EQ_PRESETS.flat]); // worker reply can miss eq - spread of undefined would kill boot

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
    let lastWheel = 0;
    range.addEventListener("wheel", (e) => {
        e.preventDefault(); // else the popup scrolls too
        if (range.disabled) return;
        const now = performance.now();
        if (now - lastWheel < 50) return; // trackpad fires wheel dozens/sec
        lastWheel = now;
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
    syncEqUi();
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

let eqBusy = false, eqDirty = false;

async function pushEq() {
    const tabId = masterTab.id;
    syncRow(tabId);
    if (eqBusy) { eqDirty = true; return; } // drag = dozens of ticks - one in flight, rerun once with newest bands
    eqBusy = true;
    try {
        do {
            eqDirty = false;
            const state = getState(tabId); // read fresh each loop - newest bands
            const eq = state.eqOn ? state.eq : EQ_PRESETS.flat; // closed panel = bypass, values kept for reopen
            const res = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.SET_EQ, tabId, eq, volume: state.volume });
            if (res?.error) { say($("volMsg"), res.error); break; };
            if (res?.captured) { captured.add(tabId); syncRow(tabId); };
            syncEqUi();
        } while (eqDirty);
    } catch (e) {
        say($("volMsg"), e.message);
    } finally {
        eqBusy = false;
    };
};

function applyEq(gains) {
    if (!masterTab) return;
    getState(masterTab.id).eq = [...gains];
    eqSliders.forEach((s, i) => { s.value = gains[i]; });
    pushEq();
};

function rebuildKnown() {
    knownKeys = new Set([...Object.values(EQ_PRESETS), ...profiles.map((p) => p.eq)].map(eqKey));
};

function syncEqUi() {
    if (!masterTab) return;
    const key = eqKey(getState(masterTab.id).eq);
    const match = profiles.find((p) => eqKey(p.eq) === key);
    $("profilePick").hidden = profiles.length === 0;
    if (!profiles.length) setPickOpen(false); // last profile deleted - panel must not stay open behind a hidden wrapper
    $("profileLabel").textContent = match ? match.name : "Pick Custom Preset";
    $("profileTrigger").classList.toggle("active", !!match);
    for (const li of $("profileList").children) li.classList.toggle("active", li.dataset.id === match?.id);
    // row stays visible at the cap so the user sees why save is gone - disabled beats a silent hide
    const full = profiles.length >= MAX_PROFILES;
    $("profileSaveRow").hidden = knownKeys.has(key);
    $("profileName").disabled = full;
    $("profileSave").disabled = full;
    $("profileName").placeholder = full ? `Limit reached (${MAX_PROFILES})` : "Profile name";
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
        chip.addEventListener("click", () => applyEq(gains));
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

// ---------- custom profiles ----------
const X_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M6.70718 4.5858C6.31666 4.19528 5.68349 4.19528 5.29297 4.5858L4.58586 5.29291C4.19534 5.68343 4.19534 6.3166 4.58586 6.70712L9.87877 12L4.5859 17.2929C4.19537 17.6834 4.19537 18.3166 4.5859 18.7071L5.293 19.4142C5.68353 19.8048 6.31669 19.8048 6.70722 19.4142L12.0001 14.1214L17.293 19.4142C17.6835 19.8048 18.3167 19.8048 18.7072 19.4142L19.4143 18.7071C19.8048 18.3166 19.8048 17.6834 19.4143 17.2929L14.1214 12L19.4143 6.70712C19.8048 6.3166 19.8048 5.68343 19.4143 5.29291L18.7072 4.5858C18.3167 4.19528 17.6835 4.19528 17.293 4.5858L12.0001 9.87871L6.70718 4.5858Z" fill="currentColor"></path></svg>';
const EDIT_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.0671 2.27157C17.5 2.09228 17.9639 2 18.4324 2C18.9009 2 19.3648 2.09228 19.7977 2.27157C20.2305 2.45086 20.6238 2.71365 20.9551 3.04493C21.2864 3.37621 21.5492 3.7695 21.7285 4.20235C21.9077 4.63519 22 5.09911 22 5.56761C22 6.03611 21.9077 6.50003 21.7285 6.93288C21.5492 7.36572 21.2864 7.75901 20.9551 8.09029L20.4369 8.60845L15.3916 3.56308L15.9097 3.04493C16.241 2.71365 16.6343 2.45086 17.0671 2.27157Z"></path> <path d="M13.9774 4.9773L3.6546 15.3001C3.53154 15.4231 3.44273 15.5762 3.39694 15.7441L2.03526 20.7369C1.94084 21.0831 2.03917 21.4534 2.29292 21.7071C2.54667 21.9609 2.91693 22.0592 3.26314 21.9648L8.25597 20.6031C8.42387 20.5573 8.57691 20.4685 8.69996 20.3454L19.0227 10.0227L13.9774 4.9773Z"></svg>';

function setPickOpen(open) {
    $("profilePanel").classList.toggle("open", open);
    $("profileTrigger").setAttribute("aria-expanded", String(open));
};

async function renderProfiles() {
    profiles = await loadProfiles();
    rebuildKnown();
    $("profileList").replaceChildren(...profiles.map(buildPickRow));
    syncEqUi();
};

function buildPickRow(p) {
    const li = document.createElement("li");
    li.className = "pick-row";
    li.dataset.id = p.id;

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick-item";
    pick.textContent = p.name; // textContent - names can come from an imported file
    pick.title = p.name;
    pick.addEventListener("click", () => { applyEq(p.eq); setPickOpen(false); });

    // sibling button, not nested - a button inside a button is invalid html
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pick-x";
    del.innerHTML = X_SVG; // constant string, no user text
    del.title = "Click 3 times fast to delete";
    del.setAttribute("aria-label", `Delete ${p.name}, press 3 times fast`);
    armDelete(del, p.id);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "pick-edit";
    edit.innerHTML = EDIT_SVG; // constant string, no user text
    edit.title = "Rename";
    edit.setAttribute("aria-label", `Rename ${p.name}`);
    edit.addEventListener("click", () => startRename(li, pick, p));

    li.append(pick, edit, del);
    return li;
};

function startRename(li, pick, p) {
    if (li.querySelector(".pick-input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pick-input";
    input.maxLength = MAX_PROFILE_NAME;
    input.value = p.name;
    input.setAttribute("aria-label", `New name for ${p.name}`);

    let done = false; // renderProfiles removes the input, which fires blur - without this flag finish runs twice
    const finish = async (commit, fromBlur = false) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (commit && name && name !== p.name) {
            try {
                await renameProfile(p.id, name);
            } catch (e) {
                say($("eqMsg"), e.message);
                if (!fromBlur) { // enter - keep the input open so the user fixes the name instead of retyping it
                    done = false;
                    input.classList.add("bad");
                    input.focus();
                    return;
                };
                // blur - focus already moved on, drop the edit and keep the old name
            };
        };
        await renderProfiles();
    };

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.stopPropagation(); finish(false); } // panel handler would close the whole list
    });
    input.addEventListener("input", () => input.classList.remove("bad"));
    input.addEventListener("blur", () => finish(true, true)); // click away saves, bad name falls back to the old one

    pick.replaceWith(input);
    input.focus();
    input.select();
};

// own counter instead of e.detail - keyboard Enter gives detail 0 and would never delete
function armDelete(btn, id) {
    let hits = 0;
    let timer;
    const reset = () => { hits = 0; delete btn.dataset.hits; };
    btn.addEventListener("click", async () => {
        hits++;
        clearTimeout(timer);
        if (hits < 3) {
            btn.dataset.hits = hits; // css turns this into the color and the number
            timer = setTimeout(reset, 700);
            return;
        };
        reset();
        await deleteProfile(id);
        await renderProfiles();
    });
};

$("profileTrigger").onclick = () => setPickOpen($("profileTrigger").getAttribute("aria-expanded") !== "true");

document.addEventListener("click", (e) => {
    if (!$("profilePick").contains(e.target)) setPickOpen(false);
});

$("profilePick").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        setPickOpen(false);
        $("profileTrigger").focus();
        return;
    };
    const items = [...$("profileList").querySelectorAll(".pick-item")];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    items[Math.min(items.length - 1, Math.max(0, to))].focus();
});

async function saveCurrentProfile() {
    if (!masterTab) return;
    const name = $("profileName").value.trim();
    if (!name) return say($("eqMsg"), "Enter a name first");
    try {
        await saveProfile(name, getState(masterTab.id).eq);
        $("profileName").value = "";
        await renderProfiles(); // key now matches the new profile, so save row hides itself
    } catch (e) {
        say($("eqMsg"), e.message);
    };
};

$("profileSave").onclick = saveCurrentProfile;
$("profileName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveCurrentProfile(); });

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
    const res = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.RESTORE_TAB, tabId: tab.id }).catch((e) => ({ error: e.message }));
    if (res?.error) return say($("volMsg"), res.error);
    if (res?.volume != null) {
        captured.add(tab.id);
        const state = getState(tab.id);
        state.volume = res.volume;
        state.eq = safeEq(res.eq);
        state.eqOn = !isFlat(state.eq);
        syncMaster(tab.id);
        syncRow(tab.id);
    } else if (tab.audible) {
        applyVolume(tab.id, getState(tab.id).volume, true); // no saved row, still unlock the tab for other popups
    };
};

// ---------- boot ----------
async function hydrate() {
    // popup state dies on close - ask the worker what is really playing at what gain
    const live = await chrome.runtime.sendMessage({ target: TARGET.SERVICE_WORKER, action: ACTION.GET_AUDIO_STATES }).catch(() => null);
    if (!live || live.error) return;
    for (const [id, a] of Object.entries(live)) {
        const state = getState(Number(id));
        captured.add(Number(id));
        state.volume = a.volume;
        state.eq = safeEq(a.eq);
        state.eqOn = !isFlat(state.eq);
    };
};

async function initMaster() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    masterTab = tab ?? null;
    const ok = !!tab && /^(https?|file):/.test(tab.url ?? "");
    $("controls").inert = !ok;
    $("targetName").textContent = ok ? tab.title : "This page cannot be controlled";
    setIcon($("targetIcon"), tab?.favIconUrl);
    if (ok) syncMaster(tab.id);
    else setRange($("volRange"), VOLUME_DEFAULT); // inert page skips syncMaster - slider would sit at input midpoint while text says 100
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
    say($("settingsMsg"), `Exported ${Object.keys(data.domains).length} sites, ${data.profiles.length} profiles`, false);
};

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
    const file = $("importFile").files[0];
    $("importFile").value = ""; // same file twice must still fire change
    if (!file) return;
    try {
        if (file.size > MAX_IMPORT_BYTES) throw new Error("File too big");
        const r = await importSettings(await file.text(), $("importReplace").checked);
        say($("settingsMsg"), `Imported ${r.imported} sites, ${r.profiles} profiles${r.skipped ? `, skipped ${r.skipped} bad rows` : ""}. Applies when you open each site.`, false);
    } catch (e) {
        say($("settingsMsg"), e.message);
    };
    await refreshSettingsUi();
    await renderProfiles(); // select list would show stale profiles otherwise
};

$("undoImport").onclick = async () => {
    try { await undoImport(); say($("settingsMsg"), "Import undone", false); } catch (e) { say($("settingsMsg"), e.message); };
    await refreshSettingsUi();
    await renderProfiles();
};

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== TARGET.POPUP) return;
    if (msg.action === ACTION.AUDIBLE_CHANGED) load(); // live refresh while popup open
    if (msg.action === ACTION.TAB_RESET) {
        // popup state is stale after the worker reset the tab - a later eq tick would resend old bands
        const state = getState(msg.tabId);
        state.volume = msg.volume;
        state.eq = safeEq(msg.eq);
        state.eqOn = !isFlat(state.eq);
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
buildEq();
$("profileName").maxLength = MAX_PROFILE_NAME; // html copy of the number would drift from settings.js
await renderProfiles();
const [savedTheme] = await Promise.all([getTheme(), refreshSettingsUi(), hydrate()]);
if (savedTheme) root.dataset.theme = savedTheme;
await initMaster();
await load();