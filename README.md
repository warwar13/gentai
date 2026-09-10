# Gentai Battery Dashboard

A static, read-only Web Bluetooth dashboard for the Gentai 12.8 V 100 Ah battery identified as `DCHE123` / `BMC1_E123`.

## Battery safety boundary

The battery sends telemetry only after a query is written to its BLE command characteristic. The dashboard's only BLE write function accepts a fixed allowlist of information queries:

- `0x00` handshake
- `0x10` manufacturer
- `0x11` pack name
- `0x20` running status
- `0x21` battery information
- `0x22` cell voltages
- `0xF5` firmware version

Control, calibration, clearing, heating, FET, and configuration commands are not implemented. Attempts to construct any non-allowlisted command throw an error before Bluetooth is contacted.

## Run locally in demonstration mode

Web Bluetooth requires HTTPS, but the generated-data view can be checked without a battery:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/?demo=1
```

The live dashboard must be served through HTTPS and opened in Bluefy on iPadOS. Safari and other ordinary iPad browsers do not provide Web Bluetooth.

## Publish with GitHub Pages

1. Create a public GitHub repository and upload these files without changing their relative paths.
2. Open the repository's **Settings → Pages**.
3. Choose **Deploy from a branch**, select the main branch and `/ (root)`, then save.
4. Open the resulting `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/` address in Bluefy.
5. Close the official Gentai app, tap **Connect battery**, and select `DCHE123`.
6. Enable Bluefy full-screen mode and keep the iPad powered for continuous recording.

The first connection needs a user gesture. Later launches attempt to reconnect to Bluefy's remembered device automatically. A visible Reconnect button remains available when iPadOS requires another gesture.

### Reconnect recovery

If Bluefy or the battery retains an old Bluetooth session, the dashboard displays a persistent recovery panel:

1. Completely close the official Gentai app and any BLE scanner because the battery accepts only one active client.
2. Tap **Release & reconnect** to disconnect the stale GATT session and retry cleanly.
3. If that fails, tap **Choose battery again** and select `DCHE123` from Bluefy's picker.
4. As a final device-level reset, force-close Bluefy, toggle iPad Bluetooth off and on, reopen Bluefy, and choose the battery again.

The dashboard explicitly disconnects its browser GATT session when its page closes to reduce future stale connections.

## History and analysis

One reading is stored locally each minute while the page is open and connected. Records are retained for 30 days in IndexedDB. The dashboard calculates daily Ah and Wh consumed, net charge change, the highest 15-minute average load, and the time charge crosses 20%. Its detailed section shows cumulative used versus charged energy, use by hour, lowest charge, connected load time, and individual charging/discharging sessions over 24 hours, 7 days, or 30 days.

**Export CSV** opens the iPad share sheet when Bluefy supports file sharing; choose **Save to Files** to keep the CSV locally. If file sharing is unavailable, the dashboard opens a fallback where the CSV can be copied or downloaded. No telemetry is uploaded.

If the browser suspends Bluefy, Bluetooth is out of range, or the dashboard is closed, that interval is left as a gap. The dashboard never estimates missing usage.

## At-a-glance indicators

The live cards use green, amber, and red display guides. Power is compared with the configured 600 W limit: below 60% is comfortable, 60–85% is moderate, and 85% or more is near the limit. Health is green from 90%, amber from 80%, and red below 80%. Ambient temperature becomes amber at 35°C and red at 45°C; MOS temperature becomes amber at 45°C and red at 60°C. Cell spread is green through 20 mV, amber through 50 mV, and red above 50 mV.

These colors are quick visual guides, not replacements for the battery's own protection limits. The BMS protection-status panel remains the authoritative warning display.

## Tests

With Node.js installed:

```text
npm test
```

The parser tests cover the read-only command boundary, checksums, split BLE notifications, signed current, cell voltages, warnings, runtime estimates, daily usage, missing-data gaps, and CSV output.
