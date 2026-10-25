# Sound Controller & EQ

Per-tab volume control and equalizer for Chrome. Boost or cut any tab up to 600%, shape the sound with a 10-band EQ, and let the extension remember your settings for each site.

## Features

- **Per-tab volume:** 0% to 600%, with fine steps near 100%. Slider, +/- buttons, and mouse wheel.
- **10-band equalizer:** 60 Hz to 16 kHz, plus 4 presets (flat, bass, voice, treble). Closing the EQ panel bypasses it without losing your values.
- **Limiter:** a safety limiter at the end of the chain keeps heavy boosts from clipping.
- **Remember per site:** volume and EQ are saved for each site and restored when you open the popup on it. Can be turned off with the Auto restore switch.
- **Site change handling:** when a controlled tab moves to a different site, it switches to that site's saved settings, or back to 100% with flat EQ.
- **Toolbar badge:** shows the current volume (or `EQ`) on tabs you changed, so you can see at a glance that the extension is active. Blue is normal, amber is boost, red is 500% or more.
- **Audible tabs list:** see every tab playing sound and jump to it.
- **Export and import:** back up your per-site settings to a JSON file, restore them later with merge or replace, and undo the last import.
- **Keyboard shortcut:** Alt+V opens the popup. Change it at [chrome://extensions/shortcuts](chrome://extensions/shortcuts).

## How it works

```txt
popup  <->  service worker  <->  offscreen document
 UI          queue, storage,       Web Audio graph per tab:
             badge, navigation     source > 10 EQ filters > gain > limiter > speakers
```

Chrome does not let a service worker run audio, so the audio graph lives in a hidden offscreen document. The tab's audio is captured with `tabCapture`, processed there, and played back.

## Install (development)

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the project root.

Works in Chrome 116 or newer, and in other Chromium browsers that support the same APIs (Edge, Brave, Opera, ...).

## Build

```ps1
cd build
npm install
npm run build
```

Output:

- `build/dist/sound-controller-eq-<version>.zip` - the package.
- `build/dist/chrome/` - the unpacked copy.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `tabCapture` | Capture tab audio so volume and EQ can be applied. |
| `offscreen` | Host the Web Audio graph, because service workers cannot run it. |
| `tabs` | Show title, icon, and site of tabs playing sound, and know which site a tab is on to save settings per site. |
| `activeTab` | Start capture when you open the popup on a tab. |
| `storage` | Save per-site volume and EQ on your device. |

No host permissions. No content scripts. No remote code.

## Privacy

- Everything stays on your device. The extension makes no network requests.
- Audio is processed locally and never recorded or sent anywhere.
- The only stored data is the per-site volume and EQ values (by hostname) and the Auto restore switch.
- The export file lists the sites you changed. Share it with care.

## Good to know

- **Capture indicator:** Chrome shows its own capture icon on tabs the extension controls. This is normal and cannot be hidden.
- **Open the popup first:** Chrome only allows capture while the popup is opened on that tab. After that, the tab can also be changed from the audible list.
- **Restricted pages:** `chrome://` pages, the Web Store, and other special pages cannot be controlled.
- **Protected media:** some DRM-protected streams may refuse capture.
- **Firefox:** not supported. Firefox has no tab capture API.

## Credits

Bundled fonts: Ajax Sabon (titles) and Google Sans Flex (body).

## License

All rights reserved. See [LICENSE.md](LICENSE.md).
