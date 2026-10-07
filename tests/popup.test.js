const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function createPopup(granted = true) {
  const elements = new Map();
  const messages = [];
  const permissionRequests = [];
  const data = {
    ok: true, active: true,
    settings: { workMinutes: 50, notificationsEnabled: true, weatherEnabled: true, weatherCity: "Chicago" },
    state: { accumulatedMs: 1000, isPaused: false },
    weatherStatus: "Weather city: Chicago"
  };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, textContent: "", handlers: {},
      style: { setProperty() {} }, classList: { toggle() {} }, focus() {},
      addEventListener(type, fn) { this.handlers[type] = fn; }
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { querySelector: element, addEventListener() {} },
    window: { addEventListener() {} }, setTimeout() {},
    chrome: {
      permissions: { async request(options) { permissionRequests.push(options); return granted; } },
      runtime: { async sendMessage(message) {
        messages.push(message);
        if (message.type === "saveSettings") data.settings = message.settings;
        return data;
      } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8"), context);
  return {
    element, messages, permissionRequests,
    refresh() { return vm.runInContext("refresh()", context); },
    submit() { return element("#settingsForm").handlers.submit({ preventDefault() {} }); }
  };
}

test("weather permission is requested only when saving enabled weather", async () => {
  const popup = createPopup();
  await popup.refresh();
  assert.equal(popup.permissionRequests.length, 0);
  assert.equal(popup.element("#weatherCity").value, "Chicago");
  await popup.submit();
  assert.equal(popup.permissionRequests.length, 1);
  assert.equal(popup.permissionRequests[0].origins.length, 2);
  const saved = popup.messages.find(message => message.type === "saveSettings");
  assert.equal(saved.settings.weatherCity, "Chicago");
  assert.equal(saved.settings.weatherEnabled, true);
});

test("permission refusal and empty city prevent saving with weather enabled", async () => {
  const popup = createPopup(false);
  await popup.refresh();
  await popup.submit();
  assert.ok(!popup.messages.some(message => message.type === "saveSettings"));
  assert.match(popup.element("#feedback").textContent, /declined/);
  assert.equal(popup.element("#settingsForm button[type='submit']").disabled, false);
  popup.element("#weatherCity").value = " ";
  await popup.submit();
  assert.equal(popup.permissionRequests.length, 1);
  assert.match(popup.element("#feedback").textContent, /Enter a city/);
});

test("refresh preserves edits and disabling weather requires no network permission", async () => {
  const popup = createPopup(false);
  await popup.refresh();
  popup.element("#weatherCity").value = "Boston";
  popup.element("#workMinutes").value = "75";
  popup.element("#weatherEnabled").checked = false;
  popup.element("#weatherEnabled").handlers.change();
  await popup.refresh();
  assert.equal(popup.element("#weatherCity").value, "Boston");
  assert.equal(popup.element("#workMinutes").value, "75");
  assert.equal(popup.element("#weatherCity").disabled, true);
  await popup.submit();
  assert.equal(popup.permissionRequests.length, 0);
  assert.equal(popup.messages.find(message => message.type === "saveSettings").settings.weatherEnabled, false);
});
