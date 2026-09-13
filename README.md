# Prayer alarm

A full-month prayer calendar and adhan player for a Raspberry Pi connected to a speaker. The complete server, scheduler, state handling, HTML, CSS, and vanilla browser JavaScript live in `prayer-alarm.ts`.

Run directly with **Bun 1.4.x**, tested with 1.4.0. There is no JavaScript dependency, package installation, frontend build, or container. Pi3B runs it as a NixOS-managed systemd service. The two original MP3 recordings are local assets. **mpg123** is the system audio player.

## Run

With Bun 1.4 and mpg123 on your PATH:

```sh
bun --version
mpg123 --version
bun prayer-alarm.ts
```

Open `http://<pi-address>:3000`. Keep the terminal process running. Closing a browser does not stop the alarm; stopping the process does.

For your first manual speaker check, disable automatic playback:

```sh
AUTO_PLAY=0 bun prayer-alarm.ts
```

The play icon still uses the speaker. Set a low volume before starting a recording. Stop the process and restart without `AUTO_PLAY=0` when ready for scheduled playback.

## Pi3B service

The Pi runs the checkout at `/home/pi/projects/prayer-alarm` as `prayer-alarm.service`. Its NixOS definition lives in the nix-darwin repository at `machines/rpi/pi4/pi3b-64/prayer-alarm.nix`, imported by the Pi3B host configuration.

Nix pins Bun 1.4.0 and provides mpg123, audio group access, restart supervision, and LAN access on port 3000. The service starts at boot with automatic scheduling enabled. It preserves `/home/pi/projects/prayer-alarm/data` across restarts and code updates.

Open http://192.168.1.169:3000 on the local network. On the Pi:

```sh
systemctl status prayer-alarm
journalctl -u prayer-alarm -f
sudo systemctl restart prayer-alarm
```

After updating the checkout, run `bun test` and restart the service. Do not launch a second instance using its data directory. To rebuild the Pi configuration:

```sh
sudo nixos-rebuild switch --flake path:/home/pi/projects/nix-darwin/machines/rpi#pi3b-64
```

Port 3000 is the default because the former k3s Service uses 7867. Removing that Service or the Pi from k3s is a separate operation.

## Controls

- Browse complete months, including elapsed days, and jump to today.
- Tap or click anywhere on a prayer row to enable or disable that occurrence. Keyboard users can use Enter or Space. Month controls change every occurrence in the selected month.
- Play Fajr's recording or the ordinary recording used by Dhuhr, Asr, Maghrib, and Isha.
- Change global speaker gain while idle or playing. The 0–15 scale is linear gain, with the original default of 5. It is not a percentage.
- Use the play/pause icon to start, pause, or resume the recording at its current position. The stop icon ends it without disabling later prayers.
- Refresh times while keeping switches, or Reset month to refresh and enable its switches.
- Open More → Prayer offsets to set signed minute adjustments for Fajr, Dhuhr, Asr, Maghrib, and Isha. Negative is earlier; positive is later. Save applies all five to displayed times and scheduled audio in every month. Reset offsets restores all five to zero; Reset month keeps them.

Manual play does not consume a scheduled occurrence. An automatic prayer takes priority over a manual test, including a paused recording. Another fresh Play while audio is busy returns an error; the page uses Resume when paused. Audio never overlaps.

The page displays 12-hour times with AM/PM in the configured location's timezone, even when the visiting phone is in another timezone. The next prayer and next enabled adhan are shown separately.

A compact sticky header keeps the next prayer visible, with the timezone beside the countdown. On mobile, volume, the recording selector, and play/pause and stop icons stay in a bottom dock. The calendar reserves space for these controls so they do not cover the final row.

## State and scheduling

Switches, gain, prayer offsets, validated calendar caches, and consumed occurrences are saved atomically in `data/state.json`. This directory is ignored by Git. A lock prevents two processes from sharing the same state directory. Preserve this data when updating the code.

The previous, current, and following months are fetched from AlAdhan over HTTPS. A cached calendar remains usable for its own dates if the API is unavailable. There is no replacement calculation engine and no reuse of last month's times. Current-calendar absence, clock synchronization, audio errors, and failed saves are visible in the UI.

The scheduler checks once per second. It allows up to 60 seconds of delay while running. Startup does not replay past prayers; long clock jumps or stalls skip late occurrences. Reset and refresh do not replay consumed events. Offset changes never replay consumed occurrences or catch up a changed prayer moved to the present or past, including when its calendar arrives after the edit. Per-prayer change times persist with the settings so this also holds after a restart. Rows retain their original calendar day and switch, with a next-day or previous-day label when an adjustment crosses midnight. The next-prayer header shows its actual scheduled date.

Automatic events are recorded before playback to avoid duplicates after a crash. A crash between that write and actual playback can miss an event. A corrupt state file or changed location configuration fails closed: preserve the existing file and choose a new `DATA_DIR` deliberately rather than silently enabling all alarms.

On Pi3B's NixOS installation, automatic playback waits for the systemd-timesyncd synchronization marker. Manual playback is still available. This app does not change the host clock, audio mixer, firewall, or k3s configuration.

## Configuration

Set environment variables before running Bun. There is no separate configuration file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CITY` | `Auckland` | AlAdhan city |
| `COUNTRY` | `NewZealand` | AlAdhan country |
| `METHOD` | `3` | Muslim World League |
| `SCHOOL` | `0` | Standard school |
| `TZ` | `Pacific/Auckland` | Calendar and display timezone |
| `OFFSETS` | `0,0,0,0,0` | Initial signed minutes for Fajr,Dhuhr,Asr,Maghrib,Isha; each -180 to 180 |
| `HOST` | `0.0.0.0` | Listener address |
| `PORT` | `3000` | Listener port |
| `DATA_DIR` | `data/` beside the TS file | Persistent state and ownership lock |
| `AUTO_PLAY` | `1` | Set `0` for manual playback only |
| `MPG123_BIN` | `mpg123` | Player executable or absolute path |
| `AUDIO_DRIVER` | `alsa` on Linux, `coreaudio` on macOS | mpg123 output driver |
| `AUDIO_DEVICE` | `plughw:CARD=Headphones,DEV=0` on Linux | ALSA output; empty on macOS |
| `ALLOWED_HOSTS` | Local hostname, interface IPs, localhost | Additional comma-separated hostnames, without ports |

Prayer offsets are saved globally and survive restarts and month changes. `OFFSETS` seeds a new state file or an older file without saved offsets; saved settings then take precedence. Existing AlAdhan caches already include that startup baseline, so the local adjustment is `saved offset − startup offset`. For example, a cached +5-minute baseline changed to +8 needs only another 3 minutes. Editing offsets needs no network request. Keep the startup `OFFSETS` value unchanged when reusing a state directory, because it remains part of cache validation.

This is a LAN control page with no account system. Requests validate Host and Origin; do not expose it directly to the public internet. Additional hostnames must be configured explicitly.

## Tests

```sh
bun test
```

The tests use a fake player/protocol process and do not access a speaker. They exercise calendar validation, DST, scheduling, persistence, control requests, and playback cancellation.

For a silent browser check with a real mpg123 process:

```sh
AUTO_PLAY=0 HOST=127.0.0.1 AUDIO_DRIVER=sleep AUDIO_DEVICE= bun prayer-alarm.ts
```

The `sleep` driver decodes in real time without audio output. Use an isolated `DATA_DIR` if you do not want UI test settings to affect normal operation.

Before accepting the cutover on the actual Pi:

1. Run the tests with Bun 1.4.
2. Start with `AUTO_PLAY=0`, check the full month, toggle switches, and restart to check persistence.
3. Listen to both recordings at a low starting gain. Pause and resume without restarting the recording, adjust gain, and use Stop, including after 200 seconds.
4. Restart with automatic playback enabled and verify an enabled scheduled prayer plays with every browser closed. Confirm a disabled occurrence remains silent.

Only commit and push the replacement after these checks are accepted.

## HTTP controls

`GET /` serves the page. `GET /state?month=YYYY-MM` returns calendar and control status. `GET /timings` retains the legacy timing shape. `GET /health` returns process status and automatic readiness, with HTTP 503 when automatic playback is unavailable or deliberately paused.

Mutations accept JSON objects. Legacy control routes also accept empty bodies.

| Request | Body |
| --- | --- |
| `POST /timings` | `{"month":"2026-09","play_adhan":false}` |
| `PUT /timings/2026-09-14/Fajr` | `{"play_adhan":false}` |
| `POST /play` | `{"prayer":"Fajr"}`; empty defaults to Dhuhr |
| `POST /pause` | `{"paused":true}` to pause, `{"paused":false}` to resume the current recording |
| `POST /halt` | Empty |
| `POST /offsets` | `{"offsets":{"Fajr":0,"Dhuhr":0,"Asr":0,"Maghrib":0,"Isha":0}}`; exactly five integers, each -180 to 180 |
| `POST /volume` | `{"volume":2}` |
| `POST /volume-up`, `/volume-down` | Empty |
| `POST /refresh` | `{"month":"2026-09"}` |
| `POST /reset` | `{"month":"2026-09"}` |

`GET /state` includes the effective offsets keyed by prayer; `POST /offsets` returns the saved offsets after the durable write.

Month defaults to the current configured-zone month. Reset now refreshes and enables that month instead of terminating the process.

## Source and recordings

This replaces the original Rust/Axum/Rodio server and Solid/Vite UI from [zees-dev/prayer-alarm-rust](https://github.com/zees-dev/prayer-alarm-rust). Both production MP3 files are unchanged. Calendar requests preserve the Auckland defaults and use ISO timestamps for explicit daylight-saving offsets.

AlAdhan's city endpoint returned inconsistent geographic metadata during development. The app retains the original city query and validates dates, timezone, and method; it does not infer coordinates or silently switch calculation sources. Confirm the resulting timetable during acceptance.

Player control follows [mpg123's remote interface](https://raw.githubusercontent.com/madebr/mpg123/master/doc/README.remote).
