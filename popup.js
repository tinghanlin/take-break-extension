const form = document.querySelector("#settingsForm");
const workMinutesInput = document.querySelector("#workMinutes");
const notificationsInput = document.querySelector("#notificationsEnabled");
const weatherInput = document.querySelector("#weatherEnabled");
const weatherCityInput = document.querySelector("#weatherCity");
const weatherStatus = document.querySelector("#weatherStatus");
const saveButton = document.querySelector("#settingsForm button[type='submit']");
const resetButton = document.querySelector("#resetTimer");
const pauseButton = document.querySelector("#pauseTimer");
const testButton = document.querySelector("#testNotification");
const notificationStatus = document.querySelector("#notificationStatus");
const feedback = document.querySelector("#feedback");
const statusDot = document.querySelector("#statusDot");
const timerLabel = document.querySelector("#timerLabel");
const timeText = document.querySelector("#timeText");
const progressRing = document.querySelector("#progressRing");
const progressText = document.querySelector("#progressText");

let refreshInterval = null;
let settingsLoaded = false;
let isPaused = false;

document.addEventListener("DOMContentLoaded", async () => {
  await refresh();
  refreshInterval = setInterval(refresh, 1000);
});

window.addEventListener("unload", () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (weatherInput.checked && !weatherCityInput.value.trim()) {
    showFeedback("Enter a city for weather suggestions.");
    weatherCityInput.focus();
    return;
  }
  const settings = {
    workMinutes: workMinutesInput.value,
    notificationsEnabled: notificationsInput.checked,
    weatherEnabled: weatherInput.checked,
    weatherCity: weatherCityInput.value
  };

  saveButton.disabled = true;
  try {
    if (settings.weatherEnabled) {
      const granted = await chrome.permissions.request({ origins: [
        "https://api.open-meteo.com/*", "https://geocoding-api.open-meteo.com/*"
      ] });
      if (!granted) {
        showFeedback("Weather access declined. Turn off weather suggestions to save without them.", 12000);
        return;
      }
    }
    const response = await sendMessage({ type: "saveSettings", settings });
    if (!response.ok) throw new Error("Could not save settings.");
    showFeedback("Settings saved.");
    await refresh();
  } catch {
    showFeedback("Could not save settings.");
  } finally {
    saveButton.disabled = false;
  }
});

weatherInput.addEventListener("change", updateWeatherField);

function updateWeatherField() {
  weatherCityInput.disabled = !weatherInput.checked;
}

resetButton.addEventListener("click", async () => {
  await sendMessage({ type: "resetTimer" });
  showFeedback("Timer reset.");
  await refresh();
});

pauseButton.addEventListener("click", async () => {
  pauseButton.disabled = true;
  try {
    const paused = !isPaused;
    const response = await sendMessage({ type: "setPaused", paused });
    if (!response.ok) throw new Error("Could not update timer.");
    showFeedback(paused ? "Timer paused." : "Timer resumed.");
    await refresh();
  } catch {
    showFeedback("Could not update timer.");
  } finally {
    pauseButton.disabled = false;
  }
});

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  try {
    const response = await sendMessage({ type: "testNotification" });
    if (response.ok) {
      showFeedback("Test sent. No banner? Check Chrome in macOS Notifications and Focus settings.", 12000);
    } else {
      showFeedback(response.error || "Could not send a test notification.", 12000);
    }
    await refresh();
  } catch {
    showFeedback("Could not connect to the extension. Reload it and try again.", 12000);
  } finally {
    testButton.disabled = false;
  }
});

async function refresh() {
  const response = await sendMessage({ type: "getData" }).catch(() => ({ ok: false }));
  if (!response.ok) {
    showFeedback("Could not load timer data.");
    return;
  }

  const { settings, state, active } = response;
  weatherStatus.textContent = response.weatherStatus || "";
  notificationStatus.textContent = state.notificationError || "";
  notificationStatus.hidden = !state.notificationError;
  isPaused = Boolean(state.isPaused);
  pauseButton.textContent = isPaused ? "Resume timer" : "Pause timer";
  if (!settingsLoaded) {
    workMinutesInput.value = settings.workMinutes;
    notificationsInput.checked = settings.notificationsEnabled;
    weatherInput.checked = settings.weatherEnabled;
    weatherCityInput.value = settings.weatherCity;
    updateWeatherField();
    settingsLoaded = true;
  }

  const workMs = settings.workMinutes * 60 * 1000;
  const progress = Math.min(1, state.accumulatedMs / workMs);
  const percent = Math.round(progress * 100);
  progressRing.style.setProperty("--progress", `${percent * 3.6}deg`);
  progressText.textContent = `${percent}%`;
  timeText.textContent = `${formatMinutes(state.accumulatedMs)} of ${settings.workMinutes} min`;

  statusDot.classList.toggle("active", active);
  if (isPaused) {
    timerLabel.textContent = "Timer paused";
  } else if (active) {
    timerLabel.textContent = "Counting while Chrome is open";
  } else if (state.idleState === "locked") {
    timerLabel.textContent = "Paused while your computer is locked";
  } else {
    timerLabel.textContent = "Paused while Chrome windows are closed";
  }
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatMinutes(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  if (minutes < 1) {
    return `${seconds}s`;
  }

  return `${minutes} min ${String(seconds).padStart(2, "0")}s`;
}

function showFeedback(message, duration = 2500) {
  feedback.textContent = message;
  setTimeout(() => {
    if (feedback.textContent === message) {
      feedback.textContent = "";
    }
  }, duration);
}
