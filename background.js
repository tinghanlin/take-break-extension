const DEFAULT_SETTINGS = {
  workMinutes: 50,
  notificationsEnabled: true,
  weatherEnabled: true,
  weatherCity: "Chicago"
};

const DEFAULT_STATE = {
  accumulatedMs: 0,
  lastActiveStart: null,
  hasOpenWindow: false,
  idleState: "active",
  isPaused: false,
  notificationError: null,
  reminderIndex: 0,
  lastReminderAt: null
};

const TICK_ALARM = "takeBreakTick";
const IDLE_RESET_SECONDS = 10 * 60;
const NOTIFICATION_ID = "take-break-reminder";
const WEATHER_ORIGINS = [
  "https://api.open-meteo.com/*",
  "https://geocoding-api.open-meteo.com/*"
];
let pendingTask = Promise.resolve();

// Keep storage updates from overlapping across popup, alarm, and activity events.
function runTask(task) {
  const result = pendingTask.then(task);
  pendingTask = result.catch(() => {});
  return result;
}

chrome.runtime.onInstalled.addListener(() => runTask(async () => {
  const { settings, state } = await chrome.storage.local.get(["settings", "state"]);

  await chrome.storage.local.set({ settings: sanitizeSettings(settings) });
  await saveState({ ...DEFAULT_STATE, ...state });

  chrome.idle.setDetectionInterval(IDLE_RESET_SECONDS);
  await chrome.alarms.clear("takeBreakSnooze");
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  await syncCurrentActivity();
}));

chrome.runtime.onStartup.addListener(() => runTask(async () => {
  chrome.idle.setDetectionInterval(IDLE_RESET_SECONDS);
  await chrome.alarms.clear("takeBreakSnooze");
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  await syncCurrentActivity();
}));

chrome.alarms.onAlarm.addListener((alarm) => runTask(async () => {
  if (alarm.name === TICK_ALARM) {
    await tick();
  }
}));

function updateWindowState() {
  return runTask(async () => {
    await updateStateWithElapsed();
    await syncCurrentActivity();
  });
}

chrome.windows.onCreated.addListener(updateWindowState);
chrome.windows.onRemoved.addListener(updateWindowState);

chrome.idle.onStateChanged.addListener((idleState) => runTask(async () => {
  await updateStateWithElapsed();
  const state = await getState();
  state.idleState = idleState;
  if (idleState === "idle") {
    state.accumulatedMs = 0;
  }
  state.lastActiveStart = shouldCountTime(state) ? Date.now() : null;
  await saveState(state);
}));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  runTask(() => handleMessage(message))
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  if (message?.type === "getData") {
    await tick();
    const { settings, state } = await getSettingsAndState();
    return { ok: true, settings, state, active: shouldCountTime(state),
      weatherStatus: await getWeatherStatus(settings) };
  }

  if (message?.type === "saveSettings") {
    const settings = sanitizeSettings(message.settings);
    await chrome.storage.local.set({ settings });
    if (settings.weatherEnabled) await getWeather(settings);
    await tick();
    return { ok: true, settings };
  }

  if (message?.type === "resetTimer") {
    await resetTimer();
    return { ok: true };
  }

  if (message?.type === "setPaused") {
    await updateStateWithElapsed();
    const state = await getState();
    state.isPaused = Boolean(message.paused);
    state.lastActiveStart = shouldCountTime(state) ? Date.now() : null;
    await saveState(state);
    if (state.isPaused) await chrome.notifications.clear(NOTIFICATION_ID);
    return { ok: true };
  }

  if (message?.type === "testNotification") {
    const { settings, state } = await getSettingsAndState();
    try {
      await showReminder(settings, state, true);
      state.notificationError = null;
      await saveState(state);
      return { ok: true };
    } catch (error) {
      state.notificationError = error.message;
      await saveState(state);
      return { ok: false, error: error.message };
    }
  }

  throw new Error("Unknown message");
}

async function tick() {
  await updateStateWithElapsed();
  await syncCurrentActivity();
  const { settings, state } = await getSettingsAndState();

  const workMs = settings.workMinutes * 60 * 1000;
  if (shouldCountTime(state) && state.accumulatedMs >= workMs && settings.notificationsEnabled) {
    try {
      await showReminder(settings, state);
    } catch (error) {
      state.notificationError = error.message;
      await saveState(state);
      return;
    }
    state.notificationError = null;
    state.reminderIndex += 1;
    state.lastReminderAt = Date.now();
    state.accumulatedMs = 0;
    state.lastActiveStart = shouldCountTime(state) ? Date.now() : null;
    await saveState(state);
  }
}

async function updateStateWithElapsed() {
  const state = await getState();
  const now = Date.now();

  if (state.lastActiveStart && shouldCountTime(state)) {
    state.accumulatedMs += Math.max(0, now - state.lastActiveStart);
    state.lastActiveStart = now;
  } else {
    state.lastActiveStart = shouldCountTime(state) ? now : null;
  }

  await saveState(state);
}

async function syncCurrentActivity() {
  const state = await getState();

  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });
    state.hasOpenWindow = windows.length > 0;
  } catch {
    state.hasOpenWindow = false;
  }

  state.idleState = await chrome.idle.queryState(IDLE_RESET_SECONDS);
  if (state.idleState === "idle") {
    state.accumulatedMs = 0;
  }
  state.lastActiveStart = shouldCountTime(state) ? Date.now() : null;
  await saveState(state);
}

function shouldCountTime(state) {
  return !state.isPaused && state.hasOpenWindow && state.idleState === "active";
}

async function showReminder(settings, state, test = false) {
  if (await chrome.notifications.getPermissionLevel() !== "granted") {
    throw new Error("Notifications are blocked. Allow Chrome notifications in your system settings.");
  }
  const weather = await getWeather(settings);
  const message = buildReminderMessage(settings.workMinutes, state.reminderIndex, weather);
  await chrome.notifications.clear(NOTIFICATION_ID);
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "icon.png",
    title: test ? "Take a Break: test notification" : "Time for a break",
    message: test ? `Test: ${message}` : message,
    priority: 2,
    requireInteraction: true,
    silent: false
  });
}

function buildReminderMessage(minutes, index, weather) {
  const duration = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const introductions = [
    `Hey, you've been working for about ${duration}.`,
    `That's ${duration} of work. Ready for a breather?`,
    `Hey, it's been about ${duration}. Let's take a little break.`,
    `You've been at it for ${duration}. Time for a change of pace!`
  ];
  const indoorBreaks = [
    "Time to take a break! Stand up and stretch a little.",
    "Step away from the screen and get yourself some water.",
    "Relax your shoulders and give your eyes a screen-free moment.",
    "Get up, move around, and come back when you're ready."
  ];
  const walks = [
    "It's daylight and the weather looks pleasant in {city}. How about a short walk?",
    "The weather looks nice in {city}, and it's still light out. Go get some fresh air!",
    "A little daylight and pleasant weather in {city} - a good moment for a walk."
  ];
  const suggestion = isGoodWalkingWeather(weather?.current)
    ? walks[index % walks.length].replace("{city}", weather.location.name)
    : indoorBreaks[index % indoorBreaks.length];
  return `${introductions[index % introductions.length]} ${suggestion}`;
}

function isWeatherFresh(current) {
  return Boolean(current && Number.isFinite(current.time) &&
    Math.abs(Date.now() / 1000 - current.time) <= 20 * 60);
}

function isGoodWalkingWeather(current) {
  return Boolean(current && current.is_day === 1 &&
    [0, 1, 2, 3].includes(current.weather_code) &&
    Number.isFinite(current.apparent_temperature) &&
    current.apparent_temperature >= 10 && current.apparent_temperature <= 28 &&
    current.precipitation === 0 &&
    Number.isFinite(current.wind_speed_10m) && current.wind_speed_10m >= 0 &&
    current.wind_speed_10m <= 25 &&
    Number.isFinite(current.wind_gusts_10m) && current.wind_gusts_10m >= 0 &&
    current.wind_gusts_10m <= 35);
}

async function getWeather(settings) {
  if (!settings.weatherEnabled || !settings.weatherCity ||
    !await chrome.permissions.contains({ origins: WEATHER_ORIGINS })) return null;

  const { weatherCache } = await chrome.storage.local.get("weatherCache");
  const cached = weatherCache?.city === settings.weatherCity ? weatherCache : null;
  const ttl = cached?.weather ? 10 * 60000 : 5 * 60000;
  const cacheAge = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cacheAge >= 0 && cacheAge < ttl &&
    (!cached.weather || isWeatherFresh(cached.weather.current))) return cached.weather;

  let location = cached?.location;
  try {
    if (!location) {
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.search = new URLSearchParams({ name: settings.weatherCity, count: "1", language: "en" });
      const data = await fetchWeatherJSON(url);
      location = data.results?.[0];
      if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
        throw new Error("City not found. Check the city name.");
      }
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(location.latitude), longitude: String(location.longitude),
      current: "apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
      temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm",
      timezone: "auto", timeformat: "unixtime", forecast_days: "1"
    });
    const data = await fetchWeatherJSON(url);
    if (!isWeatherFresh(data.current)) {
      throw new Error("Current weather is unavailable.");
    }
    const weather = { current: data.current, location };
    const label = [location.name, location.admin1, location.country].filter(Boolean).join(", ");
    await chrome.storage.local.set({ weatherCache: {
      city: settings.weatherCity, fetchedAt: Date.now(), location, weather,
      status: `Weather location: ${label}`
    } });
    return weather;
  } catch (error) {
    await chrome.storage.local.set({ weatherCache: {
      city: settings.weatherCity, fetchedAt: Date.now(), location, weather: null,
      status: `${error.message} Using indoor break reminders.`
    } });
    return null;
  }
}

async function fetchWeatherJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error("Weather service is unavailable.");
  return response.json();
}

async function getWeatherStatus(settings) {
  if (!settings.weatherEnabled) return "Weather suggestions are off.";
  if (!await chrome.permissions.contains({ origins: WEATHER_ORIGINS })) {
    return "Weather access needed. Save settings to enable it.";
  }
  const { weatherCache } = await chrome.storage.local.get("weatherCache");
  return weatherCache?.city === settings.weatherCity
    ? weatherCache.status : `Weather city: ${settings.weatherCity}`;
}

async function resetTimer() {
  const state = await getState();
  state.accumulatedMs = 0;
  state.lastActiveStart = shouldCountTime(state) ? Date.now() : null;
  await saveState(state);
}

async function getSettingsAndState() {
  const data = await chrome.storage.local.get(["settings", "state"]);
  return {
    settings: sanitizeSettings(data.settings),
    state: { ...DEFAULT_STATE, ...data.state }
  };
}

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...state };
}

async function saveState(state) {
  const { onBreakUntil, isWindowFocused, popupActiveUntil, ...timerState } = state;
  await chrome.storage.local.set({ state: timerState });
}

function sanitizeSettings(settings = {}) {
  return {
    workMinutes: clampInteger(settings.workMinutes, 1, 240, DEFAULT_SETTINGS.workMinutes),
    notificationsEnabled: settings.notificationsEnabled !== false,
    weatherEnabled: settings.weatherEnabled !== false,
    weatherCity: typeof settings.weatherCity === "string"
      ? settings.weatherCity.trim().slice(0, 100) : DEFAULT_SETTINGS.weatherCity
  };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

// Alarms can disappear across reloads; restore the reminder check on worker startup.
runTask(async () => {
  chrome.idle.setDetectionInterval(IDLE_RESET_SECONDS);
  const alarm = await chrome.alarms.get(TICK_ALARM);
  if (!alarm || alarm.periodInMinutes !== 0.5) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  }
}).catch(console.error);
