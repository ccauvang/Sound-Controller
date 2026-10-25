import { TARGET, ACTION } from "../shared/messages.js";

const audio = new Map(); // tabId -> { ctx, stream, gain, volume }

function release(tabId) {
    const a = audio.get(tabId);
    if (!a) return;
    audio.delete(tabId);
    a.stream.getTracks().forEach((t) => t.stop());
    a.ctx.close();
    console.log("[offscreen] released", tabId);
};

async function capture(tabId, streamId, volume) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
    });
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    ctx.createMediaStreamSource(stream).connect(gain).connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume(); // no user gesture in offscreen, context can start suspended
    stream.getAudioTracks()[0]?.addEventListener("ended", () => release(tabId)); // tab closed or capture killed - map would lie otherwise
    audio.set(tabId, { ctx, stream, gain, volume: 100 });
    console.log("[offscreen] captured", tabId);
};

function setGain(tabId, volume) {
    const a = audio.get(tabId);
    a.volume = volume;
    // 15ms ramp - hard jumps per slider tick make clicks
    a.gain.gain.setTargetAtTime(volume / 100, a.ctx.currentTime, 0.015);
};

async function handle(msg) {
    switch (msg.action) {
        case ACTION.HAS_TAB:
            return audio.has(msg.tabId);
        case ACTION.GET_AUDIO_STATES:
            return Object.fromEntries([...audio].map(([id, a]) => [id, { volume: a.volume }]));
        case ACTION.SET_VOLUME:
            if (!audio.has(msg.tabId)) {
                if (!msg.streamId) throw new Error("no stream id");
                await capture(msg.tabId, msg.streamId, msg.volume);
            };
            setGain(msg.tabId, msg.volume);
            return { ok: true };
        case ACTION.TAB_CLOSED:
            release(msg.tabId);
            return { ok: true };
    };
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== TARGET.OFFSCREEN) return; // popup and worker share this channel - only answer ours
    handle(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
});