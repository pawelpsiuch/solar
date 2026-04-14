import fs from "node:fs/promises";

const LOCAL_TZ = "Europe/London";

function parseCsvLine(line) {
  const first = line.indexOf(",");
  const last = line.lastIndexOf(",");
  if (first < 0 || last <= first) return null;
  return {
    entity_id: line.slice(0, first),
    state: line.slice(first + 1, last),
    last_changed: line.slice(last + 1),
  };
}

function minuteOfDayInLondon(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour * 60) + minute;
}

function splitSegmentAcrossMinutes(start, end, powerKw, minuteEnergyKwh, minuteDurationHours) {
  let cursor = new Date(start.getTime());

  while (cursor < end) {
    const nextMinute = new Date(cursor.getTime());
    nextMinute.setUTCSeconds(0, 0);
    nextMinute.setUTCMinutes(nextMinute.getUTCMinutes() + 1);
    const segmentEnd = new Date(Math.min(end.getTime(), nextMinute.getTime()));

    const durationHours = (segmentEnd.getTime() - cursor.getTime()) / 3_600_000;
    if (durationHours > 0) {
      const minuteIdx = minuteOfDayInLondon(cursor);
      minuteEnergyKwh[minuteIdx] += powerKw * durationHours;
      minuteDurationHours[minuteIdx] += durationHours;
    }

    cursor = segmentEnd;
  }
}

export async function importHomeAssistantTypicalDay(csvPath) {
  if (!csvPath) {
    throw new Error("csvPath is required");
  }

  const raw = await fs.readFile(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) {
    throw new Error("CSV file does not contain enough rows");
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parsed = parseCsvLine(lines[i]);
    if (!parsed) continue;

    const ts = new Date(parsed.last_changed);
    const powerKw = Number(parsed.state);
    if (Number.isNaN(ts.getTime()) || !Number.isFinite(powerKw)) continue;

    rows.push({
      time: ts,
      powerKw,
    });
  }

  if (rows.length < 2) {
    throw new Error("Could not parse enough numeric rows from CSV");
  }

  rows.sort((a, b) => a.time.getTime() - b.time.getTime());

  const minuteEnergyKwh = Array(1440).fill(0);
  const minuteDurationHours = Array(1440).fill(0);

  for (let i = 0; i < rows.length - 1; i += 1) {
    const current = rows[i];
    const next = rows[i + 1];
    if (next.time <= current.time) continue;
    splitSegmentAcrossMinutes(current.time, next.time, current.powerKw, minuteEnergyKwh, minuteDurationHours);
  }

  const minuteShapeKw = minuteEnergyKwh.map((kwh, idx) => {
    const hours = minuteDurationHours[idx];
    return hours > 0 ? kwh / hours : 0;
  });

  const nonZero = minuteShapeKw.filter((v) => v > 0);
  const fallbackKw = nonZero.length
    ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length
    : 0;

  for (let i = 0; i < minuteShapeKw.length; i += 1) {
    if (minuteShapeKw[i] <= 0) minuteShapeKw[i] = fallbackKw;
  }

  const slotKwh = Array.from({ length: 48 }, (_, slot) => {
    const startMinute = slot * 30;
    let energy = 0;
    for (let m = 0; m < 30; m += 1) {
      energy += minuteShapeKw[startMinute + m] / 60;
    }
    return energy;
  });

  return {
    slotKwh,
    minuteShapeKw,
    meta: {
      csvPath,
      timezone: LOCAL_TZ,
      rowsParsed: rows.length,
      from: rows[0].time.toISOString(),
      to: rows[rows.length - 1].time.toISOString(),
    },
  };
}
