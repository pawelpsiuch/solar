import { loadPVGISCache, savePVGISCache } from "./fileStore.js";

const PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc";
const SLOTS_PER_DAY = 48;

function normalizeAspectDeg(input) {
  const raw = Number(input ?? 0);
  if (!Number.isFinite(raw)) return 0;

  // Preferred UI input is compass azimuth in [0..360]:
  // 0=N, 90=E, 180=S, 270=W.
  // PVGIS expects "aspect" where 0=S, -90=E, 90=W, -180=N.
  if (raw >= 0 && raw <= 360) {
    const aspectFromCompass = raw - 180;
    let normalized = ((aspectFromCompass + 180) % 360 + 360) % 360 - 180;
    if (normalized === -180) normalized = 180;
    return normalized;
  }

  // Legacy fallback: treat as already in PVGIS-style aspect.
  let normalized = ((raw + 180) % 360 + 360) % 360 - 180;
  if (normalized === -180) normalized = 180;
  return normalized;
}

function makeKey(location, array) {
  return [
    "v2",
    location.latitude,
    location.longitude,
    array.tiltDeg,
    normalizeAspectDeg(array.azimuthDeg),
    array.lossPercent,
    array.peakPowerKw,
  ].join(":");
}

function normalizeShadingPercent(input) {
  const raw = Number(input ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, raw));
}

function normalizeShadingStartSlot(input) {
  const raw = Number(input ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.floor(raw)));
}

async function fetchArrayHourlyProfile(location, array) {
  const aspectDeg = normalizeAspectDeg(array.azimuthDeg);
  const params = new URLSearchParams({
    lat: String(location.latitude),
    lon: String(location.longitude),
    outputformat: "json",
    pvcalculation: "1",
    peakpower: "1",
    loss: String(array.lossPercent ?? 14),
    angle: String(array.tiltDeg ?? 35),
    aspect: String(aspectDeg),
    mountingplace: "building",
    startyear: "2020",
    endyear: "2020",
    optimalangles: "0",
    components: "1",
  });

  const res = await fetch(`${PVGIS_BASE}?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PVGIS request failed (${res.status}): ${text.slice(0, 180)}`);
  }

  const data = await res.json();
  const hourly = data?.outputs?.hourly;
  if (!Array.isArray(hourly) || !hourly.length) {
    throw new Error("PVGIS response did not contain hourly output data");
  }

  return hourly.map((row) => {
    const pKwPerKw = Math.max(0, Number(row?.P) / 1000);
    const gi = Number(row?.["G(i)"]);
    const gbi = Number(row?.["Gb(i)"]);
    const gdi = Number(row?.["Gd(i)"]);
    const gri = Number(row?.["Gr(i)"]);
    const sunshineWm2 = Number.isFinite(gi)
      ? Math.max(0, gi)
      : Math.max(0, (Number.isFinite(gbi) ? gbi : 0) + (Number.isFinite(gdi) ? gdi : 0) + (Number.isFinite(gri) ? gri : 0));

    return {
      pKwPerKw,
      sunshineWm2,
    };
  });
}

function readProfilePoint(profileRow) {
  if (typeof profileRow === "number") {
    return { pKwPerKw: Math.max(0, Number(profileRow || 0)), sunshineWm2: 0 };
  }

  const pKwPerKw = Math.max(0, Number(profileRow?.pKwPerKw || profileRow?.p || 0));
  const sunshineWm2 = Math.max(0, Number(profileRow?.sunshineWm2 || profileRow?.sun || 0));
  return { pKwPerKw, sunshineWm2 };
}

export async function getPVGenerationSlots(project) {
  const cache = await loadPVGISCache();
  const arrays = (project.arrays || []).filter((arr) => arr.enabled !== false);
  const halfHourlyTotal = Array(8760 * 2).fill(0);

  for (const array of arrays) {
    const key = makeKey(project.location, array);
    let profile = cache[key];

    if (!profile) {
      profile = await fetchArrayHourlyProfile(project.location, array);
      cache[key] = profile;
    }

    const arrayPeakPowerKw = Number(array.peakPowerKw) || 0;
    const shadingPercent = normalizeShadingPercent(array.shadingPercent);
    const shadingStartSlot = normalizeShadingStartSlot(array.shadingStartSlot);
    const shadingFactor = 1 - (shadingPercent / 100);

    for (let hourIdx = 0; hourIdx < 8760; hourIdx += 1) {
      const point = readProfilePoint(profile[hourIdx]);
      const arrayHourKwh = point.pKwPerKw * arrayPeakPowerKw;
      const perSlotKwh = arrayHourKwh / 2;

      const slotA = hourIdx * 2;
      const slotB = slotA + 1;
      const daySlotA = slotA % SLOTS_PER_DAY;
      const daySlotB = slotB % SLOTS_PER_DAY;

      const slotAFactor = daySlotA >= shadingStartSlot ? shadingFactor : 1;
      const slotBFactor = daySlotB >= shadingStartSlot ? shadingFactor : 1;

      halfHourlyTotal[slotA] += perSlotKwh * slotAFactor;
      halfHourlyTotal[slotB] += perSlotKwh * slotBFactor;
    }
  }

  await savePVGISCache(cache);

  return halfHourlyTotal;
}

export async function getPVGenerationSlotsByArray(project) {
  const cache = await loadPVGISCache();
  const arrays = (project.arrays || []).filter((arr) => arr.enabled !== false);
  const byArrayId = {};
  const sunshineSlots = Array(8760 * 2).fill(0);
  const sunshineCountSlots = Array(8760 * 2).fill(0);

  for (const array of arrays) {
    const key = makeKey(project.location, array);
    let profile = cache[key];

    if (!profile) {
      profile = await fetchArrayHourlyProfile(project.location, array);
      cache[key] = profile;
    }

    const slots = Array(8760 * 2).fill(0);
    const arrayPeakPowerKw = Number(array.peakPowerKw) || 0;
    const shadingPercent = normalizeShadingPercent(array.shadingPercent);
    const shadingStartSlot = normalizeShadingStartSlot(array.shadingStartSlot);
    const shadingFactor = 1 - (shadingPercent / 100);

    for (let hourIdx = 0; hourIdx < 8760; hourIdx += 1) {
      const point = readProfilePoint(profile[hourIdx]);
      const arrayHourKwh = point.pKwPerKw * arrayPeakPowerKw;
      const perSlotKwh = arrayHourKwh / 2;
      const hourSunshineWm2 = point.sunshineWm2;

      const slotA = hourIdx * 2;
      const slotB = slotA + 1;
      const daySlotA = slotA % SLOTS_PER_DAY;
      const daySlotB = slotB % SLOTS_PER_DAY;

      const slotAFactor = daySlotA >= shadingStartSlot ? shadingFactor : 1;
      const slotBFactor = daySlotB >= shadingStartSlot ? shadingFactor : 1;

      slots[slotA] += perSlotKwh * slotAFactor;
      slots[slotB] += perSlotKwh * slotBFactor;
      sunshineSlots[slotA] += hourSunshineWm2;
      sunshineSlots[slotB] += hourSunshineWm2;
      sunshineCountSlots[slotA] += 1;
      sunshineCountSlots[slotB] += 1;
    }

    byArrayId[array.id] = slots;
  }

  await savePVGISCache(cache);
  return {
    byArrayId,
    sunshineSlots: sunshineSlots.map((sum, idx) => (sunshineCountSlots[idx] ? (sum / sunshineCountSlots[idx]) : 0)),
  };
}
