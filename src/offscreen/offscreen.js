import { TARGET, ACTION } from "../shared/messages.js";
import { EQ_BANDS, EQ_GAIN_RANGE, EQ_PRESETS } from "../shared/eq.js";

const audio = new Map(); // tabId -> { ctx, stream, gain, volume }

function release(tabId) {
    const hasAudioTab = audio.get(tabId);
    if (!hasAudioTab) return;
    audio.delete(tabId);
    clearTimeout(hasAudioTab.bypassTimer);
    hasAudioTab.stream.getTracks().forEach((t) => t.stop());
    hasAudioTab.ctx.close();
};

function buildFilters(ctx) {
    return EQ_BANDS.map((hz, i) => {
        const f = ctx.createBiquadFilter();
        f.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
        f.frequency.value = hz;
        f.Q.value = 1.4; // shelves ignore Q - only peaking bands use it
        return f;
    });
};

async function capture(tabId, streamId, volume, host) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
    });
    const ctx = new AudioContext({ latencyHint: "balanced" });
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    const filters = buildFilters(ctx);
    const source = ctx.createMediaStreamSource(stream);
    // boost 600% plus eq +12 dB stacks to about +27 dB - hard knee, high ratio, fast attack catches peaks before they hit the speakers
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    [source, gain, limiter, ctx.destination].reduce((a, b) => a.connect(b)); // starts flat - filters out of the chain, wire() adds them when eq moves
    if (ctx.state === "suspended") await ctx.resume(); // no user gesture in offscreen - context can start suspended and the captured tab goes silent
    stream.getAudioTracks()[0]?.addEventListener("ended", () => release(tabId));
    audio.set(tabId, { ctx, stream, source, gain, limiter, filters, volume, host, eq: [...EQ_PRESETS.flat], flat: true, bypassTimer: null });
};

function setGain(tabId, volume) {
    const hasAudioTab = audio.get(tabId);
    volume = Math.min(600, Math.max(0, Number(volume) || 0));
    hasAudioTab.volume = volume;
    // 15ms ramp - hard jumps per slider tick make clicks
    hasAudioTab.gain.gain.setTargetAtTime(volume / 100, hasAudioTab.ctx.currentTime, 0.015);
};

function wire(a, flat) {
    if (a.flat === flat) return;
    a.source.disconnect();
    a.filters.forEach((f) => f.disconnect());
    const chain = flat ? [a.source, a.gain, a.limiter] : [a.source, ...a.filters, a.gain, a.limiter];
    chain.reduce((x, y) => x.connect(y)); // gain -> limiter -> destination already connected, repeats are ignored
    a.flat = flat;
};

function setEq(tabId, gains) {
    if (!Array.isArray(gains) || gains.length !== EQ_BANDS.length) throw new Error("bad eq");
    const hasAudioTab = audio.get(tabId);
    // never trust the sender - a bad gain value is loud, not just wrong
    const safe = gains.map((g) => Math.min(EQ_GAIN_RANGE[1], Math.max(EQ_GAIN_RANGE[0], Number(g) || 0)));
    hasAudioTab.eq = safe;
    const flat = safe.every((g) => g === 0);
    clearTimeout(hasAudioTab.bypassTimer);
    if (!flat) wire(hasAudioTab, false); // filters sit at 0 dB until the ramp moves them - no click
    safe.forEach((g, i) => hasAudioTab.filters[i].gain.setTargetAtTime(g, hasAudioTab.ctx.currentTime, 0.015));
    if (flat) hasAudioTab.bypassTimer = setTimeout(() => wire(hasAudioTab, true), 150); // let the ramp reach 0 first, else click
};

async function handle(msg) {
    switch (msg.action) {
        case ACTION.HAS_TAB: {
            return audio.has(msg.tabId);
        }
        case ACTION.GET_AUDIO_STATES: {
            return Object.fromEntries([...audio].map(([id, a]) => [id, { volume: a.volume, eq: a.eq }]));
        }
        case ACTION.SET_VOLUME: {
            if (!audio.has(msg.tabId)) {
                if (!msg.streamId) return { needStream: true }; // not captured - worker fetches a stream id and resends
                await capture(msg.tabId, msg.streamId, msg.volume, msg.host);
            };
            setGain(msg.tabId, msg.volume);
            return { ok: true };
        }
        case ACTION.SET_EQ: {
            if (!audio.has(msg.tabId)) {
                if (!msg.streamId) return { needStream: true }; // not captured - worker fetches a stream id and resends
                await capture(msg.tabId, msg.streamId, msg.volume, msg.host);
                setGain(msg.tabId, msg.volume); // clamp and sanitize - capture() trusts raw volume
            };
            setEq(msg.tabId, msg.eq);
            return { ok: true };
        }
        case ACTION.SYNC_HOST: {
            const hasAudioTab = audio.get(msg.tabId);
            if (!hasAudioTab || hasAudioTab.host === msg.host) return { changed: false };
            hasAudioTab.host = msg.host;
            return { changed: true };
        }
        case ACTION.TAB_CLOSED: {
            release(msg.tabId);
            return { ok: true };    
        }
    };
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.target !== TARGET.OFFSCREEN) return; // popup and worker share this channel - only answer ours
    handle(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
});