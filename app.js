const NOAA = "https://services.swpc.noaa.gov";
const NASA = "https://api.nasa.gov/DONKI";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const FEEDS = ["kp", "solar", "scales", "noaaAlerts", "nasa", "aurora"];

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function readLocationFromTab() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("swg-location") || "null");
    return saved && Number.isFinite(Number(saved.latitude)) && Number.isFinite(Number(saved.longitude)) ? saved : null;
  } catch { return null; }
}

function readAltitudeFromTab() {
  try { return ["low", "mid", "high"].includes(sessionStorage.getItem("swg-altitude")) ? sessionStorage.getItem("swg-altitude") : "low"; }
  catch { return "low"; }
}

const state = {
  kp: [],
  kpForecast: [],
  wind: null,
  magnetic: null,
  scales: null,
  noaaAlerts: [],
  nasaEvents: [],
  aurora: null,
  feedStatus: Object.fromEntries(FEEDS.map((feed) => [feed, "loading"])),
  sector: "survey",
  hemisphere: "north",
  globe: { latitude: 65, longitude: -80, zoom: 1, dragging: false, lastX: 0, lastY: 0, lastProbe: 0, hover: null },
  location: readLocationFromTab(),
  altitude: readAltitudeFromTab(),
  profession: "",
  professionAnalyzed: false,
  nearestAuroraCache: null,
  localWeather: null,
  localWeatherStatus: "idle",
  localWeatherRequestId: 0,
  locationRequestId: 0,
  chartWindow: 72,
  settings: readSettings(),
  lastSync: null,
};

function readSettings() {
  try {
    return { threshold: "1", notifications: false, nasaKey: "", ...(JSON.parse(localStorage.getItem("swg-settings") || "{}")) };
  } catch {
    return { threshold: "1", notifications: false, nasaKey: "" };
  }
}

function saveSettings() {
  localStorage.setItem("swg-settings", JSON.stringify(state.settings));
}

function parseTime(value) {
  if (!value) return null;
  let normalized = String(value).trim();
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(normalized)) normalized = normalized.replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(normalized)) normalized += "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "" || value === "NaN") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRows(payload) {
  if (!Array.isArray(payload)) return [];
  if (payload.length && Array.isArray(payload[0])) {
    const headings = payload[0].map((heading) => String(heading).trim());
    return payload.slice(1).map((row) => Object.fromEntries(headings.map((heading, index) => [heading, row[index]])));
  }
  return payload;
}

async function getJSON(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function setFeed(key, status) {
  state.feedStatus[key] = status;
  const dotIds = {
    kp: ["dot-kp"], solar: ["dot-wind", "dot-mag"], noaaAlerts: ["dot-alerts", "dot-noaa-events"], nasa: ["dot-nasa"],
  };
  (dotIds[key] || []).forEach((id) => {
    const dot = document.getElementById(id);
    if (dot) dot.className = `feed-dot ${status}`;
  });
  updateCoverage();
}

function updateCoverage() {
  const successful = FEEDS.filter((key) => state.feedStatus[key] === "ok").length;
  const count = $("#coverage-count");
  const bar = $("#coverage-bar");
  if (count) count.textContent = `${successful} / ${FEEDS.length}`;
  if (bar) bar.style.width = `${(successful / FEEDS.length) * 100}%`;
  const label = $("#connection-label");
  const indicator = $("#live-indicator");
  if (label) label.textContent = successful === FEEDS.length ? "All public feeds connected" : successful ? `${successful} of ${FEEDS.length} feeds connected` : "Connecting to public feeds";
  if (indicator) indicator.classList.toggle("offline", successful === 0 && FEEDS.some((key) => state.feedStatus[key] === "error"));
  const confidence = $("#coverage-confidence");
  if (confidence) confidence.textContent = `SOURCE COVERAGE ${successful}/${FEEDS.length}`;
}

function setLabel(selector, text) {
  const node = $(selector);
  if (node) node.textContent = text;
}

function stampTime(date, includeDate = false) {
  if (!date) return "Time unavailable";
  const datePart = includeDate ? `${date.toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short" })} · ` : "";
  return `${datePart}${date.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false })} UTC`;
}

function activeTimeZone() {
  const candidate = state.location?.timezone || browserTimeZone();
  try { new Intl.DateTimeFormat("en", { timeZone: candidate }).format(); return candidate; }
  catch { return browserTimeZone(); }
}

function stampLocalTime(date, includeDate = true) {
  if (!date) return "Time unavailable";
  const options = { timeZone: activeTimeZone(), hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" };
  if (includeDate) { options.day = "2-digit"; options.month = "short"; }
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

function latitudeContext(latitude) {
  const absolute = Math.abs(latitude);
  if (absolute >= 55) return "higher geographic latitude";
  if (absolute >= 35) return "mid geographic latitude";
  if (absolute <= 15) return "near-equatorial latitude";
  return "lower geographic latitude";
}

function altitudeLabel(altitude = state.altitude) {
  return ({ low: "Low (0–3 km)", mid: "Mid (3–12 km)", high: "High (12+ km)" })[altitude] || "Low (0–3 km)";
}

function altitudeContext(altitude = state.altitude) {
  return ({ low: "Surface / ground context", mid: "Flight-level context", high: "High-altitude / space context" })[altitude] || "Surface / ground context";
}

function next24HourKpPeak() {
  const start = Date.now();
  const end = start + 24 * 60 * 60 * 1000;
  return state.kpForecast.map((row) => ({ row, time: kpTime(row), value: kpValue(row) }))
    .filter((point) => point.time && point.time.getTime() > start && point.time.getTime() <= end && point.value !== null && String(point.row.observed || "").toLowerCase() === "predicted")
    .sort((a, b) => b.value - a.value)[0] || null;
}

function updateLocationClock() {
  setLabel("#local-clock", stampLocalTime(new Date(), false));
  const timezone = state.location?.timezone || browserTimeZone();
  const source = state.location?.timezoneSource || (state.location ? "location time zone" : "device time zone");
  setLabel("#local-timezone", `${timezone} · ${source}`);
}

function updateLocationPanel() {
  const place = state.location;
  if (!place) {
    const peak = next24HourKpPeak();
    setLabel("#local-outlook", peak ? `Global Kp forecast peak ${peak.value.toFixed(1)} at ${stampLocalTime(peak.time)} · shown in device time` : "NOAA 3-hour forecast is unavailable for the next 24 hours.");
  } else {
    const lat = Number(place.latitude), lon = Number(place.longitude);
    const directionLat = lat < 0 ? "S" : "N", directionLon = lon < 0 ? "W" : "E";
    setLabel("#location-title", place.name || "Selected location");
    const accuracy = place.accuracy ? ` · device accuracy ±${Math.round(place.accuracy)} m` : "";
    setLabel("#location-coordinates", `${Math.abs(lat).toFixed(3)}°${directionLat}, ${Math.abs(lon).toFixed(3)}°${directionLon} · ${latitudeContext(lat)}${accuracy}`);
    const peak = next24HourKpPeak();
    setLabel("#local-outlook", peak ? `Global Kp forecast peak ${peak.value.toFixed(1)} at ${stampLocalTime(peak.time)} · ${gScaleFromKp(peak.value) ? `G${gScaleFromKp(peak.value)} threshold` : "below G1"}; not a site-specific forecast` : "NOAA 3-hour forecast is unavailable for the next 24 hours.");
  }
  const altitude = $("#altitude-select");
  if (altitude) altitude.value = state.altitude;
  setLabel("#chart-timezone", `${activeTimeZone()} · local time`);
  const mapLink = $("#map-link");
  if (mapLink) {
    mapLink.hidden = !place;
    if (place) mapLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.latitude},${place.longitude}`)}`;
  }
  updateLocalWeatherPanel();
  updateLocationClock();
}

function weatherCodeLabel(code) {
  return ({ 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail" })[Number(code)] || "Conditions loaded";
}

function updateLocalWeatherPanel() {
  if (!state.location) {
    setLabel("#local-weather", "Waiting for location");
    setLabel("#local-weather-time", "Cloud cover · visibility · daylight");
    return;
  }
  if (state.localWeatherStatus === "loading") {
    setLabel("#local-weather", "Fetching local conditions…");
    setLabel("#local-weather-time", "Open-Meteo model for selected coordinates");
    return;
  }
  if (state.localWeatherStatus !== "ok" || !state.localWeather?.current) {
    setLabel("#local-weather", state.localWeatherStatus === "error" ? "Local conditions unavailable" : "Waiting for location data");
    setLabel("#local-weather-time", state.localWeatherStatus === "error" ? "Use Refresh or check Open-Meteo" : "Cloud cover · visibility · daylight");
    return;
  }
  const current = state.localWeather.current;
  const cloud = asNumber(current.cloud_cover);
  const visibility = asNumber(current.visibility);
  const daylight = current.is_day === 1 ? "daylight" : current.is_day === 0 ? "night" : "daylight unknown";
  const visibilityText = visibility === null ? "visibility unavailable" : `${(visibility / 1000).toFixed(1)} km visibility`;
  const cloudText = cloud === null ? "cloud cover unavailable" : `${Math.round(cloud)}% cloud`;
  const modelTime = String(current.time || "").includes("T") ? String(current.time).slice(11, 16) : "time unavailable";
  const abbreviation = state.localWeather.timezone_abbreviation || state.localWeather.timezone || activeTimeZone();
  setLabel("#local-weather", `${weatherCodeLabel(current.weather_code)} · ${cloudText} · ${visibilityText}`);
  setLabel("#local-weather-time", `Model time ${modelTime} ${abbreviation} · ${daylight}`);
}

async function loadLocalConditions(place = state.location) {
  const requestId = ++state.localWeatherRequestId;
  if (!place) {
    state.localWeather = null;
    state.localWeatherStatus = "idle";
    updateLocalWeatherPanel();
    return;
  }
  state.localWeather = null;
  state.localWeatherStatus = "loading";
  updateLocalWeatherPanel();
  renderProfessionImpact();
  const params = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude),
    current: "temperature_2m,cloud_cover,visibility,weather_code,is_day",
    timezone: place.timezoneSource === "manual time zone" ? place.timezone : "auto",
  });
  try {
    const payload = await getJSON(`https://api.open-meteo.com/v1/forecast?${params}`, "Local weather");
    if (payload.error) throw new Error(payload.reason || "Open-Meteo returned an error");
    if (requestId !== state.localWeatherRequestId || !state.location) return;
    state.localWeather = payload;
    state.localWeatherStatus = "ok";
    if (payload.timezone && state.location.timezoneSource !== "manual time zone") {
      state.location = { ...state.location, timezone: payload.timezone, timezoneSource: "Open-Meteo coordinate time zone" };
      try { sessionStorage.setItem("swg-location", JSON.stringify(state.location)); } catch { }
    }
    state.nearestAuroraCache = null;
    updateLocationPanel();
    updateDashboard();
    renderEvents();
  } catch (error) {
    if (requestId !== state.localWeatherRequestId) return;
    state.localWeatherStatus = "error";
    updateLocalWeatherPanel();
    updateLocalImpactContext();
    renderProfessionImpact();
    setLabel("#location-message", "Location selected, but local sky data could not load. Check internet access and try Refresh.");
    console.warn("Local conditions failed:", error?.message || error);
  }
}

function setLocationProfile(place, message = "Location selected. Impact context is calculated in this tab.") {
  const latitude = Number(place.latitude), longitude = Number(place.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    setLabel("#location-message", "Enter a valid latitude from −90 to 90 and longitude from −180 to 180.");
    return;
  }
  let timezone = place.timezone || browserTimeZone();
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { timezone = browserTimeZone(); }
  state.location = { ...place, latitude, longitude, timezone, timezoneSource: place.timezoneSource || (place.timezone ? "location time zone" : "device time zone") };
  state.locationRequestId += 1;
  const locationButton = $("#use-location");
  if (locationButton) locationButton.disabled = false;
  state.nearestAuroraCache = null;
  state.hemisphere = latitude < 0 ? "south" : "north";
  state.globe.latitude = state.hemisphere === "north" ? 65 : -65;
  state.globe.longitude = longitude;
  state.globe.hover = null;
  try { sessionStorage.setItem("swg-location", JSON.stringify(state.location)); } catch { }
  $$(".hemisphere-toggle button").forEach((button) => button.classList.toggle("active", button.dataset.hemisphere === state.hemisphere));
  const searchResults = $("#location-results");
  if (searchResults) { searchResults.replaceChildren(); searchResults.hidden = true; }
  updateLocationPanel();
  updateDashboard();
  setLabel("#location-message", `${message} The nearest OVATION cell and local sky use these coordinates; planetary Kp remains global. Geographic latitude is a broad proxy, not geomagnetic latitude.`);
  renderEvents();
  loadLocalConditions(state.location);
}

function renderLocationResults(results) {
  const container = $("#location-results");
  if (!container) return;
  container.replaceChildren();
  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "location-empty";
    empty.textContent = "No matching places found. Try a city, region, or postal code.";
    container.append(empty);
    container.hidden = false;
    return;
  }
  for (const result of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    const label = [result.name, result.admin1, result.country].filter(Boolean).join(", ");
    button.textContent = label;
    button.addEventListener("click", () => {
      setLocationProfile({
        name: label,
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone,
        timezoneSource: result.timezone ? "location time zone" : "device time zone",
      }, result.timezone ? `${label} selected. Forecast and event timestamps use its time zone.` : `${label} selected. The place has no time-zone result; timestamps use the device time zone.`);
      $("#location-search").value = label;
    });
    container.append(button);
  }
  container.hidden = false;
}

async function searchLocations(query) {
  if (query.trim().length < 2) {
    setLabel("#location-message", "Enter at least two characters to search for a city or postal code.");
    return;
  }
  const submit = $("#location-search-form button[type='submit']");
  if (submit) { submit.disabled = true; submit.textContent = "Searching…"; }
  setLabel("#location-message", "Searching Open-Meteo for matching places…");
  try {
    const params = new URLSearchParams({ name: query.trim(), count: "6", language: "en", format: "json" });
    const payload = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${params}`, "Location search");
    renderLocationResults(payload.results || []);
    setLabel("#location-message", payload.results?.length ? "Choose a matching place to set local time and impact context." : "No matching places found.");
  } catch (error) {
    $("#location-results").replaceChildren();
    $("#location-results").hidden = true;
    setLabel("#location-message", "Location search is unavailable. Try manual coordinates or browser location.");
    console.warn("Location search failed:", error?.message || error);
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "Search"; }
  }
}

function kpValue(row) {
  return asNumber(row?.kp ?? row?.Kp ?? row?.KP ?? row?.Kp_index);
}

function kpTime(row) {
  return parseTime(row?.time_tag ?? row?.time ?? row?.timestamp);
}

function latestReading(rows, field) {
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => ({ row, time: parseTime(row.time_tag ?? row.time) }))
    .filter(({ row, time }) => time && asNumber(row[field]) !== null)
    .sort((a, b) => b.time - a.time)[0] || null;
}

function currentKP() {
  const latest = latestReading(state.kp, "Kp") || latestReading(state.kp, "kp");
  if (latest) return { value: kpValue(latest.row), time: latest.time, source: "minute" };
  const now = Date.now();
  const candidates = state.kpForecast.map((row) => ({ row, time: kpTime(row) }))
    .filter(({ row, time }) => time && time.getTime() <= now + 10 * 60 * 1000 && kpValue(row) !== null)
    .sort((a, b) => b.time - a.time);
  if (candidates[0]) return { value: kpValue(candidates[0].row), time: candidates[0].time, source: "forecast" };
  return null;
}

function gScaleFromKp(kp) {
  if (kp === null) return null;
  if (kp >= 9) return 5;
  if (kp >= 8) return 4;
  if (kp >= 7) return 3;
  if (kp >= 6) return 2;
  if (kp >= 5) return 1;
  return 0;
}

function gScaleEntry() {
  if (!state.scales) return null;
  if (state.scales["0"]) return state.scales["0"];
  if (state.scales.G) return state.scales;
  return null;
}

function scaleValue(entry, scaleName) {
  const value = entry?.[scaleName]?.Scale;
  const number = asNumber(value);
  return number === null ? 0 : Math.max(0, Math.min(5, number));
}

function scaleName(level) {
  return ["None", "Minor", "Moderate", "Strong", "Severe", "Extreme"][level] || "Unknown";
}

function setStatusClass(node, severity) {
  if (!node) return;
  node.classList.remove("state-watch", "state-elevated", "state-unavailable");
  if (severity === "watch") node.classList.add("state-watch");
  if (severity === "elevated") node.classList.add("state-elevated");
  if (severity === "unavailable") node.classList.add("state-unavailable");
}

function updateImpactRow(prefix, label, note, level) {
  setLabel(`#impact-${prefix}`, label);
  setLabel(`#impact-${prefix}-note`, note);
  const stateNode = $(`#impact-${prefix}`);
  const bar = $(`#meter-${prefix}`);
  const severity = level === null ? "unavailable" : level >= 3 ? "elevated" : level >= 1 ? "watch" : "nominal";
  setStatusClass(stateNode, severity === "nominal" ? "" : severity);
  if (bar) {
    bar.style.width = level === null ? "0%" : `${Math.max(8, Math.min(100, level * 20))}%`;
    bar.className = severity === "nominal" ? "" : severity;
  }
}

function computeAuroraLatitude() {
  const raw = state.aurora?.coordinates ?? state.aurora?.data ?? [];
  const coords = Array.isArray(raw) ? raw : [];
  let minimum = null;
  for (const point of coords) {
    const lat = asNumber(Array.isArray(point) ? point[1] : point?.latitude ?? point?.lat);
    const probability = asNumber(Array.isArray(point) ? point[2] : point?.probability ?? point?.value);
    if (lat === null || probability === null) continue;
    const inHemisphere = state.hemisphere === "north" ? lat > 0 : lat < 0;
    if (inHemisphere && probability >= 20) {
      const absolute = Math.abs(lat);
      if (minimum === null || absolute < minimum) minimum = absolute;
    }
  }
  return minimum;
}

function nearestAuroraAtLocation() {
  if (!state.location) return null;
  const raw = state.aurora?.coordinates ?? state.aurora?.data ?? [];
  if (!Array.isArray(raw) || !raw.length) return null;
  const latitude = Number(state.location.latitude), longitude = Number(state.location.longitude);
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}:${state.aurora?.["Forecast Time"] || state.aurora?.forecast_time || ""}`;
  if (state.nearestAuroraCache?.key === key) return state.nearestAuroraCache.value;
  const radians = (degree) => degree * Math.PI / 180;
  let nearest = null;
  for (const point of raw) {
    const lon = asNumber(Array.isArray(point) ? point[0] : point?.longitude ?? point?.lon);
    const lat = asNumber(Array.isArray(point) ? point[1] : point?.latitude ?? point?.lat);
    const probability = asNumber(Array.isArray(point) ? point[2] : point?.probability ?? point?.value);
    if (lon === null || lat === null || probability === null) continue;
    const dLat = radians(lat - latitude);
    const dLon = radians(((lon - longitude + 540) % 360) - 180);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latitude)) * Math.cos(radians(lat)) * Math.sin(dLon / 2) ** 2;
    const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (!nearest || distanceKm < nearest.distanceKm) nearest = { probability, distanceKm, latitude: lat, longitude: lon };
  }
  state.nearestAuroraCache = { key, value: nearest };
  return nearest;
}

function updateLocalImpactContext() {
  const place = state.location;
  const sLevel = scaleValue(gScaleEntry(), "S");
  const radiationAvailable = state.feedStatus.scales === "ok";
  const scaleDate = gScaleEntry()?.DateStamp ? `NOAA ${gScaleEntry().DateStamp} · ` : "";
  const radiationLabel = !radiationAvailable ? "Unavailable" : sLevel === 0 ? "No S-scale event" : `NOAA S${sLevel} event`;
  const radiationNote = !radiationAvailable ? "NOAA solar radiation scale unavailable" : `${scaleDate}${altitudeContext()} · ${place ? latitudeContext(Number(place.latitude)) : "global context"} · global scale only; no dose estimate`;
  updateImpactRow("radiation", radiationLabel, radiationNote, !radiationAvailable ? null : sLevel === 0 ? 0 : Math.min(3, sLevel));
  if (!place) {
    setLabel("#aurora-local-probability", "Set a location");
    return;
  }
  const localAurora = nearestAuroraAtLocation();
  if (localAurora) {
    setLabel("#aurora-local-probability", `${Math.round(localAurora.probability)}% nearest cell · ${Math.round(localAurora.distanceKm)} km away`);
    const current = state.localWeather?.current;
    const cloud = asNumber(current?.cloud_cover);
    const visibility = asNumber(current?.visibility);
    const localSky = state.localWeatherStatus === "ok" && current
      ? `${cloud === null ? "cloud cover unavailable" : `${Math.round(cloud)}% cloud cover`}, ${visibility === null ? "visibility unavailable" : `${(visibility / 1000).toFixed(1)} km visibility`}, ${current.is_day === 0 ? "night" : current.is_day === 1 ? "daylight" : "daylight unknown"} from local weather model`
      : "local cloud and visibility data unavailable";
    setLabel("#impact-aurora-note", `Nearest OVATION grid cell is ${Math.round(localAurora.distanceKm)} km away; ${localSky}.`);
  } else {
    setLabel("#aurora-local-probability", state.feedStatus.aurora === "error" ? "NOAA model unavailable" : "Waiting for NOAA model");
    setLabel("#impact-aurora-note", "NOAA OVATION data unavailable for selected location");
  }
  const latitude = Number(place.latitude);
  const context = latitudeContext(latitude);
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: activeTimeZone(), hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const nearEquatorEvening = Math.abs(latitude) <= 15 && localHour >= 18 && localHour < 24;
  const kp = currentKP()?.value ?? null;
  const gnss = kp === null ? null : kp >= 7 ? 3 : kp >= 5 ? 2 : kp >= 4 ? 1 : 0;
  const gnssNote = kp === null ? "NOAA Kp unavailable" : `${context} · global Kp ${kp.toFixed(1)}; local effects vary`;
  updateImpactRow("gnss", gnss === null ? "Unavailable" : gnss >= 3 ? "Elevated" : gnss >= 2 ? "Watch" : gnss === 1 ? "Monitor" : "Nominal", gnssNote, gnss);
  if (nearEquatorEvening && kp !== null) setLabel("#impact-gnss-note", `${context}, evening · Kp ${kp.toFixed(1)} global; scintillation can affect GNSS`);
  const timeNow = stampLocalTime(new Date(), false);
  const rLevel = scaleValue(gScaleEntry(), "R");
  if (state.feedStatus.scales === "ok") setLabel("#impact-radio-note", `${scaleDate}R${rLevel} global scale · ${timeNow} here; local propagation varies`);
  const gLevel = Math.max(kp === null ? 0 : gScaleFromKp(kp), scaleValue(gScaleEntry(), "G"));
  if (kp !== null || state.feedStatus.scales === "ok") setLabel("#impact-power-note", `${context} · global G${gLevel} outlook; local grid conditions vary`);
}

function localizedSourceTime(value) {
  const date = parseTime(value);
  return date ? `${stampLocalTime(date, true)} local · ${stampTime(date, true)}` : (value || "Time unavailable");
}

function updateDashboard() {
  const reading = currentKP();
  const kp = reading?.value ?? null;
  const feedScale = scaleValue(gScaleEntry(), "G");
  const gLevel = kp === null ? feedScale : Math.max(gScaleFromKp(kp), feedScale);
  const forecastNext = state.kpForecast.map((row) => ({ row, time: kpTime(row) }))
    .filter(({ row, time }) => time && time.getTime() > Date.now() && String(row.observed || "").toLowerCase() === "predicted" && kpValue(row) !== null)
    .sort((a, b) => a.time - b.time)[0];
  setLabel("#hero-level", gLevel > 0 ? `G${gLevel}` : "G0");
  setLabel("#hero-status-name", gLevel > 0 ? `${scaleName(gLevel)} geomagnetic storm level` : kp === null ? "Waiting for NOAA data" : "Below NOAA G-scale threshold");
  setLabel("#hero-kp", kp === null ? "—" : kp.toFixed(1));
  setLabel("#hero-forecast", forecastNext ? `${kpValue(forecastNext.row).toFixed(1)} Kp · ${stampLocalTime(forecastNext.time)} local` : "No forecast loaded");
  setLabel("#metric-kp", kp === null ? "—" : kp.toFixed(1));
  setLabel("#metric-kp-caption", reading ? `${reading.source === "minute" ? "Latest 1-minute value" : "Latest forecast value"} · ${stampLocalTime(reading.time, false)} local` : "NOAA Kp feed unavailable");
  if (reading) setLabel("#kp-feed-label", reading.source === "minute" ? "NOAA SWPC · 1-minute planetary Kp" : "NOAA SWPC planetary Kp forecast");

  const speed = latestReading(state.wind, "proton_speed") || latestReading(state.wind, "speed");
  const windValue = speed ? asNumber(speed.row.proton_speed ?? speed.row.speed) : null;
  setLabel("#metric-wind", windValue === null ? "—" : Math.round(windValue).toLocaleString("en-US"));
  setLabel("#time-wind", speed ? `${stampLocalTime(speed.time, false)} local` : state.feedStatus.solar === "error" ? "NOAA feed unavailable" : "Waiting for feed");
  const bzReading = latestReading(state.magnetic, "bz_gsm") || latestReading(state.magnetic, "bz");
  const bzValue = bzReading ? asNumber(bzReading.row.bz_gsm ?? bzReading.row.bz) : null;
  setLabel("#metric-bz", bzValue === null ? "—" : `${bzValue > 0 ? "+" : ""}${bzValue.toFixed(1)}`);
  setLabel("#time-mag", bzReading ? `${stampLocalTime(bzReading.time, false)} local` : state.feedStatus.solar === "error" ? "NOAA feed unavailable" : "Waiting for feed");

  const noaaCount = state.noaaAlerts.length;
  setLabel("#metric-alerts", state.feedStatus.noaaAlerts === "ok" ? String(noaaCount) : "—");
  setLabel("#time-alerts", state.feedStatus.noaaAlerts === "ok" ? `${noaaCount} bulletin${noaaCount === 1 ? "" : "s"} in latest feed` : "NOAA feed unavailable");
  const scales = gScaleEntry();
  const rLevel = scaleValue(scales, "R");
  const sLevel = scaleValue(scales, "S");
  const scaleDate = scales?.DateStamp ? `NOAA ${scales.DateStamp}` : "NOAA scale unavailable";
  setLabel("#summary-geomag", kp === null ? "Unavailable" : `Kp ${kp.toFixed(1)} · ${gLevel ? `G${gLevel}` : "below G1"}`);
  setLabel("#summary-wind", windValue === null ? "Unavailable" : `${Math.round(windValue)} km/s`);
  setLabel("#summary-radiation", `R${rLevel} / S${sLevel}`);
  if (kp === null) {
    setLabel("#condition-summary", "NOAA planetary readings are currently unavailable. Refresh the public feeds or check the official source bulletin.");
  } else if (gLevel >= 1) {
    setLabel("#condition-summary", `NOAA's latest planetary reading is Kp ${kp.toFixed(1)}. ${scaleName(gLevel)} geomagnetic activity is indicated; check system-specific guidance and the current SWPC bulletin before changing operations.`);
  } else {
    setLabel("#condition-summary", `Geomagnetic activity is currently below NOAA's G1 storm threshold at Kp ${kp.toFixed(1)}. Space weather can still affect individual systems; keep routine monitoring active.`);
  }
  const gnss = kp === null ? null : kp >= 7 ? 3 : kp >= 5 ? 2 : kp >= 4 ? 1 : 0;
  updateImpactRow("gnss", gnss === null ? "Unavailable" : gnss >= 3 ? "Elevated" : gnss >= 2 ? "Watch" : gnss === 1 ? "Monitor" : "Nominal", kp === null ? "NOAA Kp not available" : `Planetary Kp ${kp.toFixed(1)}`, gnss);
  const radio = rLevel >= 2 ? 3 : rLevel >= 1 ? 2 : 0;
  updateImpactRow("radio", state.feedStatus.scales !== "ok" ? "Unavailable" : rLevel >= 2 ? `R${rLevel} blackout` : rLevel === 1 ? "R1 radio event" : "No R-scale event", state.feedStatus.scales === "ok" ? `${scaleDate} · R scale` : "NOAA scales unavailable", state.feedStatus.scales === "ok" ? radio : null);
  const power = gLevel >= 3 ? 3 : gLevel >= 1 ? 2 : 0;
  const powerAvailable = kp !== null || state.feedStatus.scales === "ok";
  updateImpactRow("power", !powerAvailable ? "Unavailable" : gLevel >= 3 ? "Elevated" : gLevel >= 1 ? "Watch" : "Nominal", powerAvailable ? `Kp-derived outlook · G${gLevel}` : "Awaiting geomagnetic reading", powerAvailable ? power : null);
  const minLatitude = computeAuroraLatitude();
  setLabel("#aurora-min-lat", minLatitude === null ? "—" : `${minLatitude.toFixed(0)}°`);
  updateImpactRow("aurora", minLatitude === null ? "Model unavailable" : `Model ≥20% near ${minLatitude.toFixed(0)}°`, minLatitude === null ? "NOAA OVATION data unavailable" : "Model probability, not visibility", minLatitude === null ? null : minLatitude < 55 ? 3 : minLatitude < 65 ? 2 : 1);
  setLabel("#impact-aurora-note", minLatitude === null ? "Waiting for NOAA model" : `Equatorward ≥20% · ${state.hemisphere}`);
  setLabel("#aurora-observation", localizedSourceTime(state.aurora?.["Observation Time"] || state.aurora?.observation_time || "Model loaded"));
  setLabel("#aurora-forecast-time", localizedSourceTime(state.aurora?.["Forecast Time"] || state.aurora?.forecast_time || "Latest available"));
  setLabel("#metric-alerts-caption", noaaCount === 0 && state.feedStatus.noaaAlerts === "ok" ? "No bulletins in the current response" : "Official watches, warnings & alerts");
  setLabel("#summary-radiation", `R${rLevel} / S${sLevel}`);
  updateLocationPanel();
  updateLocalImpactContext();
  updateSectorGuidance();
  renderProfessionImpact();
  drawKpChart();
  drawAuroraMap();
  maybeNotify(gLevel);
}

function dataLabelFor(row) {
  const date = kpTime(row);
  if (!date) return "";
  return date.toLocaleTimeString("en-GB", { timeZone: activeTimeZone(), hour: "2-digit", minute: "2-digit", hour12: false });
}

function drawKpChart() {
  const canvas = $("#kp-chart");
  const empty = $("#chart-empty");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const left = 31, right = 10, top = 10, bottom = 25;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  ctx.clearRect(0, 0, width, height);
  const now = Date.now();
  const pastHours = Math.round(state.chartWindow * 2 / 3);
  const futureHours = state.chartWindow - pastHours;
  const start = now - pastHours * 60 * 60 * 1000;
  const end = now + futureHours * 60 * 60 * 1000;
  const source = state.kpForecast.length ? state.kpForecast : state.kp;
  const points = source.map((row) => ({ row, time: kpTime(row), value: kpValue(row) }))
    .filter((point) => point.time && point.value !== null && point.time.getTime() >= start && point.time.getTime() <= end)
    .sort((a, b) => a.time - b.time);
  if (!points.length) {
    if (empty) {
      empty.textContent = state.feedStatus.kp === "error" ? "NOAA Kp feed is unavailable. Use the source link to check current conditions." : "Waiting for NOAA Kp readings…";
      empty.classList.remove("hidden");
    }
    ctx.fillStyle = "#a8afbb";
    ctx.font = "9px DM Mono, monospace";
    for (let value = 0; value <= 9; value += 3) {
      const y = top + plotH - (value / 9) * plotH;
      ctx.strokeStyle = "#edf0f3";
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      ctx.fillText(String(value), 6, y + 3);
    }
    return;
  }
  if (empty) empty.classList.add("hidden");
  const xAt = (time) => left + ((time - start) / (end - start)) * plotW;
  const yAt = (value) => top + plotH - (Math.max(0, Math.min(9, value)) / 9) * plotH;
  const yTicks = [0, 3, 5, 7, 9];
  for (const value of yTicks) {
    const y = yAt(value);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y);
    ctx.strokeStyle = value === 5 ? "#efd7b2" : "#edf0f3";
    ctx.setLineDash(value === 5 ? [3, 3] : []); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = value === 5 ? "#b47b31" : "#a3abb6";
    ctx.font = "8px DM Mono, monospace"; ctx.fillText(String(value), 8, y + 3);
  }
  const tickCount = Math.min(6, Math.max(3, Math.floor(plotW / 72)));
  for (let i = 0; i <= tickCount; i++) {
    const time = start + (i / tickCount) * (end - start);
    const x = xAt(time);
    ctx.strokeStyle = "#f1f2f4"; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
    const date = new Date(time);
    const label = date.toLocaleTimeString("en-GB", { timeZone: activeTimeZone(), hour: "2-digit", hour12: false }) + "h";
    ctx.fillStyle = "#a0a8b4"; ctx.font = "8px DM Mono, monospace";
    ctx.textAlign = i === 0 ? "left" : i === tickCount ? "right" : "center";
    ctx.fillText(label, x, height - 7);
  }
  const isFuture = (point) => String(point.row.observed || "").toLowerCase() === "predicted" || point.time.getTime() > now;
  const observed = points.filter((point) => !isFuture(point));
  const predicted = points.filter((point) => isFuture(point));
  const drawSeries = (series, color, dashed, includePrevious = false) => {
    if (!series.length) return;
    ctx.beginPath();
    series.forEach((point, index) => {
      const x = xAt(point.time.getTime()), y = yAt(point.value);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash(dashed ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    series.forEach((point, index) => {
      if (index % Math.max(1, Math.floor(series.length / 9)) !== 0 && index !== series.length - 1) return;
      ctx.beginPath(); ctx.arc(xAt(point.time.getTime()), yAt(point.value), index === series.length - 1 ? 2.7 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    });
  };
  drawSeries(observed, "#d89534", false);
  if (observed.length && predicted.length) {
    const last = observed[observed.length - 1];
    const first = predicted[0];
    ctx.beginPath(); ctx.moveTo(xAt(last.time.getTime()), yAt(last.value)); ctx.lineTo(xAt(first.time.getTime()), yAt(first.value)); ctx.strokeStyle = "#7c83d3"; ctx.lineWidth = 1.8; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  drawSeries(predicted, "#747bd1", true);
  if (!observed.length) drawSeries(points, "#d89534", false);
  ctx.textAlign = "left";
}

const LAND_SHAPES = [
  [[-168, 72], [-151, 69], [-141, 61], [-131, 55], [-126, 48], [-124, 40], [-117, 32], [-110, 28], [-105, 23], [-97, 18], [-91, 19], [-86, 24], [-81, 25], [-80, 31], [-74, 40], [-67, 45], [-59, 52], [-63, 59], [-78, 63], [-90, 68], [-107, 71], [-126, 72], [-145, 73]],
  [[-53, 59], [-45, 60], [-38, 67], [-41, 76], [-48, 82], [-57, 81], [-62, 75], [-60, 67]],
  [[-81, 12], [-74, 8], [-69, 1], [-66, -8], [-61, -17], [-58, -28], [-64, -39], [-69, -50], [-75, -55], [-78, -42], [-80, -26], [-78, -10]],
  [[-11, 36], [-9, 44], [-5, 51], [3, 57], [13, 60], [23, 57], [31, 61], [39, 56], [35, 48], [27, 43], [18, 39], [8, 36], [0, 38]],
  [[-17, 35], [-5, 37], [10, 34], [24, 31], [34, 22], [43, 12], [50, 2], [42, -11], [35, -22], [27, -34], [18, -35], [10, -27], [2, -17], [-5, -2], [-13, 12]],
  [[31, 70], [45, 75], [61, 72], [74, 68], [87, 72], [102, 70], [117, 65], [132, 59], [145, 53], [151, 45], [141, 39], [129, 34], [121, 26], [113, 18], [105, 10], [96, 7], [87, 18], [77, 23], [68, 30], [58, 27], [49, 37], [41, 48], [34, 58]],
  [[68, 25], [77, 29], [88, 22], [92, 14], [82, 7], [74, 10]],
  [[112, -11], [129, -12], [143, -17], [153, -27], [147, -39], [135, -44], [120, -36], [114, -25]],
  [[-180, -70], [-120, -72], [-60, -70], [0, -73], [60, -70], [120, -72], [180, -70]],
];

function globeRadius(width, height) {
  return Math.min(width * .42, height * .44) * state.globe.zoom;
}

function projectGlobePoint(longitude, latitude, cx, cy, radius) {
  const rad = Math.PI / 180;
  const lat = latitude * rad, lon = longitude * rad;
  const centerLat = state.globe.latitude * rad, centerLon = state.globe.longitude * rad;
  const delta = lon - centerLon;
  const x = Math.cos(lat) * Math.sin(delta);
  const y = Math.cos(centerLat) * Math.sin(lat) - Math.sin(centerLat) * Math.cos(lat) * Math.cos(delta);
  const z = Math.sin(centerLat) * Math.sin(lat) + Math.cos(centerLat) * Math.cos(lat) * Math.cos(delta);
  return { x: cx + radius * x, y: cy - radius * y, z };
}

function traceGlobeCurve(ctx, coordinates, cx, cy, radius) {
  ctx.beginPath();
  let drawing = false;
  for (const [longitude, latitude] of coordinates) {
    const point = projectGlobePoint(longitude, latitude, cx, cy, radius);
    if (point.z > .015) {
      if (!drawing) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      drawing = true;
    } else drawing = false;
  }
  ctx.stroke();
}

function drawGlobeLand(ctx, cx, cy, radius) {
  for (const shape of LAND_SHAPES) {
    const points = shape.map(([longitude, latitude]) => projectGlobePoint(longitude, latitude, cx, cy, radius));
    const visible = points.filter((point) => point.z > .02);
    if (visible.length < 2) continue;
    if (visible.length === points.length) {
      ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.closePath(); ctx.fillStyle = "rgba(43,89,105,.62)"; ctx.fill();
      ctx.strokeStyle = "rgba(103,169,174,.24)"; ctx.lineWidth = .7; ctx.stroke();
      continue;
    }
    ctx.beginPath();
    let drawing = false;
    points.forEach((point) => {
      if (point.z > .02) { if (!drawing) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); drawing = true; }
      else drawing = false;
    });
    ctx.strokeStyle = "rgba(103,169,174,.22)"; ctx.lineWidth = .7; ctx.stroke();
  }
}

function drawAuroraMap() {
  const canvas = $("#aurora-map");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width, height = rect.height;
  const cx = width / 2, cy = height / 2, radius = globeRadius(width, height);
  ctx.clearRect(0, 0, width, height);

  for (let index = 0; index < 72; index++) {
    const x = ((index * 97.37) % 997) / 997 * width;
    const y = ((index * 47.11 + 23) % 991) / 991 * height;
    ctx.fillStyle = `rgba(173,203,222,${.12 + (index % 4) * .07})`;
    ctx.fillRect(x, y, index % 9 === 0 ? 1.5 : 1, index % 9 === 0 ? 1.5 : 1);
  }

  const atmosphere = ctx.createRadialGradient(cx, cy, radius * .88, cx, cy, radius * 1.14);
  atmosphere.addColorStop(0, "rgba(67,165,202,.02)");
  atmosphere.addColorStop(.72, "rgba(72,183,218,.2)");
  atmosphere.addColorStop(1, "rgba(62,137,190,0)");
  ctx.beginPath(); ctx.arc(cx, cy, radius * 1.14, 0, Math.PI * 2); ctx.fillStyle = atmosphere; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.save(); ctx.shadowColor = "rgba(67,183,221,.32)"; ctx.shadowBlur = 22;
  ctx.strokeStyle = "rgba(112,202,230,.45)"; ctx.lineWidth = 1.25; ctx.stroke(); ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
  const ocean = ctx.createRadialGradient(cx - radius * .34, cy - radius * .4, radius * .05, cx, cy, radius * 1.12);
  ocean.addColorStop(0, "#205170"); ocean.addColorStop(.45, "#123750"); ocean.addColorStop(1, "#071522");
  ctx.fillStyle = ocean; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  const shade = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  shade.addColorStop(0, "rgba(104,191,211,.12)"); shade.addColorStop(.48, "rgba(6,19,31,0)"); shade.addColorStop(1, "rgba(1,7,16,.63)");
  ctx.fillStyle = shade; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  drawGlobeLand(ctx, cx, cy, radius);
  ctx.lineWidth = .7; ctx.strokeStyle = "rgba(132,183,205,.16)";
  for (const latitude of [-60, -30, 0, 30, 60]) {
    const coordinates = [];
    for (let longitude = -180; longitude <= 180; longitude += 3) coordinates.push([longitude, latitude]);
    traceGlobeCurve(ctx, coordinates, cx, cy, radius);
  }
  for (let longitude = -180; longitude < 180; longitude += 30) {
    const coordinates = [];
    for (let latitude = -90; latitude <= 90; latitude += 3) coordinates.push([longitude, latitude]);
    traceGlobeCurve(ctx, coordinates, cx, cy, radius);
  }

  const coords = state.aurora?.coordinates ?? state.aurora?.data ?? [];
  if (Array.isArray(coords) && coords.length) {
    const stride = Math.max(1, Math.floor(coords.length / 10000));
    ctx.globalCompositeOperation = "lighter";
    for (let index = 0; index < coords.length; index += stride) {
      const item = coords[index];
      const longitude = asNumber(Array.isArray(item) ? item[0] : item?.longitude ?? item?.lon);
      const latitude = asNumber(Array.isArray(item) ? item[1] : item?.latitude ?? item?.lat);
      const probability = asNumber(Array.isArray(item) ? item[2] : item?.probability ?? item?.value);
      if (longitude === null || latitude === null || probability === null || probability < 7) continue;
      if (state.hemisphere === "north" ? latitude < 25 : latitude > -25) continue;
      if (state.hemisphere === "north" && latitude < 0 || state.hemisphere === "south" && latitude > 0) continue;
      const point = projectGlobePoint(longitude, latitude, cx, cy, radius);
      if (point.z <= .01) continue;
      const alpha = Math.min(.82, .18 + probability / 115);
      ctx.beginPath(); ctx.arc(point.x, point.y, probability >= 55 ? 2.1 : probability >= 25 ? 1.6 : 1.2, 0, Math.PI * 2);
      ctx.fillStyle = probability >= 60 ? `rgba(183,236,116,${alpha})` : probability >= 25 ? `rgba(61,229,174,${alpha})` : `rgba(54,167,224,${alpha})`;
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  if (state.location) {
    const point = projectGlobePoint(Number(state.location.longitude), Number(state.location.latitude), cx, cy, radius);
    if (point.z > .01) {
      ctx.beginPath(); ctx.arc(point.x, point.y, 7, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,213,132,.38)"; ctx.lineWidth = 4; ctx.stroke();
      ctx.beginPath(); ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#fff3cc"; ctx.fill();
      ctx.beginPath(); ctx.arc(point.x, point.y, 1.5, 0, Math.PI * 2); ctx.fillStyle = "#e99b32"; ctx.fill();
    }
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = "rgba(130,204,228,.54)"; ctx.lineWidth = 1; ctx.stroke();

  const empty = $("#map-empty");
  const hasModel = Array.isArray(state.aurora?.coordinates ?? state.aurora?.data) && (state.aurora?.coordinates ?? state.aurora?.data).length > 0;
  if (empty) {
    if (!hasModel) {
      empty.textContent = state.feedStatus.aurora === "error" ? "NOAA aurora model unavailable. Check the OVATION source." : "Waiting for NOAA aurora model…";
      empty.classList.remove("hidden");
    } else empty.classList.add("hidden");
  }
  if (!state.globe.hover) {
    const readout = $("#globe-readout");
    if (readout) readout.textContent = state.location ? `Selected: ${state.location.name || "location"} · drag to rotate, scroll to zoom` : "Drag to rotate · scroll or use + / − to zoom";
  }
}

function globeCoordinatesAt(x, y, width, height) {
  const radius = globeRadius(width, height);
  const screenX = (x - width / 2) / radius;
  const screenY = (height / 2 - y) / radius;
  const radiusSquared = screenX * screenX + screenY * screenY;
  if (radiusSquared > 1) return null;
  const depth = Math.sqrt(1 - radiusSquared);
  const rad = Math.PI / 180;
  const centerLat = state.globe.latitude * rad, centerLon = state.globe.longitude * rad;
  const worldX = screenX * -Math.sin(centerLon) + screenY * -Math.sin(centerLat) * Math.cos(centerLon) + depth * Math.cos(centerLat) * Math.cos(centerLon);
  const worldY = screenX * Math.cos(centerLon) + screenY * -Math.sin(centerLat) * Math.sin(centerLon) + depth * Math.cos(centerLat) * Math.sin(centerLon);
  const worldZ = screenY * Math.cos(centerLat) + depth * Math.sin(centerLat);
  return { latitude: Math.asin(Math.max(-1, Math.min(1, worldZ))) / rad, longitude: Math.atan2(worldY, worldX) / rad };
}

function nearestGlobeAuroraCell(latitude, longitude) {
  const coords = state.aurora?.coordinates ?? state.aurora?.data ?? [];
  if (!Array.isArray(coords) || !coords.length) return null;
  const latitudeScale = 111.32;
  const longitudeScale = latitudeScale * Math.cos(latitude * Math.PI / 180);
  let nearest = null;
  for (const item of coords) {
    const cellLon = asNumber(Array.isArray(item) ? item[0] : item?.longitude ?? item?.lon);
    const cellLat = asNumber(Array.isArray(item) ? item[1] : item?.latitude ?? item?.lat);
    const probability = asNumber(Array.isArray(item) ? item[2] : item?.probability ?? item?.value);
    if (cellLon === null || cellLat === null || probability === null) continue;
    const deltaLon = ((cellLon - longitude + 540) % 360) - 180;
    const distanceKm = Math.hypot((cellLat - latitude) * latitudeScale, deltaLon * longitudeScale);
    if (!nearest || distanceKm < nearest.distanceKm) nearest = { probability, distanceKm };
  }
  return nearest;
}

function initGlobeControls() {
  const canvas = $("#aurora-map");
  if (!canvas) return;
  const redraw = () => requestAnimationFrame(drawAuroraMap);
  const changeZoom = (factor) => {
    state.globe.zoom = Math.max(.78, Math.min(1.62, state.globe.zoom * factor));
    state.globe.hover = null;
    drawAuroraMap();
  };
  $("#globe-zoom-in")?.addEventListener("click", () => changeZoom(1.18));
  $("#globe-zoom-out")?.addEventListener("click", () => changeZoom(1 / 1.18));
  $("#globe-reset")?.addEventListener("click", () => {
    state.globe.latitude = state.hemisphere === "north" ? 65 : -65;
    state.globe.longitude = state.location ? Number(state.location.longitude) : -80;
    state.globe.zoom = 1; state.globe.hover = null;
    drawAuroraMap();
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    state.globe.dragging = true; state.globe.lastX = event.clientX; state.globe.lastY = event.clientY;
    canvas.classList.add("dragging"); canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.globe.dragging) {
      const deltaX = event.clientX - state.globe.lastX;
      const deltaY = event.clientY - state.globe.lastY;
      state.globe.lastX = event.clientX; state.globe.lastY = event.clientY;
      state.globe.hover = null;
      const rotatedLongitude = state.globe.longitude - deltaX * .42 / state.globe.zoom;
      state.globe.longitude = ((rotatedLongitude + 180) % 360 + 360) % 360 - 180;
      state.globe.latitude = Math.max(-82, Math.min(82, state.globe.latitude + deltaY * .34 / state.globe.zoom));
      redraw();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const point = globeCoordinatesAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    let nearest = null;
    if (point && performance.now() - state.globe.lastProbe > 180) {
      state.globe.lastProbe = performance.now();
      nearest = nearestGlobeAuroraCell(point.latitude, point.longitude);
    }
    state.globe.hover = point ? { ...point, nearest } : null;
    const readout = $("#globe-readout");
    const probeText = nearest ? ` · nearest OVATION cell ${Math.round(nearest.probability)}% / ${Math.round(nearest.distanceKm)} km` : "";
    if (readout) readout.textContent = point
      ? `Globe view · ${Math.abs(point.latitude).toFixed(1)}°${point.latitude >= 0 ? "N" : "S"}, ${Math.abs(point.longitude).toFixed(1)}°${point.longitude >= 0 ? "E" : "W"}${probeText}`
      : state.location ? `Selected: ${state.location.name || "location"} · drag to rotate, scroll to zoom` : "Drag to rotate · scroll or use + / − to zoom";
  });
  const stopDrag = () => {
    state.globe.dragging = false; canvas.classList.remove("dragging");
    const readout = $("#globe-readout");
    if (readout) readout.textContent = state.location ? `Selected: ${state.location.name || "location"} · drag to rotate, scroll to zoom` : "Drag to rotate · scroll or use + / − to zoom";
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("lostpointercapture", stopDrag);
  canvas.addEventListener("pointerleave", () => {
    if (state.globe.dragging) return;
    state.globe.hover = null;
    const readout = $("#globe-readout");
    if (readout) readout.textContent = state.location ? `Selected: ${state.location.name || "location"} · drag to rotate, scroll to zoom` : "Drag to rotate · scroll or use + / − to zoom";
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault(); changeZoom(event.deltaY < 0 ? 1.08 : 1 / 1.08);
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 16 : 8;
    if (event.key === "ArrowLeft") state.globe.longitude -= step;
    else if (event.key === "ArrowRight") state.globe.longitude += step;
    else if (event.key === "ArrowUp") state.globe.latitude = Math.min(82, state.globe.latitude + step);
    else if (event.key === "ArrowDown") state.globe.latitude = Math.max(-82, state.globe.latitude - step);
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(1.18); return; }
    else if (event.key === "-") { event.preventDefault(); changeZoom(1 / 1.18); return; }
    else return;
    event.preventDefault(); state.globe.hover = null; drawAuroraMap();
  });
}

function guidanceForSector(sector) {
  const kp = currentKP()?.value ?? null;
  const wind = latestReading(state.wind, "proton_speed") || latestReading(state.wind, "speed");
  const speed = wind ? asNumber(wind.row.proton_speed ?? wind.row.speed) : null;
  const gLevel = Math.max(kp === null ? 0 : gScaleFromKp(kp), scaleValue(gScaleEntry(), "G"));
  const rLevel = scaleValue(gScaleEntry(), "R");
  const conditionsReady = state.feedStatus.kp === "ok" || state.feedStatus.scales === "ok";
  const copy = {
    survey: gLevel >= 1 ? "Confirm RTK corrections and base-station integrity before precision work. Compare independent fixes if a position shift appears." : "Keep a baseline fix and monitor correction quality. Pause only if your own receiver or official guidance indicates degraded service.",
    aviation: gLevel >= 1 ? "Review GNSS loss-of-lock and satellite visibility before flight. Follow your aviation authority's procedures if navigation quality changes." : "Check route-specific GNSS availability and standard pre-flight telemetry. Keep normal contingency procedures in place.",
    radio: rLevel >= 1 ? "Review the active R-scale bulletin and propagation conditions before relying on HF for time-critical traffic." : "Propagation varies by frequency and location. Check current band conditions before mission-critical communication.",
    power: gLevel >= 1 ? "Grid operators should monitor their established geomagnetically induced current and voltage indicators, following local operating procedures." : "Continue standard grid monitoring. Use operator telemetry and official SWPC products for any operational response.",
    research: "Record the observation time and source alongside instrument data. Compare geomagnetic and solar-wind changes with your model's assumptions.",
    public: "Check the NOAA aurora probability map, darkness, cloud cover, and local conditions. A modeled probability does not guarantee a visible aurora.",
  };
  const suffix = speed === null ? "" : ` Latest solar-wind speed is ${Math.round(speed)} km/s.`;
  const placeSuffix = state.location ? ` For ${state.location.name || "the selected location"} (${latitudeContext(Number(state.location.latitude))}, ${stampLocalTime(new Date(), false)} local), the altitude band is ${altitudeLabel()}. Geographic latitude is only a broad proxy for local effects.` : ` Times use ${browserTimeZone()} until you select a location.`;
  const current = state.localWeather?.current;
  const cloud = asNumber(current?.cloud_cover);
  const skySuffix = sector === "public" && state.localWeatherStatus === "ok" && current ? ` The local sky model reports ${weatherCodeLabel(current.weather_code).toLowerCase()}, ${cloud === null ? "cloud cover unavailable" : `${Math.round(cloud)}% cloud cover`}, and ${current.is_day === 0 ? "night" : "daylight"} now.` : "";
  return conditionsReady ? `${copy[sector] || copy.survey}${suffix}${placeSuffix}${skySuffix}` : "Live readings are still loading. Check NOAA SWPC for the current bulletin, then return here for a profile-specific summary.";
}

function updateSectorGuidance() {
  setLabel("#sector-guidance", guidanceForSector(state.sector));
}

function classifyProfession(profession) {
  const value = profession.toLowerCase();
  if (/pilot|aviat|airline|flight|aircrew|cabin crew|drone|uav|helicopter|air traffic/.test(value)) return "aviation";
  if (/survey|farmer|farm|agri|construction|geospatial|mapping|gnss|gps|delivery|logistics|driver|taxi|transport|mining/.test(value)) return "gnss";
  if (/\bradio\b|ham|maritime|mariner|ship|sailor|coast guard/.test(value)) return "radio";
  if (/electric|power|grid|utility|energy|transformer/.test(value)) return "power";
  if (/satellite|spacecraft|astronaut|space engineer|aerospace|orbital/.test(value)) return "space";
  if (/emergency|paramedic|firefighter|police|health|doctor|nurse|hospital|telecom|network|data center|it support|internet|bank|water treatment/.test(value)) return "essential";
  return "general";
}

function professionGuidance(kind, values) {
  const { gLevel, rLevel, sLevel, kp, hasGeomagnetic, hasScales, latitude, localDay } = values;
  const locationIsHighLatitude = latitude !== null && Math.abs(latitude) >= 55;
  if (kind === "gnss") {
    const impact = !hasGeomagnetic
      ? "NOAA's geomagnetic readings are still loading, so this check cannot assess the current GNSS context. During geomagnetic storms, satellite navigation can lose accuracy; local receiver performance also depends on the equipment, corrections, and conditions."
      : gLevel >= 1
        ? `The current global outlook is G${gLevel}${kp === null ? "" : ` (Kp ${kp.toFixed(1)})`}. During geomagnetic activity, GNSS accuracy can degrade, which may affect precision positioning, guidance, or route tracking. This global index cannot show the error at your receiver. Possible relevance is higher at ${locationIsHighLatitude ? "the selected higher geographic latitude" : "some locations and times"}, but geographic latitude is only a broad proxy.`
        : `The latest global geomagnetic reading is below NOAA's G1 threshold${kp === null ? "" : ` (Kp ${kp.toFixed(1)})`}. This does not indicate a geomagnetic storm impact right now, though it cannot guarantee local GNSS accuracy or rule out other causes of positioning errors.`;
    return { title: "Navigation and precision positioning", impact, actions: ["Check receiver status, correction age, and satellite geometry before relying on precision outputs.", "Compare with an independent position or known reference; flag questionable measurements and repeat them when conditions improve.", "Keep your normal non-GNSS fallback and follow equipment and workplace procedures if accuracy limits are exceeded."], life: "For your day-to-day work, the main pathway is possible navigation or positioning degradation. It does not mean your personal safety or equipment will be affected; use your normal verification and stop-work rules." };
  }
  if (kind === "aviation") {
    const effects = [];
    if (hasGeomagnetic && gLevel >= 1) effects.push(`the global geomagnetic outlook is G${gLevel}, which can coincide with degraded satellite navigation`);
    if (hasScales && rLevel >= 1) effects.push(`the global radio-blackout scale is R${rLevel}; HF effects are strongest on the sunlit side`);
    if (hasScales && sLevel >= 1) effects.push(`the global solar-radiation scale is S${sLevel}; NOAA describes possible radiation concerns for high-flying, high-latitude routes at some S levels`);
    const noEvents = [];
    if (hasGeomagnetic && gLevel === 0) noEvents.push("no G1-or-higher geomagnetic indicator");
    if (hasScales && rLevel === 0 && sLevel === 0) noEvents.push("no R-scale or S-scale event");
    const impact = effects.length
      ? `Current indicators include ${effects.join("; ")}. Relevance depends on the actual route, altitude, time, aircraft systems, and official aviation guidance. The selected ground location is not a route forecast.`
      : noEvents.length
        ? `Available global readings show ${noEvents.join(" and ")}. This does not assess a specific route or replace aviation advisories; localized navigation and radio conditions can vary.`
        : "NOAA's geomagnetic and solar scales are still loading. A route-specific impact cannot be assessed from this page.";
    return { title: "Navigation, communications, and flight context", impact, actions: ["Before duty or flight, check current SWPC bulletins and the aviation authority or operator route-specific advisory.", "Use approved navigation, communication, and radiation-monitoring procedures; keep required alternate systems available.", "Escalate GNSS, HF, or radiation concerns through dispatch and your established operating checklist. Do not change a route or duty plan based on this dashboard alone."], life: `Your selected altitude band is ${values.altitude}. It gives only broad context: this page cannot estimate a crew member's radiation dose, and a selected ground location does not identify a flight route.` };
  }
  if (kind === "radio") {
    const impact = !hasScales
      ? "NOAA's radio-blackout scale is still loading. Solar radio blackouts can degrade HF communication, especially on the sunlit side of Earth; local propagation also varies by frequency and path."
      : rLevel >= 1
        ? `The current global radio-blackout scale is R${rLevel}. NOAA associates R-scale events with HF disruption on the sunlit side. The selected location's local sky model indicates ${localDay || "daylight is unknown"}, but that alone cannot determine whether your radio path is affected; band, route, and event footprint matter.`
        : `NOAA currently reports no R-scale radio-blackout event. That does not guarantee a usable HF path; geomagnetic activity, frequency, location, and local conditions can still change propagation.`;
    return { title: "HF propagation and communications", impact, actions: ["Check the active NOAA R-scale bulletin and propagation conditions for your frequency and path.", "Test an alternate band, relay, or non-HF communication method before time-critical traffic.", "Record UTC/local time and observed signal changes, then use your station or organization’s communications plan."], life: "The likely effect is on communication availability for work or coordination, not a direct personal health effect. Keep emergency communications procedures available." };
  }
  if (kind === "power") {
    const impact = !hasGeomagnetic
      ? "NOAA's geomagnetic readings are still loading. Strong geomagnetic storms can induce currents in long conductors and affect power-grid operations; this page cannot observe local grid conditions."
      : gLevel >= 1
        ? `The global geomagnetic outlook is G${gLevel}${kp === null ? "" : ` (Kp ${kp.toFixed(1)})`}. NOAA notes that geomagnetic storms can affect grid operations. This is a broad indicator, not a measure of current, voltage, or equipment risk at your site.`
        : `The latest global geomagnetic reading is below NOAA's G1 threshold${kp === null ? "" : ` (Kp ${kp.toFixed(1)})`}. It does not indicate a geomagnetic storm level now; local grid telemetry remains the source for equipment and operating status.`;
    return { title: "Grid operations and power continuity", impact, actions: ["Use grid telemetry, alarms, and established geomagnetically induced current monitoring; this dashboard is not a substitute for them.", "Check the current SWPC bulletin and follow your utility’s approved escalation and protection procedures.", "Maintain normal continuity plans for communications and critical loads; do not make switching decisions from a global index alone."], life: "If a grid service is disrupted, homes and workplaces may also lose power or dependent services. The dashboard cannot predict an outage at your address; use local utility and emergency information." };
  }
  if (kind === "space") {
    const effects = [];
    if (hasScales && sLevel >= 1) effects.push(`NOAA's global solar-radiation scale is S${sLevel}, which can affect spacecraft electronics and operations at higher levels`);
    if (hasGeomagnetic && gLevel >= 1) effects.push(`the geomagnetic outlook is G${gLevel}; stronger storms can affect satellite navigation and increase drag on low-Earth-orbit objects`);
    const noEvents = [];
    if (hasGeomagnetic && gLevel === 0) noEvents.push("no G1-or-higher geomagnetic indicator");
    if (hasScales && sLevel === 0) noEvents.push("no S-scale solar-radiation event");
    const impact = effects.length
      ? `Current indicators include ${effects.join("; ")}. The app does not ingest spacecraft telemetry, orbital drag forecasts, or mission-specific risk.`
      : noEvents.length
        ? `Available global readings show ${noEvents.join(" and ")}. Spacecraft risk still depends on orbit, shielding, platform, and mission telemetry, which are not assessed here.`
        : "NOAA's geomagnetic and solar scales are still loading. This page has no spacecraft or mission telemetry.";
    return { title: "Spacecraft, satellite, and research operations", impact, actions: ["Compare NOAA scale products with mission-specific particle, charging, attitude, and spacecraft-health telemetry.", "For low-Earth-orbit work, consult the mission’s current density and drag products; this dashboard does not calculate orbital changes.", "Timestamp measurements and follow mission control or laboratory procedures before changing operations."], life: `Your selected altitude band is ${values.altitude}. It is only broad context; this page does not estimate dose, equipment susceptibility, or an individual mission outcome.` };
  }
  if (kind === "essential") {
    const dependencies = [];
    if (hasGeomagnetic && gLevel >= 1) dependencies.push(`geomagnetic outlook G${gLevel} may be relevant to GNSS or power dependencies`);
    if (hasScales && rLevel >= 1) dependencies.push(`R${rLevel} can disrupt HF communications in affected regions`);
    const noEvents = [];
    if (hasGeomagnetic && gLevel === 0) noEvents.push("no G1-or-higher geomagnetic indicator");
    if (hasScales && rLevel === 0) noEvents.push("no R-scale event");
    const impact = dependencies.length
      ? `Current global indicators: ${dependencies.join("; ")}. For your work, impacts are most likely to arrive through the navigation, power, or communications services you rely on; this page cannot assess your facility or local network.`
      : noEvents.length
        ? `Available current readings show ${noEvents.join(" and ")}. Space weather can still affect technology services, but this dashboard does not identify a disruption at your workplace.`
        : "Live NOAA scales are still loading. This page cannot assess your workplace systems or local service status.";
    return { title: "Essential services and technology dependencies", impact, actions: ["Check the status of your organization's power, communications, navigation, and backup services directly.", "Review continuity plans for backup power, alternate communications, and access to essential records.", "Follow official NOAA and local emergency bulletins plus your employer’s incident procedures."], life: "Possible effects would generally be indirect through services your work depends on. This tool does not assess a person's medical risk or predict local service outages." };
  }
  const impact = hasGeomagnetic || hasScales
    ? `Current global readings are ${hasGeomagnetic ? `Kp ${kp === null ? "unavailable" : kp.toFixed(1)} / G${gLevel}` : "geomagnetic data unavailable"}${hasScales ? `, R${rLevel} and S${sLevel}` : ", NOAA R/S scales unavailable"}. I could not match “${values.profession}” to a specific technology dependency, so I cannot give a job-specific impact estimate.`
    : `NOAA's live readings are still loading, and I could not match “${values.profession}” to a specific technology dependency. A job-specific impact estimate is not available yet.`;
  return { title: "General technology dependencies", impact, actions: ["Think about whether your work depends on satellite navigation, HF radio, satellite links, stable grid power, or time-sensitive data.", "Check those services directly and use your existing backup or continuity steps if a provider reports an issue.", "Enter a more specific role (for example, ‘farm surveyor’ or ‘HF radio operator’) for a closer match."], life: "For most people, space-weather effects reach daily life through technology services rather than a predicted personal effect. This app does not assess individual health risk." };
}

function renderProfessionImpact() {
  const report = $("#profession-report");
  if (!report || !state.professionAnalyzed) return;
  const empty = $("#profession-empty");
  if (empty) empty.hidden = true;
  const kpReading = currentKP();
  const kp = kpReading?.value ?? null;
  const hasScales = state.feedStatus.scales === "ok";
  const hasGeomagnetic = kp !== null || hasScales;
  const scaleEntry = gScaleEntry();
  const feedG = hasScales ? scaleValue(scaleEntry, "G") : null;
  const kpG = kp === null ? null : gScaleFromKp(kp);
  const gLevel = hasGeomagnetic ? Math.max(feedG ?? 0, kpG ?? 0) : null;
  const rLevel = hasScales ? scaleValue(scaleEntry, "R") : null;
  const sLevel = hasScales ? scaleValue(scaleEntry, "S") : null;
  const latitude = state.location ? Number(state.location.latitude) : null;
  const localDayValue = state.localWeatherStatus === "ok" ? state.localWeather?.current?.is_day : null;
  const localDay = localDayValue === 1 ? "daylight" : localDayValue === 0 ? "night" : null;
  const kind = classifyProfession(state.profession);
  const guidance = professionGuidance(kind, { profession: state.profession, kp, gLevel, rLevel, sLevel, hasGeomagnetic, hasScales, latitude, localDay, altitude: altitudeLabel() });
  const values = [];
  if (kp !== null) values.push(`Kp ${kp.toFixed(1)}`);
  if (hasScales) values.push(`G${gLevel ?? 0} · R${rLevel} · S${sLevel}`);
  setLabel("#profession-category", `${state.profession.toUpperCase()} · ${kind === "general" ? "GENERAL MATCH" : `${kind.toUpperCase()} DEPENDENCIES`}`);
  setLabel("#profession-result-title", guidance.title);
  setLabel("#profession-work-impact", guidance.impact);
  setLabel("#profession-life-impact", guidance.life);
  const status = $("#profession-status");
  if (status) {
    status.textContent = values.length ? (hasScales && kp !== null ? "LIVE READINGS" : "PARTIAL READINGS") : "DATA LOADING";
    status.classList.toggle("partial", !hasScales || kp === null);
  }
  const locationCopy = state.location
    ? `${state.location.name || "Selected location"} · ${latitudeContext(latitude)} · ${stampLocalTime(new Date(), false)} local (${activeTimeZone()})`
    : `No selected place · device time ${stampLocalTime(new Date(), false)} (${activeTimeZone()}); choose a location above for local context`;
  const nextPeak = next24HourKpPeak();
  const timingCopy = nextPeak
    ? `Next 24-hour NOAA forecast peak: Kp ${nextPeak.value.toFixed(1)} at ${stampLocalTime(nextPeak.time)} local.`
    : "Next 24-hour local forecast timing is unavailable.";
  const feedCopy = values.length ? `Global NOAA indicators: ${values.join(" · ")}.` : "NOAA indicators are not available yet.";
  const daylightCopy = localDay ? `The local weather model currently marks it as ${localDay}.` : "Local daylight context is unavailable.";
  setLabel("#profession-live-context", `${feedCopy} ${locationCopy}. Altitude profile: ${altitudeLabel()}. ${daylightCopy} ${timingCopy} NOAA scales and Kp are global readings; the selected location only adds broad latitude and time context.`);
  const actions = $("#profession-actions");
  if (actions) {
    actions.replaceChildren();
    guidance.actions.forEach((action) => { const item = document.createElement("li"); item.textContent = action; actions.append(item); });
  }
  const sources = $("#profession-sources");
  if (sources) {
    sources.replaceChildren();
    [
      ["NOAA space-weather impacts", "https://www.spaceweather.gov/impacts"],
      ["NOAA scale definitions", "https://www.spaceweather.gov/noaa-scales-explanation"],
    ].forEach(([label, href]) => { const link = document.createElement("a"); link.href = href; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = `${label} ↗`; sources.append(link); });
  }
  report.hidden = false;
}

function addEventRow({ source, type, time, title, body, url }) {
  const row = document.createElement("article");
  row.className = "event-row";
  const badge = document.createElement("span");
  badge.className = `event-type ${source === "NOAA" ? "noaa" : ""}`;
  badge.textContent = type;
  const meta = document.createElement("span");
  meta.className = "event-meta";
  const sourceLabel = document.createElement("strong"); sourceLabel.textContent = source;
  const dateLabel = document.createElement("small"); dateLabel.textContent = `${stampLocalTime(time, true)} local`;
  const utcLabel = document.createElement("small"); utcLabel.className = "event-utc"; utcLabel.textContent = stampTime(time, true);
  meta.append(sourceLabel, dateLabel, utcLabel);
  const copy = document.createElement("span"); copy.className = "event-copy"; copy.textContent = `${title ? `${title}: ` : ""}${body}`;
  const link = document.createElement("a"); link.className = "event-link"; link.href = url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "SOURCE ↗"; link.setAttribute("aria-label", `Open ${source} source`);
  row.append(badge, meta, copy, link);
  return row;
}

function renderEvents() {
  const list = $("#event-list");
  if (!list) return;
  list.replaceChildren();
  const events = [];
  if (state.feedStatus.nasa === "ok") {
    for (const event of state.nasaEvents) {
      const body = String(event.messageBody ?? event.message ?? event.summary ?? "NASA DONKI event report").replace(/\s+/g, " ").trim();
      events.push({
        source: "NASA", type: String(event.messageType ?? event.type ?? "DONKI").toUpperCase().slice(0, 6),
        time: parseTime(event.messageIssueTime ?? event.issueTime ?? event.time),
        title: event.messageID ?? event.messageType ?? "DONKI report", body: body.slice(0, 180),
        url: event.messageURL ?? event.messageBodyURL ?? "https://api.nasa.gov/",
      });
    }
  }
  if (state.feedStatus.noaaAlerts === "ok") {
    for (const alert of state.noaaAlerts) {
      const message = String(alert.message ?? alert.product_id ?? alert.product ?? "SWPC alert").replace(/\s+/g, " ").trim();
      const first = message.split(/[.!?]/)[0].slice(0, 76);
      events.push({ source: "NOAA", type: "SWPC", time: parseTime(alert.issue_datetime ?? alert.issue_time ?? alert.time_tag), title: alert.product_id ?? alert.message_type ?? "Official bulletin", body: message.slice(0, 180), url: "https://www.spaceweather.gov/products/alerts-watches-and-warnings" });
      if (!first) events.pop();
    }
  }
  events.sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0));
  if (!events.length) {
    const empty = document.createElement("div"); empty.className = "empty-row";
    empty.textContent = state.feedStatus.nasa === "error" && state.feedStatus.noaaAlerts === "error" ? "Event services are unavailable. Check the NASA and NOAA source links." : "No recent events were returned by the connected feeds.";
    list.append(empty);
  } else {
    events.slice(0, 5).forEach((event) => list.append(addEventRow(event)));
  }
  setLabel("#nasa-feed-label", state.feedStatus.nasa === "ok" ? `${state.nasaEvents.length} NASA DONKI records loaded` : "NASA DONKI unavailable · check key or quota");
  setLabel("#noaa-feed-label", state.feedStatus.noaaAlerts === "ok" ? `${state.noaaAlerts.length} NOAA SWPC bulletins loaded` : "NOAA alerts unavailable");
}

function maybeNotify(gLevel) {
  if (!state.settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const threshold = Number(state.settings.threshold || 1);
  if (gLevel < threshold) return;
  const key = `${new Date().toISOString().slice(0, 10)}-G${gLevel}`;
  if (localStorage.getItem("swg-last-notification") === key) return;
  localStorage.setItem("swg-last-notification", key);
  new Notification(`Space weather watch: G${gLevel}`, { body: `NOAA planetary conditions indicate ${scaleName(gLevel).toLowerCase()} geomagnetic activity. Check the current SWPC bulletin.` });
}

async function loadData() {
  const refresh = $("#refresh-btn");
  if (refresh) refresh.classList.add("spinning");
  state.kp = []; state.kpForecast = []; state.wind = null; state.magnetic = null;
  state.scales = null; state.noaaAlerts = []; state.nasaEvents = []; state.aurora = null;
  FEEDS.forEach((feed) => setFeed(feed, "loading"));
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateString = (date) => date.toISOString().slice(0, 10);
  const key = state.settings.nasaKey.trim() || "DEMO_KEY";
  const nasaUrl = `${NASA}/notifications?${new URLSearchParams({ startDate: dateString(since), endDate: dateString(now), type: "all", api_key: key })}`;
  const tasks = [
    ["kp", async () => {
      const [kp, forecast] = await Promise.allSettled([
        getJSON(`${NOAA}/json/planetary_k_index_1m.json`, "NOAA Kp"),
        getJSON(`${NOAA}/products/noaa-planetary-k-index-forecast.json`, "NOAA Kp forecast"),
      ]);
      if (kp.status === "fulfilled") state.kp = normalizeRows(kp.value);
      if (forecast.status === "fulfilled") state.kpForecast = normalizeRows(forecast.value);
      if (kp.status === "rejected" && forecast.status === "rejected") throw kp.reason;
    }],
    ["solar", async () => {
      const [wind, magnetic] = await Promise.allSettled([
        getJSON(`${NOAA}/products/summary/solar-wind-speed.json`, "NOAA solar wind speed"),
        getJSON(`${NOAA}/products/summary/solar-wind-mag-field.json`, "NOAA solar wind magnetic field"),
      ]);
      if (wind.status === "fulfilled") state.wind = normalizeRows(wind.value);
      if (magnetic.status === "fulfilled") state.magnetic = normalizeRows(magnetic.value);
      if (wind.status === "rejected" && magnetic.status === "rejected") throw wind.reason;
    }],
    ["scales", async () => { state.scales = await getJSON(`${NOAA}/products/noaa-scales.json`, "NOAA scales"); }],
    ["noaaAlerts", async () => { state.noaaAlerts = normalizeRows(await getJSON(`${NOAA}/products/alerts.json`, "NOAA alerts")); }],
    ["nasa", async () => { state.nasaEvents = normalizeRows(await getJSON(nasaUrl, "NASA DONKI")); }],
    ["aurora", async () => { state.aurora = await getJSON(`${NOAA}/json/ovation_aurora_latest.json`, "NOAA aurora model"); }],
  ];
  const results = await Promise.allSettled(tasks.map(([, task]) => task()));
  results.forEach((result, index) => {
    const [feed] = tasks[index];
    setFeed(feed, result.status === "fulfilled" ? "ok" : "error");
    if (result.status === "rejected") console.warn(`${feed} feed failed:`, result.reason?.message || result.reason);
  });
  state.lastSync = new Date();
  setLabel("#updated-at", stampLocalTime(state.lastSync, false));
  state.nearestAuroraCache = null;
  updateDashboard();
  renderEvents();
  if (state.location && state.localWeatherStatus !== "loading") loadLocalConditions(state.location);
  if (refresh) refresh.classList.remove("spinning");
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function updateAssistant(question) {
  const query = question.toLowerCase();
  const kp = currentKP()?.value ?? null;
  const wind = latestReading(state.wind, "proton_speed") || latestReading(state.wind, "speed");
  const speed = wind ? asNumber(wind.row.proton_speed ?? wind.row.speed) : null;
  const gLevel = Math.max(kp === null ? 0 : gScaleFromKp(kp), scaleValue(gScaleEntry(), "G"));
  const rLevel = scaleValue(gScaleEntry(), "R");
  const sLevel = scaleValue(gScaleEntry(), "S");
  let answer;
  if (/radiation|altitude|flight level|dose|solar proton/.test(query)) {
    answer = `NOAA's global scales currently show R${rLevel} and S${sLevel}. The selected profile is ${altitudeLabel()} (${altitudeContext().toLowerCase()})${state.location ? ` near ${state.location.name || "the selected location"} at ${latitudeContext(Number(state.location.latitude))}` : ""}. Altitude and latitude provide broad context only; this dashboard does not estimate radiation dose. Follow current official advisories.`;
  } else if (/when|time|local/.test(query)) {
    const peak = next24HourKpPeak();
    answer = peak ? `The highest predicted planetary Kp in the next 24 hours is ${peak.value.toFixed(1)} at ${stampLocalTime(peak.time)} local (${stampTime(peak.time)}). This is a global NOAA forecast shown in ${activeTimeZone()}; it is not a location-specific storm forecast.` : "The NOAA 3-hour Kp forecast is unavailable for the next 24 hours. Event timestamps are shown in the selected location's time zone when available, with UTC alongside.";
  } else if (/gps|gnss|navigation|position/.test(query)) {
    answer = kp === null ? "The latest Kp reading is unavailable. Check NOAA's official bulletin before relying on a live summary." : gLevel >= 1 ? `The latest Kp is ${kp.toFixed(1)} (G${gLevel} level). Geomagnetic activity can affect navigation accuracy, but local GNSS performance depends on the receiver and conditions. Verify corrections and independent position checks.` : `The latest Kp is ${kp.toFixed(1)}, below NOAA's G1 storm threshold. Keep normal receiver and correction checks in place; this index alone does not guarantee local GPS performance.`;
  } else if (/radio|hf|ham|propagat/.test(query)) {
    answer = rLevel > 0 ? `NOAA reports an R${rLevel} radio blackout scale level. Review the official SWPC bulletin and band-specific conditions before relying on HF for time-critical traffic.` : "The current NOAA R scale shows no radio blackout level. HF propagation can still vary by band and location, so check propagation conditions for critical links.";
  } else if (/power|grid|electric|current surge/.test(query)) {
    answer = gLevel >= 1 ? `NOAA's current outlook is G${gLevel} (${scaleName(gLevel).toLowerCase()}). Geomagnetic activity can induce currents in long conductors; power operators should follow their own telemetry and standard operating procedures.` : "The current geomagnetic reading is below the NOAA G1 storm threshold. Power operators should continue standard monitoring and use their established operational procedures.";
  } else if (/weather|cloud|sky conditions/.test(query)) {
    const current = state.localWeather?.current;
    if (!state.location) answer = "Choose or detect a location first to fetch local cloud and visibility conditions.";
    else if (!current) answer = "Local weather data is still loading or unavailable. Use Refresh, or try the Open-Meteo source shown in the location card.";
    else {
      const cloud = asNumber(current.cloud_cover);
      const visibility = asNumber(current.visibility);
      answer = `${state.location.name || "The selected location"}: ${weatherCodeLabel(current.weather_code).toLowerCase()}, ${cloud === null ? "cloud cover unavailable" : `${Math.round(cloud)}% cloud cover`}, ${visibility === null ? "visibility unavailable" : `${(visibility / 1000).toFixed(1)} km visibility`}, and ${current.is_day === 0 ? "night" : current.is_day === 1 ? "daylight" : "daylight unavailable"} in the local model. This helps judge aurora viewing conditions but is not a guarantee of visibility.`;
    }
  } else if (/aurora|northern light|visibility/.test(query)) {
    const latitude = computeAuroraLatitude();
    const local = nearestAuroraAtLocation();
    const current = state.localWeather?.current;
    const cloud = asNumber(current?.cloud_cover);
    const sky = current ? ` Local weather model: ${cloud === null ? "cloud cover unavailable" : `${Math.round(cloud)}% cloud cover`}, ${current.is_day === 0 ? "night" : "daylight"} now.` : " Local sky model is unavailable.";
    answer = latitude === null ? "The latest NOAA OVATION model is unavailable. Check the official model, then consider local darkness and cloud cover." : `The NOAA OVATION model currently shows ≥20% probability reaching about ${latitude.toFixed(0)}° ${state.hemisphere === "north" ? "N" : "S"} in this polar view${local && state.location ? `. At ${state.location.name || "your selected location"}, the nearest model grid cell is ${Math.round(local.probability)}% about ${Math.round(local.distanceKm)} km away` : ""}. This grid value is not a site forecast or guarantee of visible aurora; darkness and cloud cover matter.${state.location ? sky : ""}`;
  } else {
    answer = kp === null ? "Live NOAA readings are not available yet. Check the official SWPC alerts page for current conditions." : `The latest planetary reading is Kp ${kp.toFixed(1)}${speed === null ? "" : `, with solar-wind speed near ${Math.round(speed)} km/s`}. ${gLevel > 0 ? `NOAA's geomagnetic scale is G${gLevel} (${scaleName(gLevel).toLowerCase()}).` : "This is below NOAA's G1 storm threshold."} These are observed values, not a prediction of local service disruption.`;
  }
  const localContext = state.location ? ` Selected profile: ${state.location.name || "custom coordinates"}; ${latitudeContext(Number(state.location.latitude))}; local time ${stampLocalTime(new Date(), false)}; altitude ${altitudeLabel()}.` : ` Select a location for local timing and geographic context; current time zone is ${activeTimeZone()}.`;
  setLabel("#assistant-answer", `${answer}${localContext}`);
  const available = FEEDS.filter((feed) => state.feedStatus[feed] === "ok").length;
  setLabel("#assistant-source", `Rule-based summary · ${available}/${FEEDS.length} official feed groups available · check NOAA/NASA source bulletins`);
}

function initSettings() {
  const dialog = $("#settings-dialog");
  $("#settings-btn")?.addEventListener("click", () => {
    $("#nasa-key").value = state.settings.nasaKey || "";
    $("#threshold-select").value = state.settings.threshold || "1";
    $("#notifications-toggle").checked = Boolean(state.settings.notifications);
    dialog.showModal();
  });
  $("#close-settings")?.addEventListener("click", () => dialog.close());
  $("#clear-key")?.addEventListener("click", () => { $("#nasa-key").value = ""; });
  $("#settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const wantsNotifications = $("#notifications-toggle").checked;
    if (wantsNotifications && "Notification" in window && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        $("#notifications-toggle").checked = false;
        state.settings.notifications = false;
        showToast("Browser notification permission was not granted.");
      }
    } else if (wantsNotifications && !("Notification" in window)) {
      $("#notifications-toggle").checked = false;
      showToast("This browser does not support notifications.");
    }
    state.settings = {
      nasaKey: $("#nasa-key").value.trim(),
      threshold: $("#threshold-select").value,
      notifications: $("#notifications-toggle").checked && "Notification" in window && Notification.permission === "granted",
    };
    saveSettings();
    dialog.close();
    showToast("Preferences saved in this browser.");
    loadData();
  });
}

function requestBrowserLocation({ automatic = false } = {}) {
  if (!window.isSecureContext) {
    setLabel("#location-title", "Secure location access required");
    setLabel("#location-coordinates", "Chrome location access works on HTTPS sites and localhost.");
    setLabel("#location-message", "Open the dashboard through HTTPS or localhost, then allow Location in Chrome site controls.");
    return;
  }
  if (!navigator.geolocation) {
    setLabel("#location-title", "Browser location is unavailable");
    setLabel("#location-coordinates", "This browser does not provide location access. Search for a city or enter coordinates.");
    setLabel("#location-message", "Browser location is unavailable. Choose a city or enter coordinates instead.");
    return;
  }
  const requestId = ++state.locationRequestId;
  const button = $("#use-location");
  if (!automatic && button) button.disabled = true;
  setLabel("#location-title", "Finding your live location…");
  setLabel("#location-coordinates", "Allow Chrome's location prompt. If blocked, use the site controls beside the address bar.");
  setLabel("#location-message", "Waiting for the browser location permission and device fix…");
  navigator.geolocation.getCurrentPosition((position) => {
    if (requestId !== state.locationRequestId || (automatic && state.location)) return;
    const { latitude, longitude, accuracy } = position.coords;
    setLocationProfile({ name: "My live location", latitude, longitude, accuracy, timezone: browserTimeZone(), timezoneSource: "device time zone" }, "Live browser location selected. Local weather and time zone are now being fetched for these coordinates.");
    if (button) button.disabled = false;
  }, (error) => {
    if (requestId !== state.locationRequestId) return;
    const message = error.code === 1
      ? "Chrome blocked location. Open the site controls beside the address bar, allow Location, then try again; city search and manual coordinates still work."
      : error.code === 3
        ? "The device location timed out. Try again, check Windows Location Services, or choose a city."
        : "The device could not determine a location. Check Windows Location Services, then try again or choose a city.";
    setLabel("#location-title", "Location permission or device fix needed");
    setLabel("#location-coordinates", "Allow Location for this localhost site in Chrome, or use the city search / coordinate form.");
    setLabel("#location-message", message);
    if (button) button.disabled = false;
  }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 });
}

function initLocationControls() {
  $("#location-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("#location-search").value.trim();
    const results = $("#location-results");
    if (results) { results.replaceChildren(); results.hidden = true; }
    searchLocations(query);
  });
  $("#location-search")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { $("#location-results").hidden = true; }
  });
  $("#use-location")?.addEventListener("click", () => {
    requestBrowserLocation();
  });
  $("#coordinates-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const timezone = $("#timezone-input").value.trim();
    if (timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
      catch { setLabel("#location-message", "That time zone name is not recognized. Use an IANA name such as Europe/London."); return; }
    }
    setLocationProfile({
      name: "Custom coordinates",
      latitude: $("#latitude-input").value,
      longitude: $("#longitude-input").value,
      timezone: timezone || undefined,
      timezoneSource: timezone ? "manual time zone" : "device time zone",
    }, "Custom coordinates selected. The local impact context is calculated in this tab.");
  });
  $("#altitude-select")?.addEventListener("change", (event) => {
    state.altitude = ["low", "mid", "high"].includes(event.target.value) ? event.target.value : "low";
    try { sessionStorage.setItem("swg-altitude", state.altitude); } catch { }
    updateDashboard();
  });
  $("#clear-location")?.addEventListener("click", () => {
    state.location = null;
    state.locationRequestId += 1;
    state.localWeatherRequestId += 1;
    state.localWeather = null;
    state.localWeatherStatus = "idle";
    state.nearestAuroraCache = null;
    state.hemisphere = "north";
    state.globe.latitude = 65; state.globe.longitude = -80; state.globe.zoom = 1; state.globe.hover = null;
    try { sessionStorage.removeItem("swg-location"); } catch { }
    $("#location-search").value = "";
    $("#latitude-input").value = "";
    $("#longitude-input").value = "";
    $("#timezone-input").value = "";
    $("#location-results").replaceChildren();
    $("#location-results").hidden = true;
    $$(".hemisphere-toggle button").forEach((button) => button.classList.toggle("active", button.dataset.hemisphere === "north"));
    updateDashboard();
    updateLocalWeatherPanel();
    setLabel("#location-title", "Use live location or choose a place");
    setLabel("#location-coordinates", "Allow the browser location prompt first, or search / enter a place below.");
    renderEvents();
    setLabel("#location-message", "Location cleared from this tab. Times now use the device time zone.");
  });
}

function initInteractions() {
  $("#refresh-btn")?.addEventListener("click", loadData);
  initLocationControls();
  initGlobeControls();
  $("#profession-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const profession = $("#profession-input")?.value.trim().slice(0, 80);
    if (!profession) return;
    state.profession = profession;
    state.professionAnalyzed = true;
    renderProfessionImpact();
  });
  $("#sources-btn")?.addEventListener("click", () => document.querySelector(".page-footer")?.scrollIntoView({ behavior: "smooth" }));
  $("#sector-select")?.addEventListener("change", (event) => { state.sector = event.target.value; updateSectorGuidance(); });
  $$(".audience-table button[data-profile]").forEach((button) => button.addEventListener("click", () => {
    state.sector = button.dataset.profile;
    $("#sector-select").value = state.sector;
    updateSectorGuidance();
    $("#impact").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $$(".hemisphere-toggle button").forEach((button) => button.addEventListener("click", () => {
    state.hemisphere = button.dataset.hemisphere;
    state.globe.latitude = state.hemisphere === "north" ? 65 : -65;
    state.globe.hover = null;
    $$(".hemisphere-toggle button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    drawAuroraMap(); updateDashboard();
  }));
  $("#chart-window")?.addEventListener("click", (event) => {
    state.chartWindow = state.chartWindow === 24 ? 72 : 24;
    event.currentTarget.innerHTML = `${state.chartWindow} hours <span>⌄</span>`;
    drawKpChart();
  });
  $("#assistant-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#assistant-question");
    if (!input.value.trim()) return;
    updateAssistant(input.value.trim()); input.value = "";
  });
  $$(".prompt-chips button").forEach((button) => button.addEventListener("click", () => updateAssistant(button.dataset.question)));
  $("#nasa-key")?.addEventListener("keydown", (event) => { if (event.key === "Escape") $("#settings-dialog").close(); });
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawKpChart(); drawAuroraMap(); }, 120); });
  const links = $$(".nav-link");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      links.forEach((link) => link.classList.toggle("active", link.hash === `#${entry.target.id}`));
    }), { rootMargin: "-20% 0px -68% 0px" });
    links.forEach((link) => { if (!link.hash) return; const section = document.querySelector(link.hash); if (section) observer.observe(section); });
  }
}

function boot() {
  if (state.location) {
    state.hemisphere = Number(state.location.latitude) < 0 ? "south" : "north";
    state.globe.latitude = state.hemisphere === "north" ? 65 : -65;
    state.globe.longitude = Number(state.location.longitude);
  }
  if (["#capabilities", "#field-guide", "#architecture", "#roadmap"].includes(window.location.hash)) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}#overview`);
    window.scrollTo({ top: 0, behavior: "auto" });
  }
  initSettings();
  initInteractions();
  updateLocationPanel();
  if (state.location) setLabel("#location-message", "Location profile active. Geographic latitude is a broad proxy, not geomagnetic latitude; actual effects also depend on local time, event type, and equipment.");
  $$(".hemisphere-toggle button").forEach((button) => button.classList.toggle("active", button.dataset.hemisphere === state.hemisphere));
  updateCoverage();
  loadData();
  if (state.location) {
    loadLocalConditions(state.location);
  } else {
    let requestedThisTab = false;
    try {
      requestedThisTab = sessionStorage.getItem("swg-location-prompted") === "1";
      if (!requestedThisTab) sessionStorage.setItem("swg-location-prompted", "1");
    } catch { }
    if (!requestedThisTab) setTimeout(() => { if (!state.location) requestBrowserLocation({ automatic: true }); }, 350);
  }
  setInterval(() => { updateLocationClock(); updateLocalImpactContext(); updateSectorGuidance(); renderProfessionImpact(); }, 30000);
  setInterval(loadData, 5 * 60 * 1000);
}

boot();
