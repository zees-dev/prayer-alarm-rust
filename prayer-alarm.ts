import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

export const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;
export type Prayer = (typeof PRAYERS)[number];
type Occurrence = { prayer: Prayer; iso: string; time: string };
type Day = { date: string; prayers: Occurrence[] };
type Calendar = { month: string; fetchedAt: number; days: Day[] };
type Config = ReturnType<typeof readConfig>;
type Saved = {
  version: 1;
  fingerprint: string;
  volume: number;
  months: Record<string, Calendar>;
  overrides: Record<string, boolean>;
  consumed: Record<string, string>;
};
export type Player = {
  status: { state: string; prayer?: Prayer; source?: string; error?: string };
  play(
    prayer: Prayer,
    volume: number,
    source: "manual" | "automatic",
  ): Promise<void>;
  halt(): Promise<void>;
  pause(paused: boolean): Promise<void>;
  volume(value: number): Promise<void>;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
class HttpError extends Error {
  constructor(
    public status: number,
    text: string,
  ) {
    super(text);
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(400, `${name} must be an integer ${min}–${max}`);
  return value;
}
export function readConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const number = (key: string, fallback: number, min: number, max: number) =>
    integer(Number(env[key] ?? fallback), min, max, key);
  const timezone = env.TZ || "Pacific/Auckland";
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const offsets = (env.OFFSETS || "0,0,0,0,0")
    .split(",")
    .map((v) => integer(Number(v), -180, 180, "OFFSETS"));
  if (offsets.length !== 5)
    throw new Error(
      "OFFSETS requires five signed minutes: Fajr,Dhuhr,Asr,Maghrib,Isha",
    );
  const host = env.HOST || "0.0.0.0",
    port = number("PORT", 3000, 1, 65535);
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    hostname().toLowerCase(),
    host.toLowerCase(),
  ]);
  for (const interfaces of Object.values(networkInterfaces()))
    for (const address of interfaces || [])
      allowedHosts.add(
        address.family === "IPv6" ? `[${address.address}]` : address.address,
      );
  for (const name of (env.ALLOWED_HOSTS || "").split(",").filter(Boolean))
    allowedHosts.add(name.trim().toLowerCase());
  if (env.AUTO_PLAY && !["0", "1"].includes(env.AUTO_PLAY))
    throw new Error("AUTO_PLAY must be 0 or 1");
  return {
    city: env.CITY || "Auckland",
    country: env.COUNTRY || "NewZealand",
    method: number("METHOD", 3, 0, 99),
    school: number("SCHOOL", 0, 0, 1),
    timezone,
    offsets,
    host,
    port,
    allowedHosts,
    dataDir: resolve(env.DATA_DIR || join(import.meta.dir, "data")),
    autoPlay: env.AUTO_PLAY !== "0",
    mpg123: env.MPG123_BIN || "mpg123",
    audioDriver:
      env.AUDIO_DRIVER || (process.platform === "linux" ? "alsa" : "coreaudio"),
    audioDevice:
      env.AUDIO_DEVICE ??
      (process.platform === "linux" ? "plughw:CARD=Headphones,DEV=0" : ""),
  };
}
function monthKey(value: string) {
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) ||
    Number(value.slice(0, 4)) < 1970 ||
    Number(value.slice(0, 4)) > 2200
  )
    throw new HttpError(400, "Invalid month; use YYYY-MM");
  return value;
}
export function monthShift(month: string, delta: number) {
  monthKey(month);
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + delta, 1)).toISOString().slice(0, 7);
}
const zoneFormatters = new Map<
  string,
  {
    date: Intl.DateTimeFormat;
    time: Intl.DateTimeFormat;
  }
>();
function formatters(zone: string) {
  let cached = zoneFormatters.get(zone);
  if (!cached) {
    cached = {
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      time: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    };
    zoneFormatters.set(zone, cached);
  }
  return cached;
}
function localDate(time: number, zone: string) {
  return formatters(zone).date.format(new Date(time));
}
function wallTime(time: number, zone: string) {
  return formatters(zone).time.format(new Date(time));
}
function fingerprint(c: Config) {
  return JSON.stringify([
    c.city,
    c.country,
    c.method,
    c.school,
    c.timezone,
    c.offsets,
  ]);
}
export function calendarURL(c: Config, month: string) {
  monthKey(month);
  const [year, m] = month.split("-");
  const [f, d, a, g, i] = c.offsets;
  const url = new URL(
    `https://api.aladhan.com/v1/calendarByCity/${year}/${Number(m)}`,
  );
  url.search = new URLSearchParams({
    city: c.city,
    country: c.country,
    method: String(c.method),
    school: String(c.school),
    timezonestring: c.timezone,
    iso8601: "true",
    tune: `0,${f},0,${d},${a},${g},0,${i},0`,
  }).toString();
  return url.href;
}
function validateDays(days: Day[], month: string, c: Config) {
  const [year, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year!, m!, 0)).getUTCDate();
  if (days.length !== count)
    throw new Error(`Incomplete calendar for ${month}`);
  for (let index = 0; index < count; index++) {
    const day = object(days[index]),
      date = `${month}-${String(index + 1).padStart(2, "0")}`;
    if (
      day.date !== date ||
      !Array.isArray(day.prayers) ||
      day.prayers.length !== 5
    )
      throw new Error(`Invalid calendar date ${date}`);
    day.prayers.forEach((raw, j) => {
      const p = object(raw),
        iso = p.iso;
      if (
        p.prayer !== PRAYERS[j] ||
        typeof iso !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/.test(
          iso,
        ) ||
        !Number.isFinite(Date.parse(iso))
      )
        throw new Error(`Invalid timing ${date}/${PRAYERS[j]}`);
      if (
        iso.slice(0, 10) !== date ||
        localDate(Date.parse(iso), c.timezone) !== date ||
        wallTime(Date.parse(iso), c.timezone) !== iso.slice(11, 16) ||
        p.time !== iso.slice(11, 16)
      )
        throw new Error(`Timing timezone/date mismatch ${date}`);
    });
  }
}
export function normalizeCalendar(
  raw: unknown,
  month: string,
  c: Config,
): Calendar {
  monthKey(month);
  const response = object(raw);
  if (response.code !== 200 || !Array.isArray(response.data))
    throw new Error("Calendar API returned an unsuccessful response");
  const days = response.data
    .map((item) => {
      const row = object(item),
        meta = object(row.meta),
        gregorian = object(object(row.date).gregorian),
        timings = object(row.timings);
      if (meta.timezone !== c.timezone || object(meta.method).id !== c.method)
        throw new Error(
          "Calendar method or timezone differs from configuration",
        );
      if (
        typeof gregorian.date !== "string" ||
        !/^\d{2}-\d{2}-\d{4}$/.test(gregorian.date)
      )
        throw new Error("Invalid Gregorian date");
      const date = gregorian.date.split("-").reverse().join("-");
      return {
        date,
        prayers: PRAYERS.map((prayer) => {
          const iso = timings[prayer];
          if (typeof iso !== "string") throw new Error(`Missing ${prayer}`);
          return { prayer, iso, time: iso.slice(11, 16) };
        }),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  validateDays(days, month, c);
  return { month, days, fetchedAt: Date.now() };
}

async function atomicSave(path: string, value: Saved) {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
async function acquireLock(dir: string) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "owner.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path);
      await Bun.write(join(path, "pid"), String(process.pid));
      return async () => {
        await rm(path, { recursive: true, force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let pid = 0;
      try {
        pid = Number(await readFile(join(path, "pid"), "utf8"));
      } catch {}
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error(
          "State owner lock has no valid PID; inspect owner.lock before removing it",
        );
      try {
        process.kill(pid, 0);
        throw new Error(`Another prayer alarm owns this state, PID ${pid}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      // A stale owner is removed only after positively observing that its PID does not exist.
      await rm(path, { recursive: true });
    }
  }
  throw new Error("Could not acquire state owner lock");
}
function validateSaved(raw: unknown, c: Config): Saved {
  const s = object(raw);
  if (s.version !== 1 || s.fingerprint !== fingerprint(c))
    throw new Error(
      "State version or location settings changed; preserve state.json and use a new DATA_DIR",
    );
  integer(s.volume, 0, 15, "Saved volume");
  const months = object(s.months),
    overrides = object(s.overrides),
    consumed = object(s.consumed);
  for (const [key, value] of Object.entries(months)) {
    monthKey(key);
    const calendar = object(value);
    if (
      calendar.month !== key ||
      typeof calendar.fetchedAt !== "number" ||
      !Array.isArray(calendar.days)
    )
      throw new Error("Invalid saved calendar");
    validateDays(calendar.days as Day[], key, c);
  }
  for (const [id, value] of Object.entries(overrides))
    if (
      !/^\d{4}-\d{2}-\d{2}\/(Fajr|Dhuhr|Asr|Maghrib|Isha)$/.test(id) ||
      typeof value !== "boolean"
    )
      throw new Error("Invalid saved switch");
  for (const [id, value] of Object.entries(consumed))
    if (
      !/^\d{4}-\d{2}-\d{2}\/(Fajr|Dhuhr|Asr|Maghrib|Isha)$/.test(id) ||
      typeof value !== "string"
    )
      throw new Error("Invalid saved event");
  return s as unknown as Saved;
}

export function createPlayer(c: Config): Player {
  type Child = Bun.Subprocess<{
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
  }>;
  type Session = {
    child: Child;
    stopped: boolean;
    playing: boolean;
    paused: boolean;
    waiters: Set<{
      match: (line: string) => boolean;
      resolve: () => void;
      reject: (e: Error) => void;
    }>;
  };
  let session: Session | undefined,
    generation = 0,
    desiredGain = 5,
    stopping: Promise<void> = Promise.resolve(),
    pauseQueue: Promise<void> = Promise.resolve();
  const player: Player = {
    status: { state: "idle" },
    play,
    halt,
    pause,
    volume,
  };
  function send(s: Session, command: string) {
    s.child.stdin.write(command + "\n");
    s.child.stdin.flush();
  }
  function wait(s: Session, match: (line: string) => boolean, timeout = 4000) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.waiters.delete(w);
        reject(new Error("mpg123 acknowledgement timed out"));
      }, timeout);
      const w = {
        match,
        resolve: () => {
          clearTimeout(timer);
          s.waiters.delete(w);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          s.waiters.delete(w);
          reject(e);
        },
      };
      s.waiters.add(w);
    });
  }
  function command(s: Session, text: string, match: (line: string) => boolean) {
    // Listen before writing so an immediate acknowledgement cannot be missed.
    const acknowledged = wait(s, match);
    send(s, text);
    return acknowledged;
  }
  function fail(s: Session, error: string) {
    if (s.stopped) return;
    for (const w of [...s.waiters]) w.reject(new Error(error));
    if (session === s) {
      player.status = { state: "error", error };
      s.child.kill();
    }
  }
  async function lines(
    s: Session,
    stream: ReadableStream<Uint8Array>,
    stderr = false,
  ) {
    const reader = stream.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      id3 = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 65536) buffer = buffer.slice(-32768);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (stderr) {
            if (/error|failed|cannot|can't/i.test(line))
              fail(s, line.slice(0, 300));
            continue;
          }
          if (line === "@I {") {
            id3 = true;
            continue;
          }
          if (id3) {
            if (line === "@I }") id3 = false;
            continue;
          }
          if (line.startsWith("@E ")) {
            fail(s, line.slice(3));
            continue;
          }
          for (const w of [...s.waiters]) if (w.match(line)) w.resolve();
          if (line === "@P 2") {
            s.playing = true;
            s.paused = false;
          }
          if (line === "@P 1") s.paused = true;
          if (line === "@P 0" && s.playing && !s.stopped) {
            s.stopped = true;
            send(s, "QUIT");
            if (session === s) player.status = { state: "idle" };
          }
        }
      }
    } catch (e) {
      fail(s, message(e));
    }
  }
  async function stop(s: Session) {
    s.stopped = true;
    for (const w of [...s.waiters]) w.reject(new Error("Playback cancelled"));
    const ack = wait(s, (line) => line === "@P 0", 400).catch(() => {});
    try {
      send(s, "STOP");
      await ack;
      send(s, "QUIT");
    } catch {}
    const timer = setTimeout(() => s.child.kill("SIGKILL"), 600);
    try {
      await s.child.exited;
    } finally {
      clearTimeout(timer);
      if (session === s) session = undefined;
    }
  }
  async function halt() {
    generation++;
    const s = session;
    player.status = { state: "stopping" };
    stopping = stopping.then(() => (s ? stop(s) : undefined));
    await stopping;
    player.status = { state: "idle" };
  }
  async function play(
    prayer: Prayer,
    gain: number,
    source: "manual" | "automatic",
  ) {
    if (
      source === "manual" &&
      (session ||
        player.status.state === "starting" ||
        player.status.state === "stopping")
    )
      throw new HttpError(
        409,
        "Audio is busy. Halt before playing another recording.",
      );
    const ticket = ++generation;
    if (source === "automatic" && session) {
      const owned = session;
      stopping = stopping.then(() => stop(owned));
    }
    desiredGain = gain;
    player.status = { state: "starting", prayer, source };
    await stopping;
    if (ticket !== generation) return;
    const args = [c.mpg123, "-R", "-o", c.audioDriver];
    if (c.audioDevice) args.push("-a", c.audioDevice);
    let s: Session;
    try {
      const child = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      s = {
        child,
        playing: false,
        paused: false,
        stopped: false,
        waiters: new Set(),
      };
      session = s;
      const ready = wait(s, (line) => line.startsWith("@R "));
      void lines(s, child.stdout);
      void lines(s, child.stderr, true);
      void child.exited.then((code) => {
        if (session === s) {
          session = undefined;
          if (!s.stopped && player.status.state !== "error")
            player.status = {
              state: "error",
              error: `mpg123 exited unexpectedly (${code})`,
            };
        }
        for (const w of [...s.waiters]) w.reject(new Error("mpg123 exited"));
      });
      await ready;
      if (ticket !== generation) return;
      send(s, "SILENCE");
      await command(s, "RVA off", (line) => line === "@RVA off");
      if (ticket !== generation) return;
      const startupGain = desiredGain;
      await command(s, `VOLUME ${startupGain * 100}`, (line) => line.startsWith("@V "));
      if (ticket !== generation) return;
      const file = join(
        import.meta.dir,
        "mp3",
        prayer === "Fajr" ? "adhan-fajr.mp3" : "adhan-turkish.mp3",
      );
      await command(s, `LOAD ${file}`, (line) => line === "@P 2");
      if (ticket === generation && !s.stopped && desiredGain !== startupGain)
        await volume(desiredGain);
      if (ticket === generation && !s.stopped)
        player.status = { state: "playing", prayer, source };
    } catch (e) {
      if (ticket !== generation) return;
      player.status = { state: "error", error: message(e) };
      if (session) {
        const owned = session;
        await stop(owned);
      }
      throw new HttpError(503, message(e));
    }
  }
  async function pause(paused: boolean) {
    const owned = session,
      ticket = generation;
    const work = pauseQueue.then(async () => {
      if (
        !owned ||
        owned !== session ||
        ticket !== generation ||
        owned.stopped ||
        !["playing", "paused"].includes(player.status.state)
      ) {
        throw new HttpError(409, "No active recording to pause or resume");
      }
      if (owned.paused === paused) return;
      try {
        await command(
          owned,
          "PAUSE",
          (line) => line === (paused ? "@P 1" : "@P 2"),
        );
        if (session === owned && ticket === generation && !owned.stopped)
          player.status = {
            ...player.status,
            state: paused ? "paused" : "playing",
          };
      } catch (e) {
        if (session !== owned || ticket !== generation || owned.stopped) return;
        fail(owned, message(e));
        throw new HttpError(503, message(e));
      }
    });
    pauseQueue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async function volume(value: number) {
    desiredGain = value;
    const s = session;
    if (!s || s.stopped || !s.playing) return;
    try {
      await command(s, `VOLUME ${value * 100}`, (line) => line.startsWith("@V "));
    } catch (e) {
      fail(s, message(e));
      throw new HttpError(503, message(e));
    }
  }
  return player;
}

export async function createApp(
  c: Config,
  options: {
    now?: () => number;
    fetch?: typeof fetch;
    player?: Player;
    clockReady?: () => Promise<boolean>;
  } = {},
) {
  const release = await acquireLock(c.dataDir),
    path = join(c.dataDir, "state.json"),
    now = options.now || Date.now,
    fetcher = options.fetch || fetch,
    player = options.player || createPlayer(c);
  let saved: Saved;
  try {
    saved = (await Bun.file(path).exists())
      ? validateSaved(await Bun.file(path).json(), c)
      : {
          version: 1,
          fingerprint: fingerprint(c),
          volume: 5,
          months: {},
          overrides: {},
          consumed: {},
        };
    await atomicSave(path, saved);
  } catch (e) {
    await release();
    throw new Error(`Cannot open state safely: ${message(e)}`);
  }
  let queue = Promise.resolve(),
    closed = false,
    lastTick = now(),
    startup = lastTick,
    clock = false,
    storageError = "",
    haltGeneration = 0;
  const errors = new Map<string, string>(),
    inflight = new Map<string, Promise<Calendar>>(),
    retry = new Map<string, { at: number; count: number }>();
  const clockReady =
    options.clockReady ||
    (() =>
      process.platform === "linux"
        ? Bun.file("/run/systemd/timesync/synchronized").exists()
        : Promise.resolve(true));
  const current = () => localDate(now(), c.timezone).slice(0, 7);
  function transact<T>(change: (draft: Saved) => T | Promise<T>): Promise<T> {
    const work = queue.then(async () => {
      if (closed) throw new HttpError(503, "Application is shutting down");
      const draft = structuredClone(saved),
        result = await change(draft);
      try {
        await atomicSave(path, draft);
        saved = draft;
        storageError = "";
      } catch (e) {
        storageError = message(e);
        throw new HttpError(
          503,
          `Settings could not be saved: ${storageError}`,
        );
      }
      return result;
    });
    queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  function prune(draft: Saved, viewed: string) {
    const active = current(),
      keep = new Set([
        monthShift(active, -1),
        active,
        monthShift(active, 1),
        viewed,
      ]);
    for (const key of Object.keys(draft.months))
      if (!keep.has(key)) delete draft.months[key];
    const before = monthShift(active, -2);
    for (const table of [draft.consumed, draft.overrides])
      for (const key of Object.keys(table))
        if (key.slice(0, 7) < before) delete table[key];
  }
  async function refresh(month: string, force = false): Promise<Calendar> {
    monthKey(month);
    if (!force && saved.months[month]) return saved.months[month];
    const pending = inflight.get(month);
    if (pending) return pending;
    if (!force && (retry.get(month)?.at || 0) > now())
      throw new HttpError(503, errors.get(month) || "Calendar retry pending");
    if (inflight.size >= 4)
      throw new HttpError(503, "Calendar requests busy; try again shortly");
    const task = (async () => {
      try {
        const response = await fetcher(calendarURL(c, month), {
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) throw new Error(`Calendar HTTP ${response.status}`);
        const calendar = normalizeCalendar(await response.json(), month, c);
        calendar.fetchedAt = now();
        await transact((draft) => {
          draft.months[month] = calendar;
          prune(draft, month);
        });
        errors.delete(month);
        retry.delete(month);
        return calendar;
      } catch (e) {
        const count = (retry.get(month)?.count || 0) + 1;
        retry.set(month, {
          count,
          at: now() + Math.min(300000, 5000 * 2 ** Math.min(count - 1, 6)),
        });
        errors.set(month, message(e));
        throw new HttpError(503, `Calendar unavailable: ${message(e)}`);
      } finally {
        inflight.delete(month);
      }
    })();
    inflight.set(month, task);
    return task;
  }
  function events() {
    const month = current();
    return [monthShift(month, -1), month, monthShift(month, 1)]
      .flatMap((key) =>
        (saved.months[key]?.days || []).flatMap((day) =>
          day.prayers.map((p) => ({
            ...p,
            date: day.date,
            id: `${day.date}/${p.prayer}`,
            enabled: saved.overrides[`${day.date}/${p.prayer}`] ?? true,
          })),
        ),
      )
      .sort(
        (a, b) =>
          Date.parse(a.iso) - Date.parse(b.iso) ||
          PRAYERS.indexOf(a.prayer) - PRAYERS.indexOf(b.prayer),
      );
  }
  function automatic() {
    const reason = !c.autoPlay
      ? "Automatic playback paused by AUTO_PLAY=0"
      : !clock
        ? "Waiting for a synchronized clock"
        : storageError
          ? "State persistence failed"
          : !saved.months[current()]
            ? "Current calendar unavailable"
            : player.status.state === "error"
              ? "Audio player reported an error"
              : "";
    return {
      enabled: c.autoPlay,
      ready: !reason,
      reason: reason || "Automatic playback ready",
    };
  }
  function snapshot(month = current()) {
    monthKey(month);
    const future = events().filter((p) => Date.parse(p.iso) > now());
    const calendar = saved.months[month];
    return {
      serverTime: now(),
      timezone: c.timezone,
      city: c.city,
      country: c.country,
      today: localDate(now(), c.timezone),
      month,
      volume: saved.volume,
      days: (calendar?.days || []).map((day) => ({
        ...day,
        prayers: day.prayers.map((p) => ({
          ...p,
          id: `${day.date}/${p.prayer}`,
          enabled: saved.overrides[`${day.date}/${p.prayer}`] ?? true,
        })),
      })),
      nextPrayer: future[0] || null,
      nextAdhan: future.find((p) => p.enabled) || null,
      playback: { ...player.status },
      automatic: automatic(),
      calendar: calendar
        ? { fetchedAt: calendar.fetchedAt, cached: errors.has(month) }
        : null,
      errors: [...errors.values(), ...(storageError ? [storageError] : [])],
      consumed: { ...saved.consumed },
    };
  }
  async function maintain() {
    if (closed) return;
    try {
      clock = await clockReady();
    } catch {
      clock = false;
    }
    const month = current();
    await Promise.allSettled(
      [month, monthShift(month, 1)].map((m) =>
        refresh(m, errors.has(m) && (retry.get(m)?.at || 0) <= now()),
      ),
    );
  }
  async function tick() {
    if (closed) return;
    const moment = now(),
      ticket = haltGeneration;
    const jump = moment < lastTick - 5000 || moment - lastTick > 60000;
    lastTick = moment;
    const pending = events().filter(
      (p) => Date.parse(p.iso) <= moment && !saved.consumed[p.id],
    );
    if (!pending.length) return;
    const chosen = await transact((draft) => {
      let selected: (typeof pending)[number] | undefined;
      for (const p of pending) {
        if (draft.consumed[p.id]) continue;
        const due = Date.parse(p.iso),
          enabled = draft.overrides[p.id] ?? true;
        const disposition =
          due < startup
            ? "startup-skipped"
            : !enabled
              ? "disabled"
              : !c.autoPlay
                ? "paused"
                : !clock
                  ? "clock-unsynchronized"
                  : jump || moment - due > 60000
                    ? "missed"
                    : selected
                      ? "collision"
                      : "claimed";
        draft.consumed[p.id] = disposition;
        if (disposition === "claimed") selected = p;
      }
      return selected;
    });
    if (chosen && ticket === haltGeneration && !closed) {
      try {
        await player.play(chosen.prayer, saved.volume, "automatic");
        errors.delete("audio");
      } catch (e) {
        errors.set("audio", message(e));
      }
    }
  }
  function checkRequest(req: Request, url: URL) {
    const host = (req.headers.get("host") || url.host).toLowerCase();
    let parsed: URL;
    try {
      parsed = new URL(`http://${host}`);
    } catch {
      throw new HttpError(403, "Invalid Host");
    }
    if (
      !c.allowedHosts.has(parsed.hostname) ||
      Number(parsed.port || 80) !== c.port ||
      host !== url.host.toLowerCase()
    )
      throw new HttpError(403, "Host is not allowed");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin)
        throw new HttpError(403, "Cross-origin mutation rejected");
      if (req.headers.get("sec-fetch-site") === "cross-site")
        throw new HttpError(403, "Cross-site mutation rejected");
    }
  }
  async function body(req: Request) {
    if (Number(req.headers.get("content-length") || 0) > 4096)
      throw new HttpError(413, "Body exceeds 4 KB");
    const reader = req.body?.getReader();
    let length = 0,
      text = "";
    const decoder = new TextDecoder();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 4096) {
          await reader.cancel();
          throw new HttpError(413, "Body exceeds 4 KB");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    }
    if (length === 0) return {};
    if (
      !/^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "")
    )
      throw new HttpError(415, "Use Content-Type: application/json");
    try {
      return object(JSON.parse(text));
    } catch {
      throw new HttpError(400, "Expected a JSON object");
    }
  }
  async function handle(req: Request): Promise<Response> {
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    try {
      const url = new URL(req.url);
      checkRequest(req, url);
      const route = url.pathname,
        month = monthKey(url.searchParams.get("month") || current());
      if (req.method === "GET") {
        if (route === "/" || route === "/index.html")
          return new Response(HTML, {
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            },
          });
        if (route === "/health") {
          const a = automatic();
          return Response.json(
            {
              status: "up",
              ...a,
              playback: player.status,
              errors: snapshot().errors,
            },
            { status: a.ready ? 200 : 503, headers },
          );
        }
        if (route === "/state" || route === "/timings") {
          if (!saved.months[month])
            try {
              await refresh(month);
            } catch {}
          const state = snapshot(month);
          if (route === "/state") return Response.json(state, { headers });
          return Response.json(
            state.days.map((day) => ({
              date: day.date,
              timestamp: Math.floor(Date.parse(day.prayers[0]!.iso) / 1000),
              timings: Object.fromEntries(
                day.prayers.map((p) => [p.time + ":00", p.prayer]),
              ),
              play_adhan: Object.fromEntries(
                day.prayers.map((p) => [p.prayer, p.enabled]),
              ),
            })),
            { headers },
          );
        }
        throw new HttpError(404, "Not found");
      }
      if (!["POST", "PUT"].includes(req.method))
        throw new HttpError(405, "Method not allowed");
      const data = await body(req);
      if (route === "/halt" && req.method === "POST") {
        haltGeneration++;
        await player.halt();
        errors.delete("audio");
        return Response.json({ status: "halted" }, { headers });
      }
      if (route === "/pause" && req.method === "POST") {
        if (typeof data.paused !== "boolean")
          throw new HttpError(400, "paused must be boolean");
        await player.pause(data.paused);
        return Response.json({ playback: { ...player.status } }, { headers });
      }
      if (route === "/play" && req.method === "POST") {
        const prayer = PRAYERS.find(
          (p) =>
            p.toLowerCase() === String(data.prayer ?? "Dhuhr").toLowerCase(),
        );
        if (!prayer) throw new HttpError(400, "Invalid prayer");
        await player.play(prayer, saved.volume, "manual");
        errors.delete("audio");
        return Response.json({ status: "playing" }, { headers });
      }
      if (
        ["/volume", "/volume-up", "/volume-down"].includes(route) &&
        req.method === "POST"
      ) {
        const value = await transact((draft) => {
          draft.volume =
            route === "/volume"
              ? integer(data.volume, 0, 15, "volume")
              : Math.max(
                  0,
                  Math.min(
                    15,
                    draft.volume + (route === "/volume-up" ? 1 : -1),
                  ),
                );
          return draft.volume;
        });
        await player.volume(value);
        return Response.json({ volume: value }, { headers });
      }
      const selected = monthKey(
        typeof data.month === "string" ? data.month : month,
      );
      if (
        ["/timings", "/reset", "/refresh"].includes(route) &&
        req.method === "POST"
      ) {
        if (route === "/refresh") {
          await refresh(selected, true);
          return Response.json({ status: "refreshed" }, { headers });
        }
        if (route === "/timings" && typeof data.play_adhan !== "boolean")
          throw new HttpError(400, "play_adhan must be boolean");
        const calendar = await refresh(selected, route === "/reset");
        await transact((draft) => {
          for (const day of calendar.days)
            for (const p of PRAYERS)
              draft.overrides[`${day.date}/${p}`] =
                route === "/reset" ? true : (data.play_adhan as boolean);
        });
        return Response.json({ status: "saved" }, { headers });
      }
      const match = route.match(/^\/timings\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
      if (match && req.method === "PUT") {
        const date = match[1]!,
          prayer = PRAYERS.find(
            (p) => p.toLowerCase() === match[2]!.toLowerCase(),
          );
        if (!prayer || typeof data.play_adhan !== "boolean")
          throw new HttpError(400, "Invalid prayer or play_adhan");
        const calendar = await refresh(date.slice(0, 7));
        if (!calendar.days.some((day) => day.date === date))
          throw new HttpError(404, "Date not found");
        await transact((draft) => {
          draft.overrides[`${date}/${prayer}`] = data.play_adhan as boolean;
        });
        return Response.json({ status: "saved" }, { headers });
      }
      throw new HttpError(404, "Not found");
    } catch (e) {
      return Response.json(
        { error: message(e) },
        { status: e instanceof HttpError ? e.status : 503, headers },
      );
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    haltGeneration++;
    await player.halt();
    await queue;
    await Promise.allSettled([...inflight.values()]);
    await release();
  }
  return { handle, tick, maintain, close, snapshot, refresh };
}

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <meta name="theme-color" content="#2458ed" />
    <title>Prayer calendar</title>
    <style>
      :root {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        color: #152443;
        background: #f4f7ff;
        font-synthesis: none;
        color-scheme: light;
        --header-height: 118px;
        --dock-height: 160px;
      }
      * {
        box-sizing: border-box;
      }
      html {
        scroll-padding-top: calc(var(--header-height) + 12px);
        scroll-padding-bottom: calc(var(--dock-height) + 12px);
      }
      body {
        margin: 0;
        padding-bottom: calc(var(--dock-height) + 16px);
      }
      button,
      select,
      input {
        font: inherit;
      }
      button,
      select,
      summary {
        min-height: 44px;
        min-width: 44px;
        border: 1px solid #cdd8ee;
        border-radius: 8px;
        color: #23365e;
        background: white;
        padding: 9px 12px;
        cursor: pointer;
      }
      button:hover,
      summary:hover {
        background: #eef3ff;
      }
      button:focus-visible,
      select:focus-visible,
      input:focus-visible,
      summary:focus-visible {
        outline: 3px solid #2170fa;
        outline-offset: 2px;
      }
      button:disabled,
      .prayer[aria-disabled="true"] {
        opacity: 0.55;
        cursor: wait;
      }
      button,
      select,
      input,
      summary,
      .day {
        scroll-margin-top: 12px;
        scroll-margin-bottom: 12px;
      }
      .summary {
        position: sticky;
        top: 0;
        z-index: 10;
        background: #fff;
        border-bottom: 1px solid #dbe4f8;
        box-shadow: 0 3px 16px #203b7610;
      }
      .summary-inner,
      main,
      .dock-inner {
        max-width: 1080px;
        margin: auto;
      }
      .summary-inner {
        padding: 10px 14px;
        padding-left: max(14px, env(safe-area-inset-left));
        padding-right: max(14px, env(safe-area-inset-right));
      }
      .masthead,
      .upcoming,
      .next-detail,
      .navigation,
      .arrows,
      .actions,
      .volume,
      .play-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .masthead {
        justify-content: space-between;
        margin-bottom: 6px;
      }
      h1 {
        font-size: 1rem;
        margin: 0;
        letter-spacing: -0.02em;
      }

      .upcoming {
        flex-wrap: wrap;
        gap: 4px 8px;
      }
      .eyebrow {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #496486;
      }
      #next-prayer {
        font-size: 1.04rem;
        color: #194ce2;
        font-variant-numeric: tabular-nums;
      }
      .next-detail {
        gap: 3px 10px;
        flex-wrap: wrap;
        margin-top: 3px;
        font-size: 0.73rem;
        color: #506381;
      }
      #next-adhan:empty {
        display: none;
      }
      #next-adhan {
        font-size: .73rem;
        margin-top: 3px;
        color: #176e8a;
      }
      #location {
        font-size: 0.68rem;
        color: #667896;
        margin-top: 0;
      }
      main {
        padding: 12px 14px 0;
        padding-left: max(14px, env(safe-area-inset-left));
        padding-right: max(14px, env(safe-area-inset-right));
      }
      .navigation {
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
      }
      h2 {
        font-size: 1.1rem;
        letter-spacing: -0.02em;
        margin: 0;
      }
      .arrows {
        gap: 4px;
      }
      .arrows button {
        padding: 8px 11px;
      }
      .actions {
        gap: 6px;
        margin: 8px 0;
        flex-wrap: wrap;
      }
      .actions > button {
        flex: 1;
        font-size: 0.8rem;
      }
      .more {
        position: relative;
      }
      .more summary {
        display: flex;
        align-items: center;
        font-size: 0.8rem;
        list-style: none;
      }
      .more summary::-webkit-details-marker {
        display: none;
      }
      .more summary::after {
        content: "⌄";
        padding-left: 6px;
      }
      .more-menu {
        position: absolute;
        z-index: 11;
        right: 0;
        top: calc(100% + 5px);
        width: 220px;
        padding: 8px;
        background: white;
        border: 1px solid #dbe4f8;
        border-radius: 10px;
        box-shadow: 0 10px 30px #17376a20;
      }
      .more-menu button {
        display: block;
        width: 100%;
        text-align: left;
        margin-bottom: 5px;
      }
      .more-menu p {
        font-size: 0.75rem;
        color: #526785;
        margin: 8px 4px 3px;
        line-height: 1.4;
      }
      .calendar {
        display: grid;
        gap: 10px;
        grid-template-columns: 1fr;
        margin-top: 10px;
      }
      .day {
        min-width: 0;
        border: 1px solid #d4dff3;
        border-radius: 9px;
        background: white;
      }
      .day.today {
        border-color: #3472f4;
        box-shadow: 0 0 0 1px #3472f4;
      }
      .day h3 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 0;
        padding: 9px 12px;
        border-radius: 8px 8px 0 0;
        font-size: 0.8rem;
        color: #344d75;
        background: #eaf0ff;
      }
      .day h3 span {
        color: #2458ed;
        font-weight: 500;
        font-size: 0.73rem;
      }
      .prayer {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto 44px;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 44px;
        text-align: left;
        padding: 8px 12px;
        border: 0;
        border-top: 1px solid #edf1fa;
        border-radius: 0;
        font-size: 0.85rem;
        background: white;
      }
      .prayer:last-child {
        border-radius: 0 0 8px 8px;
      }
      .prayer .name {
        min-width: 0;
        font-weight: 550;
      }
      .prayer time {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .prayer.next-row {
        background: #edf8ff;
        box-shadow: inset 3px 0 #09a2d4;
      }
      .prayer[aria-pressed="false"] {
        color: #66758d;
        background: #f8faff;
      }
      .prayer:hover {
        background: #eaf2ff;
      }
      .switch {
        font-size: 0.72rem;
        text-align: center;
        padding: 3px 6px;
        border-radius: 5px;
        color: #174bd8;
        background: #eaf0ff;
        font-weight: 600;
      }
      .prayer[aria-pressed="false"] .switch {
        background: #e9edf5;
        color: #65728c;
      }
      .elapsed-mark {
        font-size: 0.65rem;
        font-weight: 400;
        color: #73819b;
        margin-left: 7px;
      }
      .cache {
        font-size: 0.72rem;
        line-height: 1.4;
        color: #687996;
        margin: 14px 0;
        overflow-wrap: anywhere;
      }
      .dock {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 20;
        background: #fff;
        border-top: 1px solid #d7e1f5;
        box-shadow: 0 -4px 24px #17376a12;
        padding: 6px 12px calc(7px + env(safe-area-inset-bottom));
        padding-left: max(12px, env(safe-area-inset-left));
        padding-right: max(12px, env(safe-area-inset-right));
      }
      .dock-inner {
        display: grid;
        gap: 3px;
      }
      .volume {
        gap: 6px;
      }
      .volume label {
        font-size: 0.75rem;
        color: #4e6286;
      }
      .volume button {
        padding: 6px;
        min-width: 44px;
        border-color: transparent;
      }
      .volume input {
        flex: 1;
        min-width: 30px;
        height: 44px;
        margin: 0;
        accent-color: #2458ed;
      }
      .volume output {
        font-size: 0.8rem;
        font-weight: 650;
        min-width: 25px;
      }
      .play-controls {
        gap: 7px;
      }
      .play-controls select {
        min-width: 0;
        width: 0;
        flex: 1;
      }
      .primary {
        background: #2458ed;
        border-color: #2458ed;
        color: white;
      }
      .primary:hover {
        background: #1544ca;
      }
      .halt {
        background: #fff0f1;
        border-color: #f5b8c2;
        color: #bb2345;
        min-width: 44px;
        font-weight: 600;
      }
      .halt:hover {
        background: #ffdae1;
      }
      .icon-button {
        width: 44px;
        height: 44px;
        padding: 10px;
        flex: 0 0 44px;
        display: grid;
        place-items: center;
      }
      .icon-button svg {
        width: 22px;
        height: 22px;
        fill: currentColor;
      }
      .pending {
        font-size: 0.7rem;
        color: #566b8e;
        margin: 0;
      }
      .pending:empty {
        display: none;
      }
      .error {
        font-size: 0.75rem;
        line-height: 1.35;
        color: #b12042;
        overflow-wrap: anywhere;
        max-height: 4em;
        overflow: auto;
      }
      .error:empty {
        display: none;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }
      @media (min-width: 620px) {
        .calendar {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .actions > button {
          flex: 0 1 auto;
        }
      }
      @media (min-width: 900px) {
        .summary-inner {
          padding: 12px 22px;
          padding-left: max(22px, env(safe-area-inset-left));
          padding-right: max(22px, env(safe-area-inset-right));
        }
        main {
          padding: 16px 22px 0;
          padding-left: max(22px, env(safe-area-inset-left));
          padding-right: max(22px, env(safe-area-inset-right));
        }
        .calendar {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .dock {
          padding: 8px 22px calc(8px + env(safe-area-inset-bottom));
          padding-left: max(22px, env(safe-area-inset-left));
          padding-right: max(22px, env(safe-area-inset-right));
        }
        .dock-inner {
          grid-template-columns: minmax(260px, 1fr) minmax(320px, 1fr);
          column-gap: 24px;
        }
        .pending,
        .error {
          grid-column: 1 / -1;
        }
      }
    </style>
  </head>
  <body>
    <header class="summary" id="summary">
      <div class="summary-inner">
        <div class="masthead">
          <h1>Prayer calendar</h1>
        </div>
        <div class="upcoming">
          <span class="eyebrow">Next prayer</span><strong id="next-prayer">Loading…</strong>
        </div>
        <div id="next-adhan" class="next-enabled"></div>
        <div class="next-detail"><span id="countdown"></span><span id="location"></span></div>
      </div>
    </header>
    <main>
      <nav class="navigation" aria-label="Calendar months">
        <h2 id="month-label">Calendar</h2>
        <div class="arrows">
          <button id="previous" aria-label="Previous month">←</button
          ><button id="today">Today</button><button id="next" aria-label="Next month">→</button>
        </div>
      </nav>
      <div class="actions">
        <button id="enable">Enable month</button><button id="disable">Disable month</button>
        <details class="more">
          <summary>More</summary>
          <div class="more-menu">
            <button id="refresh">Refresh times</button><button id="reset">Reset month</button>
            <p>Reset enables this month and refreshes its times. Elapsed prayers never replay.</p>
          </div>
        </details>
      </div>
      <section id="calendar" class="calendar" aria-label="Prayer times"></section>
      <p id="cache" class="cache"></p>
    </main>
    <footer class="dock" id="dock" aria-label="Speaker controls">
      <div class="dock-inner">
        <div class="volume">
          <label for="volume"
            ><span aria-hidden="true">Volume</span
            ><span class="sr-only">Speaker volume · linear gain</span></label
          >
          <button id="volume-down" aria-label="Decrease volume">−</button
          ><input id="volume" type="range" min="0" max="15" step="1" value="5" /><output
            id="volume-value"
            for="volume"
            >5×</output
          ><button id="volume-up" aria-label="Increase volume">+</button>
        </div>
        <div class="play-controls">
          <label for="prayer" class="sr-only">Recording to play on the host speaker</label>
          <select id="prayer">
            <option>Fajr</option>
            <option selected>Dhuhr</option>
            <option>Asr</option>
            <option>Maghrib</option>
            <option>Isha</option></select
          ><button
            class="primary icon-button"
            id="play"
            aria-label="Play adhan"
            title="Play adhan"
            disabled
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path id="play-glyph" d="M8 5v14l11-7z" />
            </svg></button
          ><button class="halt icon-button" id="halt" aria-label="Stop adhan" title="Stop adhan">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="1" />
            </svg>
          </button>
        </div>
        <span id="pending" class="pending" role="status"></span>
        <div id="error" class="error" role="alert"></div>
      </div>
    </footer>
    <script>
      const $ = (id) => document.getElementById(id);
      let state,
        month = "",
        renderedMonth = "",
        serverOffset = 0,
        lastLoaded = 0,
        busy = 0,
        sequence = 0,
        volumeEditing = false,
        actionError = "",
        connectionError = "",
        playPending = false;
      const text = (id, value) => {
        $(id).textContent = value;
      };
      const formatMonth = (value) =>
        new Intl.DateTimeFormat("en-NZ", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(value + "-01T12:00:00Z"));
      function shift(value, delta) {
        const [y, m] = value.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
      }
      function describe(p) {
        if (!p) return "No upcoming prayer available";
        return p.prayer + " · " + p.time + (p.date === state.today ? "" : " · " + p.date);
      }
      async function load() {
        const request = ++sequence;
        try {
          const response = await fetch("/state" + (month ? "?month=" + month : ""));
          const data = await response.json();
          if (!response.ok) throw Error(data.error);
          if (request !== sequence) return;
          state = data;
          month = data.month;
          serverOffset = data.serverTime - Date.now();
          lastLoaded = Date.now();
          connectionError = "";
          render();
        } catch (error) {
          connectionError = error.message;
          renderErrors();
        }
      }
      function render() {
        text("location", state.timezone);
        text("month-label", formatMonth(month));
        text("next-prayer", describe(state.nextPrayer));
        text(
          "next-adhan",
          state.nextPrayer && !state.nextPrayer.enabled
            ? "Next adhan: " + describe(state.nextAdhan)
            : "",
        );
        renderPlayback();
        if (!volumeEditing) {
          $("volume").value = state.volume;
          text("volume-value", state.volume + "×");
        }
        text(
          "cache",
          state.calendar
            ? "Times " +
                (state.calendar.cached ? "cached" : "fetched") +
                " " +
                new Date(state.calendar.fetchedAt).toLocaleString("en-NZ", {
                  timeZone: state.timezone,
                }) +
                " · " +
                state.timezone
            : "Calendar unavailable. Refresh to retry.",
        );
        renderErrors();
        if (renderedMonth !== month || $("calendar").childElementCount !== state.days.length) {
          $("calendar").replaceChildren();
          renderedMonth = month;
          for (const day of state.days) {
            const section = document.createElement("article");
            section.className = "day";
            section.id = "day-" + day.date;
            const heading = document.createElement("h3");
            heading.textContent = new Intl.DateTimeFormat("en-NZ", {
              weekday: "short",
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            }).format(new Date(day.date + "T12:00:00Z"));
            const tag = document.createElement("span");
            heading.append(tag);
            section.append(heading);
            for (const p of day.prayers) {
              const row = document.createElement("button");
              row.type = "button";
              row.className = "prayer";
              row.dataset.id = p.id;
              row.dataset.toggle = p.id;
              const name = document.createElement("span");
              name.className = "name";
              name.textContent = p.prayer;
              const elapsedMark = document.createElement("small");
              elapsedMark.className = "elapsed-mark";
              name.append(elapsedMark);
              const time = document.createElement("time");
              const indicator = document.createElement("span");
              indicator.className = "switch";
              indicator.setAttribute("aria-hidden", "true");
              row.append(name, time, indicator);
              section.append(row);
            }
            $("calendar").append(section);
          }
        }
        for (const day of state.days) {
          const section = $("day-" + day.date);
          section.classList.toggle("today", day.date === state.today);
          section.querySelector("h3 span").textContent = day.date === state.today ? "Today" : "";
          for (const p of day.prayers) {
            const row = section.querySelector('[data-id="' + p.id + '"]');
            const elapsed = Date.parse(p.iso) < state.serverTime;
            row.setAttribute(
              "aria-label",
              p.prayer +
                " on " +
                day.date +
                " at " +
                p.time +
                (elapsed ? ", elapsed" : ", upcoming"),
            );
            row.classList.toggle("elapsed", elapsed);
            row.querySelector(".elapsed-mark").textContent = elapsed ? "Elapsed" : "";
            row.classList.toggle("next-row", state.nextPrayer?.id === p.id);
            const time = row.querySelector("time");
            time.dateTime = p.iso;
            time.textContent = p.time;
            row.setAttribute("aria-pressed", String(p.enabled));
            row.querySelector(".switch").textContent = p.enabled ? "On" : "Off";
            row.title = elapsed
              ? "Elapsed occurrence. This switch will not replay it."
              : "Scheduled adhan";
          }
        }
        countdown();
      }
      function renderPlayback() {
        const playback = state?.playback;
        const playing = playback?.state === "playing",
          paused = playback?.state === "paused";
        const transitioning = ["starting", "stopping"].includes(playback?.state);
        const label = playing ? "Pause adhan" : paused ? "Resume adhan" : "Play adhan";
        $("play").setAttribute("aria-label", label);
        $("play").title = label + " · " + (playback?.prayer || $("prayer").value);
        $("play-glyph").setAttribute("d", playing ? "M7 5h4v14H7zM14 5h4v14h-4z" : "M8 5v14l11-7z");
        $("play").disabled = !state || playPending || transitioning;
        $("prayer").disabled = playing || paused || transitioning || playPending;
        if ((playing || paused) && playback.prayer) $("prayer").value = playback.prayer;
      }
      function renderErrors() {
        const readinessError =
          state?.automatic.enabled && !state.automatic.ready ? state.automatic.reason : "";
        text(
          "error",
          [
            ...new Set(
              [
                actionError,
                connectionError,
                state?.playback.error,
                readinessError,
                ...(state?.errors || []),
              ].filter(Boolean),
            ),
          ].join(" · "),
        );
      }
      function countdown() {
        if (!state) return;
        const delta = state.nextPrayer
          ? Math.max(
              0,
              Math.ceil((Date.parse(state.nextPrayer.iso) - (Date.now() + serverOffset)) / 1000),
            )
          : 0;
        text(
          "countdown",
          state.nextPrayer
            ? "In " +
                Math.floor(delta / 3600) +
                "h " +
                Math.floor((delta % 3600) / 60) +
                "m"
            : "",
        );
        if (Date.now() - lastLoaded > 20000) {
          connectionError = "Connection stale. Reconnecting…";
          renderErrors();
        }
      }
      async function action(path, data = {}, method = "POST", button) {
        const prayerRow = button?.classList.contains("prayer");
        if (prayerRow && button.getAttribute("aria-disabled") === "true") return;
        busy++;
        if (button?.id === "play") {
          playPending = true;
          renderPlayback();
        }
        if (prayerRow) button.setAttribute("aria-disabled", "true");
        else if (button && button.id !== "halt") button.disabled = true;
        text(
          "pending",
          path === "/play"
            ? "Starting…"
            : path === "/halt"
              ? "Stopping…"
              : path === "/pause"
                ? data.paused
                  ? "Pausing…"
                  : "Resuming…"
                : "Saving…",
        );
        actionError = "";
        text("error", "");
        try {
          const response = await fetch(path, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          const result = await response.json();
          if (!response.ok) throw Error(result.error);
          await load();
        } catch (error) {
          actionError = error.message;
          text("error", actionError);
        } finally {
          busy--;
          if (prayerRow) button.removeAttribute("aria-disabled");
          else if (button) button.disabled = false;
          if (button?.id === "play") playPending = false;
          renderPlayback();
          text("pending", busy ? "Working…" : "");
        }
      }
      $("previous").onclick = () => {
        month = shift(month, -1);
        load();
      };
      $("next").onclick = () => {
        month = shift(month, 1);
        load();
      };
      $("today").onclick = async () => {
        month = state.today.slice(0, 7);
        await load();
        $("day-" + state.today)?.scrollIntoView({ block: "start", behavior: "smooth" });
      };
      $("enable").onclick = (e) =>
        action("/timings", { month, play_adhan: true }, "POST", e.currentTarget);
      $("disable").onclick = (e) =>
        action("/timings", { month, play_adhan: false }, "POST", e.currentTarget);
      $("refresh").onclick = (e) => action("/refresh", { month }, "POST", e.currentTarget);
      $("reset").onclick = (e) => {
        if (confirm("Enable every adhan in " + formatMonth(month) + " and refresh its times?"))
          action("/reset", { month }, "POST", e.currentTarget);
      };
      $("play").onclick = (e) => {
        if (!state || playPending) return;
        const current = state.playback.state;
        if (current === "playing" || current === "paused")
          action("/pause", { paused: current === "playing" }, "POST", e.currentTarget);
        else if (!["starting", "stopping"].includes(current))
          action("/play", { prayer: $("prayer").value }, "POST", e.currentTarget);
      };
      $("prayer").onchange = renderPlayback;
      $("halt").onclick = (e) => action("/halt", {}, "POST", e.currentTarget);
      $("volume-down").onclick = (e) => action("/volume-down", {}, "POST", e.currentTarget);
      $("volume-up").onclick = (e) => action("/volume-up", {}, "POST", e.currentTarget);
      $("volume").oninput = () => {
        volumeEditing = true;
        text("volume-value", $("volume").value + "×");
      };
      $("volume").onchange = async () => {
        await action("/volume", { volume: Number($("volume").value) });
        volumeEditing = false;
        if (state) {
          $("volume").value = state.volume;
          text("volume-value", state.volume + "×");
        }
      };
      $("calendar").onclick = (e) => {
        const button = e.target.closest("button");
        if (!button || button.getAttribute("aria-disabled") === "true") return;
        if (button.dataset.toggle) {
          const [date, prayer] = button.dataset.toggle.split("/");
          action(
            "/timings/" + date + "/" + prayer,
            { play_adhan: button.getAttribute("aria-pressed") !== "true" },
            "PUT",
            button,
          );
        }
      };
      function measureDocks() {
        document.documentElement.style.setProperty(
          "--header-height",
          $("summary").getBoundingClientRect().height + "px",
        );
        document.documentElement.style.setProperty(
          "--dock-height",
          $("dock").getBoundingClientRect().height + "px",
        );
      }
      const dockObserver = new ResizeObserver(measureDocks);
      dockObserver.observe($("summary"));
      dockObserver.observe($("dock"));
      measureDocks();
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) load();
      });
      setInterval(() => {
        if (!document.hidden && !busy) load();
      }, 5000);
      setInterval(countdown, 1000);
      load();
    </script>
  </body>
</html>`;

if (import.meta.main) {
  if (!Bun.semver.satisfies(Bun.version, ">=1.4.0 <1.5.0"))
    throw new Error("Use Bun 1.4.x");
  const config = readConfig(),
    app = await createApp(config);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 4096,
    fetch: app.handle,
  });
  const tick = setInterval(() => {
    void app.tick().catch((e) => console.error("Scheduler:", message(e)));
  }, 1000);
  const maintenance = setInterval(() => {
    void app.maintain().catch((e) => console.error("Calendar:", message(e)));
  }, 30000);
  void app.maintain();
  console.log(
    `Prayer alarm: http://${config.host}:${config.port} · ${config.autoPlay ? "automatic playback enabled" : "automatic playback PAUSED"} · ${config.dataDir}`,
  );
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    clearInterval(tick);
    clearInterval(maintenance);
    server.stop(true);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
