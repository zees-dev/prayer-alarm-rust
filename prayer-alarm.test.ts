import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const bunExecutable = Bun.which("bun") || process.execPath;
import {
  readConfig,
  monthShift,
  calendarURL,
  normalizeCalendar,
  createApp,
  type Player,
} from "./prayer-alarm";

const config = readConfig({ AUTO_PLAY: "1", TZ: "Pacific/Auckland" });
function fixture(month: string) {
  const [year, m] = month.split("-").map(Number);
  return {
    code: 200,
    data: Array.from(
      { length: new Date(Date.UTC(year!, m!, 0)).getUTCDate() },
      (_, i) => {
        const day = String(i + 1).padStart(2, "0"),
          date = `${month}-${day}`;
        const offset =
          Number(month.slice(5)) <= 3 ||
          Number(month.slice(5)) >= 10 ||
          (month === "2026-09" && i >= 26) ||
          (month === "2026-04" && i < 4)
            ? "+13:00"
            : "+12:00";
        return {
          date: {
            gregorian: { date: `${day}-${String(m).padStart(2, "0")}-${year}` },
          },
          meta: { timezone: config.timezone, method: { id: 3 } },
          timings: Object.fromEntries(
            ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].map((p, j) => [
              p,
              `${date}T${["05:00", "12:00", "15:00", "18:00", "20:00"][j]}:00${offset}`,
            ]),
          ),
        };
      },
    ),
  };
}
function fakePlayer(): Player & { plays: string[] } {
  return {
    plays: [],
    status: { state: "idle" },
    async play(p) {
      this.plays.push(p);
    },
    async halt() {},
    async pause(paused) {
      this.status.state = paused ? "paused" : "playing";
    },
    async volume() {},
  };
}
async function setup(now = Date.parse("2026-09-12T16:59:59Z")) {
  const dir = await mkdtemp(join(tmpdir(), "prayer-test-"));
  const player = fakePlayer();
  let time = now;
  const c = { ...config, dataDir: dir };
  const options = {
    now: () => time,
    clockReady: async () => true,
    player,
    fetch: async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const parts = u.pathname.split("/");
      return Response.json(
        fixture(`${parts.at(-2)}-${parts.at(-1)!.padStart(2, "0")}`),
      );
    },
  };
  const app = await createApp(c, options);
  await app.maintain();
  const request = (path: string, body = {}, method = "POST") =>
    app.handle(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return {
    app,
    player,
    request,
    c,
    options,
    time: (t: number) => {
      time = t;
    },
    async cleanup() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("month rollover, leap month, signed nine-field tune and both DST transitions", () => {
  expect(monthShift("2026-12", 1)).toBe("2027-01");
  expect(
    normalizeCalendar(fixture("2028-02"), "2028-02", config).days,
  ).toHaveLength(29);
  expect(
    new URL(
      calendarURL(readConfig({ OFFSETS: "-2,3,-4,5,-6" }), "2026-09"),
    ).searchParams.get("tune"),
  ).toBe("0,-2,0,3,-4,5,0,-6,0");
  for (const [m, a, b] of [
    ["2026-09", 25, 26],
    ["2026-04", 3, 4],
  ] as const) {
    const days = normalizeCalendar(fixture(m), m, config).days;
    expect(
      Date.parse(days[b]!.prayers[0]!.iso) -
        Date.parse(days[a]!.prayers[0]!.iso),
    ).toBe(m.endsWith("09") ? 23 * 3600000 : 25 * 3600000);
  }
});
test("rejects incomplete, duplicate, wrong timezone and invalid ISO calendars", () => {
  const raw = fixture("2026-09");
  raw.data.pop();
  expect(() => normalizeCalendar(raw, "2026-09", config)).toThrow();
  const dup = fixture("2026-09");
  dup.data[1] = dup.data[0]!;
  expect(() => normalizeCalendar(dup, "2026-09", config)).toThrow();
  const bad = fixture("2026-09");
  bad.data[0]!.meta.timezone = "UTC";
  expect(() => normalizeCalendar(bad, "2026-09", config)).toThrow();
});
test("latest disabled setting consumes due event; reset and restart never replay", async () => {
  const s = await setup();
  try {
    expect(
      (
        await s.request(
          "/timings/2026-09-13/Fajr",
          { play_adhan: false },
          "PUT",
        )
      ).status,
    ).toBe(200);
    s.time(Date.parse("2026-09-12T17:00:01Z"));
    await s.app.tick();
    expect(s.player.plays).toEqual([]);
    await s.request("/reset", { month: "2026-09" });
    await s.app.tick();
    expect(s.player.plays).toEqual([]);
    await s.app.close();
    const restarted = await createApp(s.c, s.options);
    await restarted.tick();
    await restarted.close();
    expect(s.player.plays).toEqual([]);
  } finally {
    await s.cleanup();
  }
});
test("enabled event fires once and concurrent settings persist without lost updates", async () => {
  const s = await setup();
  try {
    await Promise.all([
      s.request("/volume", { volume: 2 }),
      s.request("/timings/2026-09-14/Isha", { play_adhan: false }, "PUT"),
    ]);
    s.time(Date.parse("2026-09-12T17:00:01Z"));
    await Promise.all([s.app.tick(), s.app.tick()]);
    expect(s.player.plays).toEqual(["Fajr"]);
    expect(s.app.snapshot().volume).toBe(2);
    expect(
      s.app.snapshot().days.find((d) => d.date === "2026-09-14")!.prayers[4]!
        .enabled,
    ).toBe(false);
  } finally {
    await s.cleanup();
  }
});
test("request boundary rejects CSRF, bad host, invalid volume and oversized JSON", async () => {
  const s = await setup();
  try {
    expect((await s.request("/volume", { volume: 16 })).status).toBe(400);
    expect(
      (await s.app.handle(new Request("http://evil.example:3000/state")))
        .status,
    ).toBe(403);
    expect(
      (
        await s.app.handle(
          new Request("http://localhost:3000/halt", {
            method: "POST",
            headers: {
              origin: "http://evil.example",
              "content-type": "application/json",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await s.request("/volume", { padding: "x".repeat(5000) })).status,
    ).toBe(413);
  } finally {
    await s.cleanup();
  }
});

test("embedded page serves readable Unicode and has no external scripts", async () => {
  const s = await setup();
  try {
    const response = await s.app.handle(new Request("http://localhost:3000/"));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("←");
    expect(html).toContain("Speaker volume · linear gain");
    expect(html).not.toContain("\\u2190");
    expect(html).not.toMatch(/<script[^>]+src=/);
  } finally {
    await s.cleanup();
  }
});
test("cached schedule survives fetch failure, corrupt state and duplicate ownership fail closed", async () => {
  const s = await setup();
  try {
    await expect(createApp(s.c, s.options)).rejects.toThrow();
    await s.app.close();
    const app = await createApp(s.c, {
      ...s.options,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    await expect(app.refresh("2026-09", true)).rejects.toThrow("offline");
    await app.maintain();
    expect(app.snapshot().days).toHaveLength(30);
    await app.close();
    await Bun.write(join(s.c.dataDir, "state.json"), "{broken");
    await expect(createApp(s.c, s.options)).rejects.toThrow();
    expect(await Bun.file(join(s.c.dataDir, "state.json")).text()).toBe(
      "{broken",
    );
  } finally {
    await s.cleanup();
  }
});

test("long forward and backward clock changes never catch up or replay", async () => {
  const s = await setup();
  try {
    s.time(Date.parse("2026-09-12T17:02:00Z"));
    await s.app.tick();
    expect(s.player.plays).toEqual([]);
    s.time(Date.parse("2026-09-12T16:59:59Z"));
    await s.app.tick();
    s.time(Date.parse("2026-09-12T17:00:01Z"));
    await s.app.tick();
    expect(s.player.plays).toEqual([]);
  } finally {
    await s.cleanup();
  }
});

test("player cancels startup, excludes overlapping manual play, selects Fajr and survives halt", async () => {
  const { createPlayer } = await import("./prayer-alarm");
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "prayer-player-")),
    script = join(dir, "fake-mpg123");
  await Bun.write(
    script,
    `#!${bunExecutable}\nsetTimeout(()=>console.log('@R MPG123'),100);let b='';for await(const chunk of Bun.stdin.stream()){b+=new TextDecoder().decode(chunk);let i;while((i=b.indexOf('\\n'))>=0){let l=b.slice(0,i);b=b.slice(i+1);if(l==='RVA off')console.log('@RVA off');if(l.startsWith('VOLUME '))console.log('@V '+l.slice(7));if(l.startsWith('LOAD ')){console.log('@I {');console.log('@P 0');console.log('@I }');console.log('@P 2')}if(l==='STOP')console.log('@P 0');if(l==='QUIT')process.exit(0)}}`,
  );
  await chmod(script, 0o700);
  const p = createPlayer({
    ...config,
    mpg123: script,
    audioDriver: "dummy",
    audioDevice: "",
  });
  try {
    const starting = p.play("Fajr", 1, "manual");
    await Bun.sleep(20);
    await p.halt();
    await starting;
    expect(p.status.state).toBe("idle");
    await p.play("Fajr", 1, "manual");
    expect(p.status.prayer).toBe("Fajr");
    expect(p.status.state).toBe("playing");
    await expect(p.play("Dhuhr", 1, "manual")).rejects.toThrow("busy");
    await p.volume(2);
    await p.halt();
    expect(p.status.state).toBe("idle");
    await p.play("Dhuhr", 1, "manual");
    await p.play("Asr", 1, "automatic");
    expect(p.status.prayer).toBe("Asr");
    const automatic = p.play("Isha", 1, "automatic");
    const halted = p.halt();
    await Promise.all([automatic, halted]);
    expect(p.status.state).toBe("idle");
  } finally {
    await p.halt();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed durable save keeps settings unchanged, prevents audio and leaves Halt usable", async () => {
  const { mkdir } = await import("node:fs/promises");
  const s = await setup();
  try {
    const path = join(s.c.dataDir, "state.json");
    await rm(path);
    await mkdir(path);
    expect((await s.request("/volume", { volume: 9 })).status).toBe(503);
    expect(s.app.snapshot().volume).toBe(5);
    s.time(Date.parse("2026-09-12T17:00:01Z"));
    await expect(s.app.tick()).rejects.toThrow();
    expect(s.player.plays).toEqual([]);
    expect((await s.request("/halt")).status).toBe(200);
  } finally {
    await s.cleanup();
  }
});

test("legacy empty play and halt work, but nonempty non-JSON bodies do not", async () => {
  const s = await setup();
  try {
    for (const path of ["/play", "/halt", "/volume-up", "/volume-down"])
      expect(
        (
          await s.app.handle(
            new Request("http://localhost:3000" + path, { method: "POST" }),
          )
        ).status,
      ).toBe(200);
    expect(s.player.plays).toEqual(["Dhuhr"]);
    for (const contentType of ["text/plain", "application/jsonx"])
      expect(
        (
          await s.app.handle(
            new Request("http://localhost:3000/play", {
              method: "POST",
              headers: { "content-type": contentType },
              body: "{}",
            }),
          )
        ).status,
      ).toBe(415);
  } finally {
    await s.cleanup();
  }
});

test("maintenance retries a failed cached refresh after backoff and clears error", async () => {
  const s = await setup();
  try {
    await s.app.close();
    let offline = true,
      calls = 0;
    const app = await createApp(s.c, {
      ...s.options,
      fetch: async (input) => {
        calls++;
        if (offline) throw Error("offline");
        return s.options.fetch(input);
      },
    });
    try {
      await expect(app.refresh("2026-09", true)).rejects.toThrow("offline");
      expect(app.snapshot().calendar?.cached).toBe(true);
      await app.maintain();
      expect(calls).toBe(1);
      offline = false;
      s.time(Date.parse("2026-09-12T17:10:00Z"));
      await app.maintain();
      expect(calls).toBe(2);
      expect(app.snapshot().errors).toEqual([]);
      expect(app.snapshot().calendar?.cached).toBe(false);
    } finally {
      await app.close();
    }
  } finally {
    await s.cleanup();
  }
});

test("a volume change after LOAD but before playing acknowledgement reaches the player", async () => {
  const { createPlayer } = await import("./prayer-alarm");
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "prayer-volume-")),
    script = join(dir, "fake"),
    log = join(dir, "commands");
  await Bun.write(
    script,
    `#!${bunExecutable}\nconsole.log('@R MPG123');let b='';for await(const chunk of Bun.stdin.stream()){b+=new TextDecoder().decode(chunk);let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);await Bun.write(${JSON.stringify(log)},(await Bun.file(${JSON.stringify(log)}).exists()?await Bun.file(${JSON.stringify(log)}).text():'')+l+'\\n');if(l==='RVA off')console.log('@RVA off');if(l.startsWith('VOLUME '))console.log('@V '+l.slice(7));if(l.startsWith('LOAD '))setTimeout(()=>console.log('@P 2'),200);if(l==='STOP')console.log('@P 0');if(l==='QUIT')process.exit(0)}}`,
  );
  await chmod(script, 0o700);
  const p = createPlayer({ ...config, mpg123: script, audioDevice: "" });
  try {
    const start = p.play("Fajr", 5, "manual");
    for (let i = 0; i < 100; i++) {
      if (
        (await Bun.file(log).exists()) &&
        (await Bun.file(log).text()).includes("LOAD ")
      )
        break;
      await Bun.sleep(10);
    }
    await p.volume(2);
    await start;
    expect(await Bun.file(log).text()).toContain("VOLUME 200");
    expect(p.status.state).toBe("playing");
  } finally {
    await p.halt();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cached switches and bulk updates work offline after retry becomes due", async () => {
  const s = await setup();
  try {
    await s.app.close();
    let calls = 0;
    const app = await createApp(s.c, {
      ...s.options,
      fetch: async () => {
        calls++;
        throw Error("offline");
      },
    });
    try {
      await expect(app.refresh("2026-09", true)).rejects.toThrow("offline");
      s.time(Date.parse("2026-09-12T17:10:00Z"));
      const request = (path: string, body: unknown, method = "POST") =>
        app.handle(
          new Request("http://localhost:3000" + path, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      expect(
        (
          await request(
            "/timings/2026-09-14/Fajr",
            { play_adhan: false },
            "PUT",
          )
        ).status,
      ).toBe(200);
      expect(
        (await request("/timings", { month: "2026-09", play_adhan: false }))
          .status,
      ).toBe(200);
      expect(calls).toBe(1);
      expect(
        app
          .snapshot()
          .days.every((day) => day.prayers.every((p) => !p.enabled)),
      ).toBe(true);
      await app.maintain();
      expect(calls).toBe(2);
      await app.maintain();
      expect(calls).toBe(2);
    } finally {
      await app.close();
    }
  } finally {
    await s.cleanup();
  }
});

test("pause endpoint requires an explicit boolean target", async () => {
  const s = await setup();
  try {
    for (const body of [{}, { paused: "yes" }, { paused: 1 }])
      expect((await s.request("/pause", body)).status).toBe(400);
    const paused = await s.request("/pause", { paused: true });
    expect(paused.status).toBe(200);
    expect((await paused.json()).playback.state).toBe("paused");
    expect((await s.request("/pause", { paused: false })).status).toBe(200);
  } finally {
    await s.cleanup();
  }
});

test("pause resumes the same recording, is idempotent, and cannot undo Halt", async () => {
  const { createPlayer } = await import("./prayer-alarm");
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "prayer-pause-"));
  const script = join(dir, "fake-player"),
    log = join(dir, "commands");
  await Bun.write(
    script,
    `#!${bunExecutable}
console.log('@R MPG123');let b='',paused=false;
for await(const chunk of Bun.stdin.stream()) {
  b+=new TextDecoder().decode(chunk);let i;
  while((i=b.indexOf('\\n'))>=0) {
    const line=b.slice(0,i);b=b.slice(i+1);
    const log=${JSON.stringify(log)};
    await Bun.write(log,(await Bun.file(log).exists()?await Bun.file(log).text():'')+line+'\\n');
    if(line==='RVA off')console.log('@RVA off');
    if(line.startsWith('VOLUME '))console.log('@V '+line.slice(7));
    if(line.startsWith('LOAD ')){paused=false;console.log('@P 2');}
    if(line==='PAUSE'){paused=!paused;const response=paused?'@P 1':'@P 2';setTimeout(()=>console.log(response),100);}
    if(line==='STOP'){console.log('@P 0');console.log('@P 1');}
    if(line==='QUIT')process.exit(0);
  }
}`,
  );
  await chmod(script, 0o700);
  const player = createPlayer({ ...config, mpg123: script, audioDevice: "" });
  const commands = async () => (await Bun.file(log).text()).trim().split("\n");
  try {
    await expect(player.pause(true)).rejects.toThrow("No active recording");
    await player.play("Fajr", 1, "manual");
    await Promise.all([player.pause(true), player.pause(true)]);
    expect(player.status).toMatchObject({
      state: "paused",
      prayer: "Fajr",
      source: "manual",
    });
    expect((await commands()).filter((line) => line === "PAUSE")).toHaveLength(
      1,
    );
    await expect(player.play("Isha", 1, "manual")).rejects.toThrow("busy");
    await player.volume(3);
    expect(await commands()).toContain("VOLUME 300");
    await Promise.all([player.pause(false), player.pause(false)]);
    expect(player.status.state).toBe("playing");
    expect(
      (await commands()).filter((line) => line.startsWith("LOAD ")),
    ).toHaveLength(1);
    expect((await commands()).filter((line) => line === "PAUSE")).toHaveLength(
      2,
    );
    const pending = player.pause(true);
    for (let i = 0; i < 100; i++) {
      if ((await commands()).filter((line) => line === "PAUSE").length === 3)
        break;
      await Bun.sleep(5);
    }
    await player.halt();
    await pending;
    expect(player.status.state).toBe("idle");
    await player.play("Fajr", 1, "manual");
    await player.pause(true);
    await player.play("Dhuhr", 1, "automatic");
    expect(player.status).toMatchObject({
      state: "playing",
      prayer: "Dhuhr",
      source: "automatic",
    });
    await player.pause(true);
    await player.halt();
    await player.play("Asr", 1, "manual");
    expect(player.status.prayer).toBe("Asr");
  } finally {
    await player.halt();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pause failure keeps its useful error after the owned child exits", async () => {
  const { createPlayer } = await import("./prayer-alarm");
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "prayer-pause-error-"));
  const script = join(dir, "fake-player");
  await Bun.write(
    script,
    `#!${bunExecutable}
console.log('@R MPG123');let buffer='';
for await(const chunk of Bun.stdin.stream()) {
  buffer+=new TextDecoder().decode(chunk);let end;
  while((end=buffer.indexOf('\\n'))>=0) {
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    if(line==='RVA off')console.log('@RVA off');
    if(line.startsWith('VOLUME '))console.log('@V '+line.slice(7));
    if(line.startsWith('LOAD '))console.log('@P 2');
    if(line==='PAUSE')console.log('@E Cannot pause audio device');
    if(line==='STOP')console.log('@P 0');
    if(line==='QUIT')process.exit(0);
  }
}`,
  );
  await chmod(script, 0o700);
  const player = createPlayer({ ...config, mpg123: script, audioDevice: "" });
  try {
    await player.play("Fajr", 1, "manual");
    await expect(player.pause(true)).rejects.toThrow(
      "Cannot pause audio device",
    );
    await Bun.sleep(100);
    expect(player.status).toEqual({
      state: "error",
      error: "Cannot pause audio device",
    });
    await player.play("Dhuhr", 1, "manual");
    expect(player.status.state).toBe("playing");
  } finally {
    await player.halt();
    await rm(dir, { recursive: true, force: true });
  }
});
