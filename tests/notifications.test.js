const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function createWorker({ paused = false, enabled = true, weatherEnabled = false } = {}) {
  let now = 100000;
  let permission = "granted";
  let createError = null;
  let weatherPermission = true;
  let weatherError = false;
  let weatherAge = 0;
  let current = {
    is_day: 1, weather_code: 1, apparent_temperature: 20, precipitation: 0,
    wind_speed_10m: 10, wind_gusts_10m: 15
  };
  const weatherRequests = [];
  const listeners = {};
  const notifications = [];
  const alarms = new Map();
  const stored = {
    settings: { workMinutes: 1, notificationsEnabled: enabled, weatherEnabled, weatherCity: "Chicago" },
    state: {
      accumulatedMs: 59000, lastActiveStart: now, hasOpenWindow: true,
      idleState: "active", isPaused: paused
    }
  };
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  class Clock extends Date { static now() { return now; } }
  const chrome = {
    runtime: {
      onInstalled: event("installed"), onStartup: event("startup"),
      onMessage: event("message")
    },
    windows: {
      onCreated: event("created"), onRemoved: event("removed"),
      async getAll() { return [{ focused: false }]; }
    },
    idle: {
      onStateChanged: event("idle"), setDetectionInterval() {},
      async queryState() { return "active"; }
    },
    alarms: {
      onAlarm: event("alarm"),
      async get(name) { return alarms.get(name); },
      async create(name, options) { alarms.set(name, options); },
      async clear(name) { alarms.delete(name); }
    },
    notifications: {
      async getPermissionLevel() { return permission; },
      async clear() {},
      async create(id, options) {
        if (createError) throw new Error(createError);
        notifications.push({ id, ...options });
        return id;
      }
    },
    permissions: { async contains() { return weatherPermission; } },
    storage: { local: {
      async get() { return structuredClone(stored); },
      async set(data) { Object.assign(stored, structuredClone(data)); }
    } }
  };
  async function fetch(url) {
    weatherRequests.push(String(url));
    if (weatherError) throw new Error("Weather is offline.");
    const data = url.hostname === "geocoding-api.open-meteo.com"
      ? { results: [{ name: "Chicago", admin1: "Illinois", country: "United States",
        latitude: 41.85, longitude: -87.65 }] }
      : { current: { ...current, time: now / 1000 - weatherAge } };
    return { ok: true, async json() { return data; } };
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"),
    vm.createContext({ chrome, Date: Clock, console, fetch, URL, URLSearchParams, AbortSignal }));
  return {
    stored, alarms, notifications, listeners, weatherRequests,
    advance(ms) { now += ms; },
    deny() { permission = "denied"; },
    fail(message) { createError = message; },
    recover() { permission = "granted"; createError = null; },
    weather(values, age = 0) { current = { ...current, ...values }; weatherAge = age; },
    weatherOffline() { weatherError = true; },
    denyWeather() { weatherPermission = false; },
    message(data) {
      return new Promise((resolve) => listeners.message(data, {}, resolve));
    }
  };
}

test("popup sends reminder at deadline and does not duplicate it", async () => {
  const worker = createWorker();
  worker.advance(1000);
  const response = await worker.message({ type: "getData" });
  assert.equal(response.ok, true);
  assert.equal(worker.notifications.length, 1);
  assert.equal(worker.notifications[0].iconUrl, "icon.png");
  assert.equal(response.state.accumulatedMs, 0);
  await worker.message({ type: "getData" });
  await worker.listeners.alarm({ name: "takeBreakTick" });
  assert.equal(worker.notifications.length, 1);
  assert.equal(worker.alarms.get("takeBreakTick").periodInMinutes, 0.5);
});

test("reminder wording rotates and test notifications do not advance the rotation", async () => {
  const worker = createWorker();
  worker.advance(1000);
  await worker.message({ type: "getData" });
  const first = worker.notifications[0].message;
  assert.match(first, /1 minute\./);
  worker.advance(60000);
  await worker.message({ type: "getData" });
  assert.notEqual(first, worker.notifications[1].message);
  assert.equal(worker.stored.state.reminderIndex, 2);
  await worker.message({ type: "testNotification" });
  assert.equal(worker.stored.state.reminderIndex, 2);
});

test("daylight and pleasant Chicago weather produce a walk suggestion", async () => {
  const worker = createWorker({ weatherEnabled: true });
  worker.advance(1000);
  const response = await worker.message({ type: "getData" });
  assert.match(worker.notifications[0].message, /daylight.*Chicago.*walk/);
  assert.match(response.weatherStatus, /Chicago, Illinois, United States/);
  assert.equal(worker.weatherRequests.length, 2);
  await worker.message({ type: "testNotification" });
  assert.equal(worker.weatherRequests.length, 2, "recent weather is reused");
  worker.advance(11 * 60000);
  await worker.message({ type: "testNotification" });
  assert.equal(worker.weatherRequests.length, 3, "refresh weather without another geocoding lookup");
});

test("night, rain, extreme temperatures, gusts, and missing data avoid outdoor suggestions", async () => {
  for (const current of [
    { is_day: 0 }, { precipitation: 0.1 }, { weather_code: 95 },
    { apparent_temperature: 5 }, { apparent_temperature: 32 },
    { wind_speed_10m: 30 }, { wind_gusts_10m: 40 },
    { apparent_temperature: null }, { precipitation: undefined }
  ]) {
    const worker = createWorker({ weatherEnabled: true });
    worker.weather(current);
    await worker.message({ type: "testNotification" });
    assert.doesNotMatch(worker.notifications[0].message, /walk|fresh air|weather looks/);
  }
});

test("weather failure or missing permission never prevents the break reminder", async () => {
  for (const mode of ["offline", "denied", "disabled"]) {
    const worker = createWorker({ weatherEnabled: mode !== "disabled" });
    if (mode === "offline") worker.weatherOffline();
    if (mode === "denied") worker.denyWeather();
    worker.advance(1000);
    const response = await worker.message({ type: "getData" });
    assert.equal(response.ok, true);
    assert.equal(worker.notifications.length, 1);
    assert.equal(worker.stored.state.accumulatedMs, 0);
    assert.doesNotMatch(worker.notifications[0].message, /walk|fresh air/);
    if (mode === "offline") {
      assert.match(response.weatherStatus, /indoor/);
      await worker.message({ type: "testNotification" });
      assert.equal(worker.weatherRequests.length, 1, "failed requests are not repeated immediately");
    } else {
      assert.equal(worker.weatherRequests.length, 0);
    }
  }
});

test("stale weather falls back to an indoor break", async () => {
  const worker = createWorker({ weatherEnabled: true });
  worker.weather({}, 3600);
  const response = await worker.message({ type: "testNotification" });
  assert.equal(response.ok, true);
  assert.doesNotMatch(worker.notifications[0].message, /walk|fresh air/);
  assert.match(worker.stored.weatherCache.status, /unavailable/);
});

test("permission and creation failures stay visible without resetting time", async () => {
  const worker = createWorker();
  worker.advance(1000);
  worker.deny();
  let response = await worker.message({ type: "getData" });
  assert.match(response.state.notificationError, /blocked/);
  assert.equal(response.state.accumulatedMs, 60000);
  assert.equal(worker.notifications.length, 0);
  worker.recover();
  worker.fail("Unable to download all specified images.");
  response = await worker.message({ type: "getData" });
  assert.match(response.state.notificationError, /images/);
  assert.equal(response.state.accumulatedMs, 60000);
  worker.recover();
  response = await worker.message({ type: "getData" });
  assert.equal(response.state.notificationError, null);
  assert.equal(response.state.accumulatedMs, 0);
  assert.equal(worker.notifications.length, 1);
});

test("test notification preserves time and pause with automatic reminders disabled", async () => {
  const worker = createWorker({ paused: true, enabled: false });
  const before = structuredClone(worker.stored.state);
  const response = await worker.message({ type: "testNotification" });
  assert.equal(response.ok, true);
  assert.equal(worker.stored.state.accumulatedMs, before.accumulatedMs);
  assert.equal(worker.stored.state.isPaused, true);
  assert.equal(worker.notifications.length, 1);
  assert.match(worker.notifications[0].title, /test notification/);
  worker.deny();
  const failed = await worker.message({ type: "testNotification" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /blocked/);
  assert.match(worker.stored.state.notificationError, /blocked/);
});

test("pause and disabled notifications prevent automatic reminders", async () => {
  for (const options of [{ paused: true }, { enabled: false }]) {
    const worker = createWorker(options);
    worker.advance(60000);
    await worker.message({ type: "getData" });
    assert.equal(worker.notifications.length, 0);
  }
});

test("notification asset is a 128px PNG and is registered in the manifest", () => {
  const png = fs.readFileSync(path.join(__dirname, "../icon.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 128);
  assert.equal(png.readUInt32BE(20), 128);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json")));
  assert.equal(manifest.icons["128"], "icon.png");
  assert.ok(manifest.permissions.includes("notifications"));
});
