# Gentai Dashboard Project Handoff

Read this document before changing the dashboard. It records the important implementation decisions, safety boundary, battery protocol, and known limitations so future work does not need to rediscover them.

## Project goal

This is a lightweight, static dashboard for monitoring a Gentai 12.8 V 100 Ah LiFePO4 battery on an older iPad Mini 4. It uses only HTML, CSS, and JavaScript, is hosted by GitHub Pages, and is intended to stay open in Bluefy as a desk dashboard.

- Repository: `https://github.com/warwar13/gentai`
- Live dashboard: `https://warwar13.github.io/gentai/`
- Demo mode: `https://warwar13.github.io/gentai/?demo=1`
- Battery names seen in apps/scans: `DCHE123` and `BMC1_E123`
- Do not place the battery's MAC address in source files or public documentation.

There is no server, cloud database, analytics service, framework, package bundle, or third-party UI library. All telemetry stays in the browser.

## Non-negotiable battery safety boundary

The user wants telemetry only. Never add commands that modify, reset, calibrate, clear, heat, balance, configure, or switch battery/BMS features.

BLE notifications are not produced continuously by this BMS. A harmless query frame must be written to request each reading. These query writes are permitted; control writes are not.

`protocol.js` enforces a fixed allowlist through `buildReadQuery()`:

| Command | Meaning |
| --- | --- |
| `0x00` | Handshake |
| `0x10` | Manufacturer |
| `0x11` | Pack name |
| `0x20` | Running/protection status |
| `0x21` | Battery information |
| `0x22` | Cell voltages |
| `0xF5` | Firmware version |

`GentaiBatteryClient.query()` in `app.js` is the application's only BLE write path. It must continue to call `buildReadQuery()` before writing. Do not introduce a second BLE write path and do not weaken the allowlist. Unknown or non-read commands must fail before Bluetooth is contacted.

The automated tests assert this boundary. Keep those tests whenever the protocol is changed.

## Confirmed Bluetooth protocol

The GATT layout identified from the battery scan is:

| Purpose | UUID |
| --- | --- |
| Service | `00000001-0000-1000-8000-00805f9b34fb` |
| Query/write characteristic | `00000002-0000-1000-8000-00805f9b34fb` |
| Notification characteristic | `00000003-0000-1000-8000-00805f9b34fb` |

Bluefy's device picker filters for the advertised name prefixes `DCHE` and `BMC1_`.

Frames have this shape:

```text
AA command payloadLength payload... checksumLow checksumHigh
```

The checksum is the unsigned 16-bit sum of all bytes from `command` through the end of `payload`, encoded little-endian. Read queries use a zero-length payload. BLE notifications may split a frame across multiple events or contain leading invalid data; `FrameStream` buffers, resynchronizes, validates lengths/checksums, and emits complete frames.

### Battery information payload (`0x21`)

All multi-byte values are little-endian:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | signed 32-bit / 1000 | Pack voltage in volts |
| 4 | signed 32-bit / 1000 | Current in amps |
| 8 | unsigned byte | State of charge percent |
| 9 | unsigned byte | State of health percent |
| 10 | signed 32-bit / 1000 | Remaining capacity in Ah |
| 14 | signed 32-bit / 1000 | Full capacity in Ah |
| 18 | unsigned 16-bit | Cycle count |
| 20–23 | signed bytes | Four temperature probes in °C |
| 24 | signed byte | Ambient temperature in °C |
| 25 | signed byte | MOS temperature in °C |

Observed convention: negative current is discharging and positive current is charging. `powerW` remains signed internally as `voltageV * currentA`; the live card displays its absolute magnitude.

Charging support exists in decoding, history, graphs, estimates, and sessions, but has not yet been physically verified while this exact battery is connected to a charger. During charging it is expected to show positive amps, a Charging mode, time until full, positive signed power, charged Wh, and a Charging session.

### Other payloads

- `0x20`: running status includes a 32-bit protection/warning bitfield, FET information, balance mask, and disconnected-cell mask. Informational FET/heating bits are not displayed as warnings. The BMS protection panel is the authoritative warning display.
- `0x22`: each cell is an unsigned 16-bit millivolt value, little-endian. Zero entries are skipped.
- Identity payloads are decoded as null-trimmed text.
- Implausible battery values, invalid frames, and checksum failures are rejected rather than displayed.

## Connection lifecycle

- Battery information and running status are queried roughly every 5 seconds.
- Cell voltages are queried every third poll, roughly every 15 seconds.
- Manufacturer, pack name, and firmware are queried once after the handshake.
- Only one query is allowed to be pending at a time. It is retried once on failure.
- The selected Bluefy device ID is saved in `localStorage` under `gentai-device-id`.
- If Bluefy implements `navigator.bluetooth.getDevices()`, startup tries to reconnect to the remembered device.
- Unexpected disconnects use exponential retry delays capped at 30 seconds.
- The recovery panel provides **Release & reconnect** and **Choose battery again** actions.
- `pagehide` explicitly disconnects GATT to reduce stale sessions.
- Bluefy's screen-dimming control is disabled when its proprietary API is available.

The official Gentai app and BLE scanner must be closed while using the dashboard because this battery may accept only one active connection.

Safari on iPad does not provide Web Bluetooth. The live page must be opened over HTTPS in Bluefy. Demo mode does not use Bluetooth or persist generated records.

## Local history and analytics

`storage.js` owns IndexedDB and all calculations that should be independently testable.

- IndexedDB database: `gentai-battery-dashboard`
- Object store: `telemetry`
- Key: millisecond `timestamp`
- Save interval: one sample per minute while connected and the page is running
- Retention: 30 days, pruned locally
- A four-hour run creates only about 240 stored samples.
- Clearing Bluefy/browser site data deletes the history. There is no cloud backup or sync.

Each sample stores timestamp, SOC, SOH, voltage, signed current, signed power, remaining/full Ah, ambient/MOS temperatures, up to four cell voltages, and warning count.

Capacity tests use IndexedDB version 2 with separate `capacityTests` and `capacityTestSamples` stores. Only one test can be active. While it is active, every telemetry poll (roughly five seconds) is stored; completed tests remain until the user deletes them. Runs integrate discharged Ah and Wh with the trapezoidal rule, track charging separately, and reject intervals longer than 30 seconds. The test-only discharge curve plots pack voltage against cumulative measured Ah and breaks the line across rejected gaps. A run is labelled full-range only when it begins at 95% or higher and finishes at 5% or lower. The rating comparison is intentionally fixed at 100 Ah for this pack.

This is a battery-side DC measurement based on the BMS current and voltage sensors. It cannot measure inverter AC output or independently validate BMS calibration. Capacity-test controls only start and stop browser recording; they never send battery control commands.

Energy uses trapezoidal integration between adjacent samples. Intervals longer than five minutes are treated as gaps and are never estimated. This rule is important: iPad suspension, page closure, loss of range, or connection failures must not create invented usage.

The dashboard currently provides:

- Today: discharged Ah/Wh, net SOC change, highest 15-minute average load, and first crossing to 20%.
- Trend chart: discharge power, charge level, or voltage over 1h, 6h, 24h, 7d, or 30d.
- Detailed analytics over 24h, 7d, or 30d: used Wh, charged Wh, observed time under load, lowest SOC, cumulative energy balance, use by local hour, and charge/discharge sessions.
- Sessions: mode, start time, duration, SOC change, average W, peak W, and integrated Wh.

The main power trend displays discharge usage only. Detailed analytics separately track energy leaving and entering the battery.

## CSV export

`historyToCsv()` exports ISO timestamps and all stored fields. Export behavior is intentionally layered for iPad/Bluefy compatibility:

1. Try the native share sheet with a CSV `File`; the user selects **Save to Files**.
2. If file sharing is unavailable, open a dialog containing the CSV.
3. The fallback can copy the CSV or try an ordinary browser download.

Do not remove the copy fallback: some Bluefy/WebKit versions block ordinary blob downloads.

## At-a-glance status guides

`status.js` contains display thresholds. These are visual guides, not BMS protection settings, and they do not write anything to the battery.

| Measurement | Green | Amber | Red |
| --- | --- | --- | --- |
| Live absolute power, 600 W configured limit | Below 360 W | 360 W to below 510 W | 510 W or more |
| SOH | 90% or more | 80–89% | Below 80% |
| Ambient/probe temperature | Below 35°C | 35–44°C | 45°C or more |
| MOS temperature | Below 45°C | 45–59°C | 60°C or more |
| Cell spread | 20 mV or less | Above 20 through 50 mV | Above 50 mV |

The 600 W guide currently applies to the absolute power magnitude during both discharge and charging. If the user later confirms 600 W is only an inverter-output limit, pass the operating mode into the assessment and use a separate charging guide rather than silently changing the meaning.

## File map

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic dashboard markup, dialogs, inline SVG UI icons |
| `styles.css` | Responsive iPad-first layout, colors, cards, graphs, status states |
| `app.js` | Bluetooth lifecycle, polling, rendering, reconnect UI, canvas graphs, export flow, demo mode |
| `protocol.js` | BLE UUIDs, read-only allowlist, frame stream/parser, payload decoders, telemetry derivation |
| `storage.js` | IndexedDB, retention, CSV generation, daily/range analytics, session building |
| `status.js` | Pure functions for green/amber/red display assessments |
| `sw.js` | Network-first PWA shell cache |
| `manifest.webmanifest` | Installable standalone PWA metadata |
| `icon.svg` | PWA icon |
| `tests/` | Node tests for protocol safety/decoding, storage analytics/export, and display thresholds |

## PWA and deployment

GitHub Pages deploys the root of `main`. The service worker uses a named application-shell cache and a network-first strategy with an offline fallback.

Whenever a production asset changes:

1. Increment `CACHE_NAME` in `sw.js` (currently `gentai-dashboard-v6`).
2. Add any new runtime file to `APP_SHELL`.
3. After deployment, refresh or close/reopen Bluefy so the installed dashboard receives the new cache.

The manifest requests standalone landscape mode, but CSS also supports the iPad's portrait width. Canvas resolution is limited to at most 2× device pixel ratio to keep graph memory/CPU use reasonable on the older iPad.

## Safe change checklist

Before committing an update:

1. Confirm there is still only one BLE write location in `app.js` and it still uses `buildReadQuery()`.
2. Confirm no BMS control command has been added.
3. Run `npm test`.
4. Run `node --check app.js` and `node --check protocol.js`.
5. Run `git diff --check`.
6. Check `/?demo=1` at a 768 px viewport (iPad portrait) and a 1024 px viewport (landscape).
7. Bump the service-worker cache name for changed production files.
8. Keep battery scanner screenshots and the MAC address out of the public repository.

A useful read-only audit command is:

```powershell
rg -n "write(Value|ValueWithResponse)|0x(50|51|52|53|66|67|68)" -g "*.js" -g "!tests/**"
```

Expected production output is only the write-with-response/write fallback inside `GentaiBatteryClient.query()`, with no listed control codes.

## Known limitations and future decisions

- History is recorded only while Bluefy keeps the page alive and Bluetooth connected; a PWA cannot guarantee background execution on iPadOS.
- Charging is implemented but still needs a real charging session to confirm current direction and estimates on this exact unit.
- Status colors are general glance guides. Do not present them as manufacturer protection thresholds.
- The dashboard assumes a four-cell 12.8 V LiFePO4 pack for display/export, although the decoder accepts the nonzero cell values returned by the BMS.
- There is no remote backup. Export CSV regularly if the history matters.
- A browser or PWA update may require reopening Bluefy before a new service-worker cache becomes active.

When a known limitation is verified or changed, update this handoff document in the same commit.
