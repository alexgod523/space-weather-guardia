const NOAA_ROOT = "https://services.swpc.noaa.gov";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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

const state = {
  layer: "radio",
  scales: { R: null, G: null, S: null },
  kp: null,
  kpTime: null,
  xray: null,
  xrayTime: null,
  feedOk: { scales: false, kp: false, xray: false },
  loading: false,
  updatedAt: null,
  globe: { latitude: 15, longitude: 10, zoom: 1, dragging: false, lastX: 0, lastY: 0 },
  hoverPoint: null,
  pinnedPoint: null,
};

function asNumber(value) {
  if (value === null || value === undefined || value === "" || value === "NaN") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTime(value) {
  if (!value) return null;
  let normalized = String(value).trim();
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(normalized)) normalized = normalized.replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(normalized)) normalized += "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRows(payload) {
  if (!Array.isArray(payload)) return [];
  if (payload.length && Array.isArray(payload[0])) {
    const headings = payload[0].map((heading) => String(heading).trim());
    return payload.slice(1).map((row) => Object.fromEntries(headings.map((heading, index) => [heading, row[index]])));
  }
  return payload;
}

async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function scaleEntry(payload) {
  if (!payload) return null;
  return payload["0"] || payload[0] || payload;
}

function readScale(payload, name) {
  const entry = scaleEntry(payload);
  const value = asNumber(entry?.[name]?.Scale ?? entry?.[name]?.scale ?? entry?.[name]);
  return value === null ? null : Math.max(0, Math.min(5, Math.round(value)));
}

function deriveGFromKp(kp) {
  if (kp === null) return null;
  if (kp >= 9) return 5;
  if (kp >= 8) return 4;
  if (kp >= 7) return 3;
  if (kp >= 6) return 2;
  if (kp >= 5) return 1;
  return 0;
}

function scaleName(level, kind) {
  if (level === null) return "unavailable";
  if (kind === "R") return ["No blackout", "Minor", "Moderate", "Strong", "Severe", "Extreme"][level];
  if (kind === "G") return ["Below G1", "Minor", "Moderate", "Strong", "Severe", "Extreme"][level];
  return ["No event", "Minor", "Moderate", "Strong", "Severe", "Extreme"][level];
}

function currentKp(payload) {
  const rows = normalizeRows(payload).map((row) => ({ row, time: parseTime(row.time_tag ?? row.time), value: asNumber(row.Kp ?? row.kp) }))
    .filter((item) => item.time && item.value !== null)
    .sort((a, b) => b.time - a.time);
  return rows[0] || null;
}

function currentXray(payload) {
  const rows = normalizeRows(payload).map((row) => ({ row, time: parseTime(row.time_tag ?? row.time), flux: asNumber(row.flux) }))
    .filter((item) => item.time && item.flux !== null && item.flux > 0 && (!item.row.energy || String(item.row.energy).includes("0.1-0.8")))
    .sort((a, b) => b.time - a.time);
  if (!rows.length) return null;
  const reading = rows[0];
  const bands = [[1e-4, "X"], [1e-5, "M"], [1e-6, "C"], [1e-7, "B"], [1e-8, "A"]];
  const [threshold, letter] = bands.find(([minimum]) => reading.flux >= minimum) || [1e-8, "A"];
  return { className: `${letter}${(reading.flux / threshold).toFixed(1)}`, flux: reading.flux, time: reading.time };
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function updateFeedStatus() {
  const okay = Object.values(state.feedOk).filter(Boolean).length;
  const total = Object.keys(state.feedOk).length;
  const status = $("#global-feed-status");
  if (status) {
    status.querySelector("span").textContent = state.loading ? "Connecting to NOAA feeds" : okay ? `${okay} of ${total} NOAA feeds connected` : "NOAA feeds unavailable";
    status.classList.toggle("offline", !state.loading && okay === 0);
  }
  const empty = $("#global-map-empty");
  if (empty) {
    empty.textContent = state.loading ? "Loading live NOAA readings…" : "Live NOAA readings are not available. Refresh or check the source links below.";
    empty.hidden = state.loading ? Boolean(state.updatedAt) : okay !== 0;
  }
}

function updateMetricCards() {
  const r = state.scales.R, g = state.scales.G ?? deriveGFromKp(state.kp), s = state.scales.S;
  setText("#global-xray", state.xray?.className || (state.feedOk.xray ? "Below B1" : "—"));
  setText("#global-xray-time", state.xray ? `GOES · ${state.xray.time.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })} UTC` : state.feedOk.xray ? "GOES · no recent measurable flare" : "GOES X-ray feed unavailable");
  setText("#global-r", state.feedOk.scales && r !== null ? `R${r}` : "R—");
  setText("#global-r-name", state.feedOk.scales && r !== null ? `NOAA R scale · ${scaleName(r, "R")}` : "NOAA R scale · unavailable");
  setText("#global-g", g === null ? "G—" : `G${g}`);
  setText("#global-g-name", g === null ? "Kp / NOAA G scale · feed unavailable" : `NOAA G scale · ${scaleName(g, "G")}${state.kp === null ? "" : ` · Kp ${state.kp.toFixed(1)}`}`);
  setText("#global-s", state.feedOk.scales && s !== null ? `S${s}` : "S—");
  setText("#global-s-name", state.feedOk.scales && s !== null ? `NOAA S scale · ${scaleName(s, "S")}` : "NOAA S scale · unavailable");
  setText("#global-updated", state.updatedAt ? `${state.updatedAt.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })} UTC` : "Waiting for first reading");
}

async function refreshData() {
  const button = $("#global-refresh");
  if (button) button.classList.add("spinning");
  state.loading = true;
  state.feedOk = { scales: false, kp: false, xray: false };
  updateFeedStatus();
  const results = await Promise.allSettled([
    getJSON(`${NOAA_ROOT}/products/noaa-scales.json`),
    getJSON(`${NOAA_ROOT}/json/planetary_k_index_1m.json`),
    getJSON(`${NOAA_ROOT}/json/goes/primary/xrays-1-day.json`),
  ]);
  if (results[0].status === "fulfilled") {
    const payload = results[0].value;
    state.scales = { R: readScale(payload, "R"), G: readScale(payload, "G"), S: readScale(payload, "S") };
    state.feedOk.scales = true;
  } else state.scales = { R: null, G: null, S: null };
  if (results[1].status === "fulfilled") {
    const reading = currentKp(results[1].value);
    state.kp = reading?.value ?? null; state.kpTime = reading?.time ?? null; state.feedOk.kp = true;
  } else { state.kp = null; state.kpTime = null; }
  if (results[2].status === "fulfilled") {
    state.xray = currentXray(results[2].value); state.xrayTime = state.xray?.time ?? null; state.feedOk.xray = true;
  } else { state.xray = null; state.xrayTime = null; }
  state.loading = false;
  state.updatedAt = new Date();
  updateMetricCards(); updateFeedStatus(); drawGlobalGlobe();
  if (state.hoverPoint) renderInspector(state.hoverPoint, false);
  else if (state.pinnedPoint) renderInspector(state.pinnedPoint, true);
  else clearInspector();
  if (button) button.classList.remove("spinning");
}

function solarGeometry(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const gamma = (2 * Math.PI / 365) * (day - 1 + (utcHours - 12) / 24);
  const declination = .006918 - .399912 * Math.cos(gamma) + .070257 * Math.sin(gamma) - .006758 * Math.cos(2 * gamma) + .000907 * Math.sin(2 * gamma) - .002697 * Math.cos(3 * gamma) + .00148 * Math.sin(3 * gamma);
  const equationOfTime = 229.18 * (.000075 + .001868 * Math.cos(gamma) - .032077 * Math.sin(gamma) - .014615 * Math.cos(2 * gamma) - .040849 * Math.sin(2 * gamma));
  const subsolarLongitude = ((12 - utcHours - equationOfTime / 60) * 15 + 540) % 360 - 180;
  return { declination, equationOfTime, subsolarLongitude };
}

function solarAltitudeFactor(latitude, longitude, solar = solarGeometry()) {
  const rad = Math.PI / 180;
  const lat = latitude * rad, decl = solar.declination;
  const hourAngle = (longitude - solar.subsolarLongitude) * rad;
  return Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
}

function localSolarTime(longitude, date = new Date(), solar = solarGeometry()) {
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const hours = ((utc + longitude / 15 + solar.equationOfTime / 60) % 24 + 24) % 24;
  const whole = Math.floor(hours), minutes = Math.floor((hours - whole) * 60);
  return `${String(whole).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function impactAt(latitude, longitude, solar = solarGeometry()) {
  const daylight = solarAltitudeFactor(latitude, longitude, solar) > -.08;
  const polar = Math.max(0, Math.min(1, (Math.abs(latitude) - 30) / 48));
  if (state.layer === "radio") {
    if (!state.feedOk.scales || state.scales.R === null) return { level: "unavailable", score: null, daylight };
    if (!daylight) return { level: "night", score: .03, daylight };
    const level = state.scales.R ?? 0;
    const score = level >= 3 ? .8 + .04 * (level - 3) : level === 2 ? .54 : level === 1 ? .22 : .08;
    return { level: score >= .67 ? "high" : score >= .34 ? "moderate" : "low", score, daylight, scale: level };
  }
  if (state.layer === "geomagnetic") {
    const globalG = state.scales.G ?? deriveGFromKp(state.kp);
    if (globalG === null) return { level: "unavailable", score: null, daylight };
    const score = globalG / 5 * (.55 + .45 * polar);
    return { level: score >= .67 ? "high" : score >= .34 ? "moderate" : "low", score, daylight, scale: globalG, polar };
  }
  if (!state.feedOk.scales || state.scales.S === null) return { level: "unavailable", score: null, daylight };
  const level = state.scales.S ?? 0;
  const score = level / 5 * (.15 + .85 * polar);
  return { level: score >= .67 ? "high" : score >= .34 ? "moderate" : "low", score, daylight, scale: level, polar };
}

function impactColor(result) {
  if (result.level === "unavailable") return "rgba(151,164,178,.2)";
  if (result.level === "night") return "rgba(5,12,22,.42)";
  if (result.level === "high") return `rgba(228,67,58,${.16 + result.score * .22})`;
  if (result.level === "moderate") return `rgba(239,190,59,${.17 + result.score * .2})`;
  return `rgba(42,195,132,${.13 + (result.score || 0) * .2})`;
}

function globeRadius(width, height) {
  return Math.min(width * .43, height * .46) * state.globe.zoom;
}

function projectPoint(longitude, latitude, cx, cy, radius) {
  const rad = Math.PI / 180;
  const lat = latitude * rad, lon = longitude * rad;
  const centerLat = state.globe.latitude * rad, centerLon = state.globe.longitude * rad;
  const delta = lon - centerLon;
  const x = Math.cos(lat) * Math.sin(delta);
  const y = Math.cos(centerLat) * Math.sin(lat) - Math.sin(centerLat) * Math.cos(lat) * Math.cos(delta);
  const z = Math.sin(centerLat) * Math.sin(lat) + Math.cos(centerLat) * Math.cos(lat) * Math.cos(delta);
  return { x: cx + radius * x, y: cy - radius * y, z };
}

function traceCurve(ctx, coordinates, cx, cy, radius) {
  ctx.beginPath(); let drawing = false;
  for (const [longitude, latitude] of coordinates) {
    const point = projectPoint(longitude, latitude, cx, cy, radius);
    if (point.z > .015) { if (!drawing) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); drawing = true; }
    else drawing = false;
  }
  ctx.stroke();
}

function drawLand(ctx, cx, cy, radius) {
  for (const shape of LAND_SHAPES) {
    const points = shape.map(([longitude, latitude]) => projectPoint(longitude, latitude, cx, cy, radius));
    const visible = points.filter((point) => point.z > .02);
    if (visible.length < 2) continue;
    if (visible.length === points.length) {
      ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y)); ctx.closePath();
      ctx.fillStyle = "rgba(48,94,106,.76)"; ctx.fill(); ctx.strokeStyle = "rgba(127,181,178,.26)"; ctx.lineWidth = .75; ctx.stroke();
    } else {
      ctx.beginPath(); let drawing = false;
      points.forEach((point) => { if (point.z > .02) { if (!drawing) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); drawing = true; } else drawing = false; });
      ctx.strokeStyle = "rgba(127,181,178,.22)"; ctx.lineWidth = .75; ctx.stroke();
    }
  }
}

function drawTerminator(ctx, cx, cy, radius, solar) {
  ctx.save(); ctx.strokeStyle = "rgba(218,232,225,.55)"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
  for (const direction of [-1, 1]) {
    const coordinates = [];
    for (let latitude = -88; latitude <= 88; latitude += 2) {
      const angle = -Math.tan(latitude * Math.PI / 180) * Math.tan(solar.declination);
      if (Math.abs(angle) > 1) continue;
      const hourAngle = Math.acos(angle) * 180 / Math.PI;
      coordinates.push([solar.subsolarLongitude + direction * hourAngle, latitude]);
    }
    traceCurve(ctx, coordinates, cx, cy, radius);
  }
  ctx.restore();
}

function drawImpactCells(ctx, cx, cy, radius, solar) {
  const cellRadius = Math.max(2.4, radius * Math.PI / 180 * 3.15);
  for (let latitude = -82; latitude <= 82; latitude += 4) {
    for (let longitude = -180; longitude < 180; longitude += 4) {
      const point = projectPoint(longitude, latitude, cx, cy, radius);
      if (point.z <= .01) continue;
      const impact = impactAt(latitude, longitude, solar);
      ctx.beginPath(); ctx.arc(point.x, point.y, cellRadius, 0, Math.PI * 2);
      ctx.fillStyle = impactColor(impact); ctx.fill();
    }
  }
}

function drawGlobalGlobe() {
  const canvas = $("#global-impact-globe");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width, height = rect.height, cx = width / 2, cy = height / 2, radius = globeRadius(width, height);
  const solar = solarGeometry();
  ctx.clearRect(0, 0, width, height);
  for (let index = 0; index < 82; index++) {
    const x = ((index * 83.31) % 991) / 991 * width, y = ((index * 57.13 + 17) % 983) / 983 * height;
    ctx.fillStyle = `rgba(181,207,222,${.1 + (index % 3) * .06})`; ctx.fillRect(x, y, index % 11 === 0 ? 1.5 : 1, index % 11 === 0 ? 1.5 : 1);
  }
  const atmosphere = ctx.createRadialGradient(cx, cy, radius * .89, cx, cy, radius * 1.13);
  atmosphere.addColorStop(0, "rgba(61,153,193,.015)"); atmosphere.addColorStop(.72, "rgba(66,179,213,.2)"); atmosphere.addColorStop(1, "rgba(53,125,174,0)");
  ctx.beginPath(); ctx.arc(cx, cy, radius * 1.13, 0, Math.PI * 2); ctx.fillStyle = atmosphere; ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
  const ocean = ctx.createRadialGradient(cx - radius * .32, cy - radius * .42, radius * .04, cx, cy, radius * 1.1);
  ocean.addColorStop(0, "#20536e"); ocean.addColorStop(.48, "#12344a"); ocean.addColorStop(1, "#06111d");
  ctx.fillStyle = ocean; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  const shade = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  shade.addColorStop(0, "rgba(115,195,207,.1)"); shade.addColorStop(.5, "rgba(7,19,31,0)"); shade.addColorStop(1, "rgba(1,7,15,.58)");
  ctx.fillStyle = shade; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  drawLand(ctx, cx, cy, radius);
  ctx.strokeStyle = "rgba(134,184,204,.16)"; ctx.lineWidth = .7;
  for (const latitude of [-60, -30, 0, 30, 60]) {
    const line = []; for (let longitude = -180; longitude <= 180; longitude += 3) line.push([longitude, latitude]);
    traceCurve(ctx, line, cx, cy, radius);
  }
  for (let longitude = -180; longitude < 180; longitude += 30) {
    const line = []; for (let latitude = -90; latitude <= 90; latitude += 3) line.push([longitude, latitude]);
    traceCurve(ctx, line, cx, cy, radius);
  }
  drawImpactCells(ctx, cx, cy, radius, solar);
  if (state.layer === "radio") drawTerminator(ctx, cx, cy, radius, solar);
  const sunPoint = projectPoint(solar.subsolarLongitude, solar.declination * 180 / Math.PI, cx, cy, radius);
  if (sunPoint.z > 0) {
    ctx.beginPath(); ctx.arc(sunPoint.x, sunPoint.y, 5.5, 0, Math.PI * 2); ctx.fillStyle = "#ffe49a"; ctx.fill();
    ctx.beginPath(); ctx.arc(sunPoint.x, sunPoint.y, 10, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,218,127,.5)"; ctx.lineWidth = 1.4; ctx.stroke();
  }
  if (state.pinnedPoint) {
    const marker = projectPoint(state.pinnedPoint.longitude, state.pinnedPoint.latitude, cx, cy, radius);
    if (marker.z > 0) {
      ctx.beginPath(); ctx.arc(marker.x, marker.y, 8, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,227,164,.38)"; ctx.lineWidth = 4; ctx.stroke();
      ctx.beginPath(); ctx.arc(marker.x, marker.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#fff2ce"; ctx.fill();
    }
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = "rgba(127,202,225,.56)"; ctx.lineWidth = 1.2; ctx.stroke();
  setText("#global-subsolar", `Subsolar point · ${Math.abs(solar.declination * 180 / Math.PI).toFixed(1)}°${solar.declination >= 0 ? "N" : "S"}, ${Math.abs(solar.subsolarLongitude).toFixed(1)}°${solar.subsolarLongitude >= 0 ? "E" : "W"} · ${localSolarTime(solar.subsolarLongitude, new Date(), solar)} solar time`);
}

function screenToGeo(x, y, width, height) {
  const radius = globeRadius(width, height);
  const sx = (x - width / 2) / radius, sy = (height / 2 - y) / radius;
  const squared = sx * sx + sy * sy;
  if (squared > 1) return null;
  const depth = Math.sqrt(1 - squared), rad = Math.PI / 180;
  const centerLat = state.globe.latitude * rad, centerLon = state.globe.longitude * rad;
  const wx = sx * -Math.sin(centerLon) + sy * -Math.sin(centerLat) * Math.cos(centerLon) + depth * Math.cos(centerLat) * Math.cos(centerLon);
  const wy = sx * Math.cos(centerLon) + sy * -Math.sin(centerLat) * Math.sin(centerLon) + depth * Math.cos(centerLat) * Math.sin(centerLon);
  const wz = sy * Math.cos(centerLat) + depth * Math.sin(centerLat);
  return { latitude: Math.asin(Math.max(-1, Math.min(1, wz))) / rad, longitude: Math.atan2(wy, wx) / rad };
}

function latitudeBand(latitude) {
  const abs = Math.abs(latitude);
  if (abs >= 60) return "Higher geographic latitude";
  if (abs >= 30) return "Mid geographic latitude";
  return "Lower geographic latitude";
}

function identifyRegion(latitude, longitude) {
  const lon = ((longitude + 540) % 360) - 180;
  if (latitude >= 66.5) return "Arctic region";
  if (latitude <= -60) return "Antarctic region";
  if (lon >= -168 && lon <= -52 && latitude >= 8 && latitude <= 82) return "North America region";
  if (lon >= -82 && lon <= -34 && latitude >= -56 && latitude <= 13) return "South America region";
  if (lon >= 30 && lon <= 65 && latitude >= 12 && latitude <= 42) return "Middle East region";
  if (lon >= -25 && lon <= 60 && latitude >= 35 && latitude <= 72) return "Europe region";
  if (lon >= -20 && lon <= 52 && latitude >= -35 && latitude < 37) return "Africa region";
  if (lon >= 25 && lon <= 180 && latitude >= -12 && latitude <= 80) return "Asia region";
  if (lon >= 110 && latitude >= -50 && latitude < 0) return "Oceania region";
  if (longitude > 120 || longitude < -70) return "Pacific Ocean sector";
  if (longitude >= -70 && longitude < 20) return "Atlantic Ocean sector";
  return "Indian Ocean sector";
}

function layerTitle() {
  return ({ radio: ["Solar flare · radio blackout potential", "NOAA R-scale context on the sunlit side of Earth."], geomagnetic: ["Geomagnetic storm exposure context", "Global NOAA G scale with higher-latitude exposure emphasis."], radiation: ["Solar radiation · polar exposure context", "Global NOAA S scale with broad high-latitude weighting." ] })[state.layer];
}

function selectedImpactCopy(latitude, result) {
  if (result.level === "unavailable") return "The NOAA scale required for this layer is not available. Refresh the feed or open the official source before drawing conclusions.";
  if (state.layer === "radio") {
    if (result.level === "night") return `This point is on Earth's night side. The current NOAA scale is R${result.scale ?? state.scales.R ?? 0}; flare-driven radio-blackout effects are mainly on the sunlit side. This is a broad day/night context, not a radio-path forecast.`;
    if (result.scale === 0) return "This point is sunlit, but NOAA currently reports no active R-scale radio blackout (R0). Green means low current scale-based impact potential, not a guarantee of uninterrupted service.";
    return `This point is sunlit and the current global NOAA radio-blackout scale is R${result.scale}. HF and some navigation effects are possible at the corresponding R level; local equipment and radio paths determine actual service.`;
  }
  if (state.layer === "geomagnetic") {
    if (result.scale === 0) return "The current geomagnetic indicator is below G1. The map colors higher latitudes as a broad context; green does not guarantee local GNSS or grid performance.";
    return `The global geomagnetic outlook is G${result.scale}. This point's ${latitudeBand(latitude).toLowerCase()} is shown as a broad exposure context; geomagnetic effects vary with magnetic latitude, local time, network, and equipment.`;
  }
  if (result.scale === 0) return "NOAA currently reports no solar-radiation storm (S0). Higher latitudes are emphasized as context for polar routes and spacecraft; the map does not estimate dose.";
  return `The global NOAA solar-radiation scale is S${result.scale}. ${latitudeBand(latitude)} is shown as broad context because high-altitude polar operations can have different exposure considerations. This is not a personal dose estimate.`;
}

function practicalGuidance(result) {
  if (result.level === "unavailable") return "Check the official NOAA scale bulletin and your organization's procedures.";
  if (state.layer === "radio") return result.level === "night"
    ? "For HF operations, check the affected route and frequency, keep an alternate band or communications method available, and use current SWPC alerts."
    : "Check the active R-scale bulletin and actual HF/navigation performance. Keep alternate communications and follow your operating checklist.";
  if (state.layer === "geomagnetic") return "GNSS users should verify correction age and compare an independent position. Grid operators should use local telemetry and their established response plan.";
  return "Aviation and spacecraft operators should check route- or mission-specific radiation guidance. This map does not calculate dose or spacecraft risk.";
}

function renderInspector(point, pinned = false) {
  const region = point || { latitude: 20, longitude: 0 };
  const solar = solarGeometry();
  const impact = impactAt(region.latitude, region.longitude, solar);
  const lat = `${Math.abs(region.latitude).toFixed(1)}°${region.latitude >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(region.longitude).toFixed(1)}°${region.longitude >= 0 ? "E" : "W"}`;
  const regionName = identifyRegion(region.latitude, region.longitude);
  const [title] = layerTitle();
  setText("#inspected-region-title", `${pinned ? "Pinned" : "Inspecting"} · ${lat}, ${lon}`);
  setText("#inspected-region", regionName);
  setText("#inspected-layer", title.replace(" potential", ""));
  setText("#inspected-daylight", impact.daylight ? "Sunlit" : "Night side");
  setText("#inspected-latitude", latitudeBand(region.latitude));
  setText("#inspected-solar-time", `${localSolarTime(region.longitude, new Date(), solar)} local solar time`);
  setText("#inspected-impact-copy", selectedImpactCopy(region.latitude, impact));
  setText("#inspected-guidance", practicalGuidance(impact));
  const badge = $("#inspected-impact-level");
  if (badge) {
    badge.dataset.level = impact.level === "night" ? "low" : impact.level;
    const label = impact.level === "night" ? "LOW · NIGHT SIDE" : impact.level === "unavailable" ? "DATA UNAVAILABLE" : `${impact.level.toUpperCase()} · ${state.layer === "radio" ? `R${impact.scale ?? state.scales.R ?? 0}` : state.layer === "geomagnetic" ? `G${impact.scale ?? "—"}` : `S${impact.scale ?? "—"}`}`;
    badge.querySelector("span").textContent = label;
  }
  const readout = $("#global-globe-readout");
  if (readout) readout.textContent = `${pinned ? "Pinned" : "Inspecting"} · ${regionName} (approx.) · ${lat}, ${lon} · ${impact.level === "night" ? "night side" : impact.level} · ${localSolarTime(region.longitude, new Date(), solar)} solar time`;
}

function setLayer(layer) {
  if (!["radio", "geomagnetic", "radiation"].includes(layer)) return;
  state.layer = layer;
  $$(".global-layer-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.layer === layer));
  const [title, copy] = layerTitle();
  setText("#impact-layer-title", title); setText("#impact-layer-copy", copy);
  $("#global-map-legend").innerHTML = layer === "radio"
    ? '<span><i class="legend-green"></i>Low / no active R-scale event</span><span><i class="legend-yellow"></i>Moderate · R2</span><span><i class="legend-red"></i>High · R3+</span><span><i class="legend-night"></i>Night side · lower direct flare exposure</span>'
    : layer === "geomagnetic"
      ? '<span><i class="legend-green"></i>Lower broad exposure</span><span><i class="legend-yellow"></i>Moderate</span><span><i class="legend-red"></i>Higher broad exposure</span><span>Higher geographic latitudes emphasized</span>'
      : '<span><i class="legend-green"></i>Lower broad exposure</span><span><i class="legend-yellow"></i>Moderate</span><span><i class="legend-red"></i>Higher broad exposure</span><span>Polar latitude context · no dose estimate</span>';
  drawGlobalGlobe();
  if (state.hoverPoint) renderInspector(state.hoverPoint, false);
  else if (state.pinnedPoint) renderInspector(state.pinnedPoint, true);
  else clearInspector();
}

function clearInspector() {
  setText("#inspected-region-title", "Select a place on the globe");
  setText("#inspected-region", "—");
  setText("#inspected-impact-copy", "Click a visible region on the globe to pin its current impact context. NOAA scales are global indicators, not a location-specific outage forecast.");
  setText("#inspected-layer", layerTitle()[0].replace(" potential", ""));
  setText("#inspected-daylight", "—"); setText("#inspected-latitude", "—"); setText("#inspected-solar-time", "—");
  setText("#inspected-guidance", "Select a location to see the possible system effects and practical checks for this layer.");
  const badge = $("#inspected-impact-level");
  if (badge) { badge.dataset.level = ""; badge.querySelector("span").textContent = "Waiting for selection"; }
  setText("#global-globe-readout", "Drag to rotate · hover to inspect · click a point to pin it");
}

function initGlobalInteractions() {
  const canvas = $("#global-impact-globe");
  if (!canvas) return;
  $$(".global-layer-tabs button").forEach((button) => button.addEventListener("click", () => setLayer(button.dataset.layer)));
  $("#global-refresh")?.addEventListener("click", refreshData);
  const zoom = (factor) => { state.globe.zoom = Math.max(.76, Math.min(1.65, state.globe.zoom * factor)); drawGlobalGlobe(); };
  $("#global-zoom-in")?.addEventListener("click", () => zoom(1.18));
  $("#global-zoom-out")?.addEventListener("click", () => zoom(1 / 1.18));
  $("#global-reset")?.addEventListener("click", () => { state.globe = { ...state.globe, latitude: 15, longitude: 10, zoom: 1 }; drawGlobalGlobe(); });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    state.globe.dragging = true; state.globe.lastX = event.clientX; state.globe.lastY = event.clientY; state.globe.startX = event.clientX; state.globe.startY = event.clientY;
    canvas.classList.add("dragging"); canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.globe.dragging) {
      const dx = event.clientX - state.globe.lastX, dy = event.clientY - state.globe.lastY;
      state.globe.lastX = event.clientX; state.globe.lastY = event.clientY;
      state.globe.moved = state.globe.moved || Math.hypot(event.clientX - state.globe.startX, event.clientY - state.globe.startY) > 4;
      const lon = state.globe.longitude - dx * .42 / state.globe.zoom;
      state.globe.longitude = ((lon + 180) % 360 + 360) % 360 - 180;
      state.globe.latitude = Math.max(-82, Math.min(82, state.globe.latitude + dy * .34 / state.globe.zoom));
      requestAnimationFrame(drawGlobalGlobe); return;
    }
    const rect = canvas.getBoundingClientRect();
    state.hoverPoint = screenToGeo(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    if (state.hoverPoint) renderInspector(state.hoverPoint, false);
  });
  const stopDrag = (event) => {
    const wasDragging = state.globe.dragging;
    const moved = state.globe.moved;
    state.globe.dragging = false; state.globe.moved = false; canvas.classList.remove("dragging");
    if (wasDragging && !moved && event) {
      const rect = canvas.getBoundingClientRect();
      const point = screenToGeo(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
      if (point) { state.pinnedPoint = point; state.hoverPoint = point; renderInspector(point, true); drawGlobalGlobe(); }
    }
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", () => { state.globe.dragging = false; state.globe.moved = false; canvas.classList.remove("dragging"); });
  canvas.addEventListener("lostpointercapture", () => { state.globe.dragging = false; state.globe.moved = false; canvas.classList.remove("dragging"); });
  canvas.addEventListener("pointerleave", () => {
    if (state.globe.dragging) return;
    state.hoverPoint = null;
    if (state.pinnedPoint) renderInspector(state.pinnedPoint, true);
    else clearInspector();
  });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08); }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 15 : 8;
    if (event.key === "ArrowLeft") state.globe.longitude -= step;
    else if (event.key === "ArrowRight") state.globe.longitude += step;
    else if (event.key === "ArrowUp") state.globe.latitude = Math.min(82, state.globe.latitude + step);
    else if (event.key === "ArrowDown") state.globe.latitude = Math.max(-82, state.globe.latitude - step);
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.18); return; }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.18); return; }
    else return;
    event.preventDefault(); drawGlobalGlobe();
  });
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawGlobalGlobe, 130); });
}

function bootGlobalImpact() {
  initGlobalInteractions();
  setLayer("radio");
  drawGlobalGlobe();
  clearInspector();
  refreshData();
  setInterval(refreshData, 5 * 60 * 1000);
  setInterval(() => {
    drawGlobalGlobe();
    if (state.hoverPoint) renderInspector(state.hoverPoint, false);
    else if (state.pinnedPoint) renderInspector(state.pinnedPoint, true);
  }, 60 * 1000);
}

bootGlobalImpact();
