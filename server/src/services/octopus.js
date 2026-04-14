const OCTOPUS_BASE = "https://api.octopus.energy/v1";
const TARIFF_CLOCK_TIMEZONE = "Europe/London";

function parseTariffCodeParts(tariffCode) {
  const parts = String(tariffCode || "").trim().split("-");
  if (parts.length < 4) {
    throw new Error("Invalid tariff code format. Expected something like E-1R-AGILE-24-10-01-A");
  }

  const productCode = parts.slice(2, -1).join("-");
  if (!productCode) {
    throw new Error("Could not determine product code from tariff code");
  }

  return { productCode, tariffCode: parts.join("-") };
}

function toIso(input, fallback) {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function endOfHalfHour(date) {
  const d = new Date(date.getTime());
  d.setUTCSeconds(0, 0);
  const mins = d.getUTCMinutes();
  d.setUTCMinutes(mins < 30 ? 30 : 60);
  return d;
}

function slotForDate(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TARIFF_CLOCK_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minStr = parts.find((p) => p.type === "minute")?.value ?? "00";
  const hour = Number(hourStr) || 0;
  const minute = Number(minStr) || 0;
  return hour * 2 + (minute >= 30 ? 1 : 0);
}

function readRateValue(row, includeVat = true) {
  const primary = includeVat ? row?.value_inc_vat : row?.value_exc_vat;
  const secondary = includeVat ? row?.value_exc_vat : row?.value_inc_vat;
  const valPence = Number(primary ?? secondary);
  if (!Number.isFinite(valPence)) return null;
  return valPence / 100; // Octopus API values are in pence; model uses GBP.
}

async function fetchAllPages(url) {
  return fetchAllPagesWithInit(url);
}

async function fetchAllPagesWithInit(url, init = undefined) {
  let next = url;
  const rows = [];

  while (next) {
    const res = await fetch(next, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Octopus API failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    console.log(`[Octopus API] GET ${next}`);
    console.log(`[Octopus API] Response: ${JSON.stringify(data)}`);
    const results = Array.isArray(data?.results) ? data.results : [];
    rows.push(...results);
    next = data?.next || null;
  }

  return rows;
}

function makeBasicAuthHeader(apiKey) {
  const token = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${token}`;
}

async function fetchAccount(accountNumber, apiKey) {
  if (!accountNumber || !apiKey) {
    throw new Error("accountNumber and apiKey are required");
  }

  const url = `${OCTOPUS_BASE}/accounts/${encodeURIComponent(accountNumber)}/`;
  const res = await fetch(url, {
    headers: {
      Authorization: makeBasicAuthHeader(apiKey),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error("Octopus account auth failed. Check API key and account number.");
    }
    throw new Error(`Octopus account lookup failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return res.json();
}

function pickActiveAgreementTariffCode(agreements, asOf) {
  const asOfTime = asOf.getTime();
  const candidates = (agreements || []).filter((a) => {
    if (!a?.tariff_code) return false;
    const from = a.valid_from ? new Date(a.valid_from).getTime() : Number.NEGATIVE_INFINITY;
    const to = a.valid_to ? new Date(a.valid_to).getTime() : Number.POSITIVE_INFINITY;
    return from <= asOfTime && asOfTime < to;
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aFrom = a.valid_from ? new Date(a.valid_from).getTime() : 0;
    const bFrom = b.valid_from ? new Date(b.valid_from).getTime() : 0;
    return bFrom - aFrom;
  });

  return candidates[0].tariff_code;
}

function extractMeterPoints(accountData) {
  const props = Array.isArray(accountData?.properties) ? accountData.properties : [];
  return props.flatMap((prop) => (Array.isArray(prop?.electricity_meter_points) ? prop.electricity_meter_points : []));
}

function pickImportMeter(accountData) {
  const meterPoints = extractMeterPoints(accountData);
  for (const mp of meterPoints) {
    if (mp?.is_export === true) continue;
    const meters = Array.isArray(mp?.meters) ? mp.meters : [];
    const meter = meters.find((m) => Boolean(m?.serial_number));
    if (meter) {
      return {
        mpan: mp.mpan,
        serialNumber: meter.serial_number,
      };
    }
  }
  return null;
}

function agreementsToOptions(meterPoint, asOf) {
  const asOfTime = asOf.getTime();
  const isExport = meterPoint?.is_export === true;
  const agreements = Array.isArray(meterPoint?.agreements) ? meterPoint.agreements : [];

  return agreements
    .filter((a) => Boolean(a?.tariff_code))
    .map((a) => {
      const from = a.valid_from ? new Date(a.valid_from).getTime() : Number.NEGATIVE_INFINITY;
      const to = a.valid_to ? new Date(a.valid_to).getTime() : Number.POSITIVE_INFINITY;
      const isActive = from <= asOfTime && asOfTime < to;
      return {
        tariffCode: a.tariff_code,
        mpan: meterPoint?.mpan || null,
        isExport,
        isActive,
        validFrom: a.valid_from || null,
        validTo: a.valid_to || null,
      };
    });
}

function dedupeTariffOptions(options) {
  const map = new Map();

  for (const opt of options) {
    const key = `${opt.isExport ? "exp" : "imp"}::${opt.tariffCode}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, opt);
      continue;
    }

    if (!prev.isActive && opt.isActive) {
      map.set(key, opt);
      continue;
    }

    const prevFrom = prev.validFrom ? new Date(prev.validFrom).getTime() : 0;
    const optFrom = opt.validFrom ? new Date(opt.validFrom).getTime() : 0;
    if (optFrom > prevFrom) {
      map.set(key, opt);
    }
  }

  return [...map.values()];
}

export async function detectOctopusAccountTariffCodes(config) {
  const accountNumber = String(config?.accountNumber || "").trim();
  const apiKey = String(config?.apiKey || "").trim();
  const asOf = config?.asOf ? new Date(config.asOf) : new Date();

  if (Number.isNaN(asOf.getTime())) {
    throw new Error("Invalid asOf date");
  }

  const accountData = await fetchAccount(accountNumber, apiKey);
  const meterPoints = extractMeterPoints(accountData);

  let importTariffCode = null;
  let exportTariffCode = null;
  const found = [];

  for (const mp of meterPoints) {
    const code = pickActiveAgreementTariffCode(mp?.agreements, asOf);
    if (!code) continue;

    const isExport = mp?.is_export === true;
    if (isExport) {
      if (!exportTariffCode) exportTariffCode = code;
    } else if (!importTariffCode) {
      importTariffCode = code;
    }

    found.push({
      mpan: mp?.mpan || null,
      isExport,
      tariffCode: code,
    });
  }

  if (!importTariffCode && found.length) {
    importTariffCode = found.find((x) => x.isExport === false)?.tariffCode || found[0].tariffCode;
  }

  if (!importTariffCode) {
    throw new Error("No active electricity tariff code found on this account for the selected date.");
  }

  return {
    accountNumber,
    asOf: asOf.toISOString(),
    importTariffCode,
    exportTariffCode,
    meterPoints: found,
  };
}

export async function listOctopusAccountTariffOptions(config) {
  const accountNumber = String(config?.accountNumber || "").trim();
  const apiKey = String(config?.apiKey || "").trim();
  const asOf = config?.asOf ? new Date(config.asOf) : new Date();

  if (Number.isNaN(asOf.getTime())) {
    throw new Error("Invalid asOf date");
  }

  const accountData = await fetchAccount(accountNumber, apiKey);
  const meterPoints = extractMeterPoints(accountData);
  const options = dedupeTariffOptions(meterPoints.flatMap((mp) => agreementsToOptions(mp, asOf)));

  const importTariffs = options.filter((o) => !o.isExport);
  const exportTariffs = options.filter((o) => o.isExport);

  const activeImport = importTariffs.find((o) => o.isActive) || importTariffs[0] || null;
  const activeExport = exportTariffs.find((o) => o.isActive) || exportTariffs[0] || null;

  return {
    accountNumber,
    asOf: asOf.toISOString(),
    importTariffs,
    exportTariffs,
    activeImportTariffCode: activeImport?.tariffCode || null,
    activeExportTariffCode: activeExport?.tariffCode || null,
  };
}

function buildSlotProfileFromRates(rateRows, periodFromIso, periodToIso, includeVat = true) {
  const from = new Date(periodFromIso);
  const to = new Date(periodToIso);
  const totals = Array(48).fill(0);
  const mins = Array(48).fill(0);

  for (const row of rateRows) {
    const value = readRateValue(row, includeVat);
    if (value === null) continue;

    const validFrom = new Date(row.valid_from);
    const validTo = row.valid_to ? new Date(row.valid_to) : to;

    let cursor = new Date(Math.max(validFrom.getTime(), from.getTime()));
    const end = new Date(Math.min(validTo.getTime(), to.getTime()));
    if (cursor >= end) continue;

    while (cursor < end) {
      const next = new Date(Math.min(end.getTime(), endOfHalfHour(cursor).getTime()));
      const slot = slotForDate(cursor);
      const durationMins = (next.getTime() - cursor.getTime()) / 60000;

      totals[slot] += value * durationMins;
      mins[slot] += durationMins;
      cursor = next;
    }
  }

  const weightedTotal = totals.reduce((sum, t) => sum + t, 0);
  const totalMins = mins.reduce((sum, m) => sum + m, 0);
  const fallback = totalMins > 0 ? weightedTotal / totalMins : 0;

  return totals.map((t, i) => (mins[i] > 0 ? t / mins[i] : fallback));
}

function averageStandingCharge(rows, includeVat = true) {
  const values = rows.map((row) => readRateValue(row, includeVat)).filter((v) => v !== null);
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function fetchTariffRates(tariffCode, periodFromIso, periodToIso, endpoint) {
  const { productCode, tariffCode: normalizedTariffCode } = parseTariffCodeParts(tariffCode);
  const url = new URL(`${OCTOPUS_BASE}/products/${encodeURIComponent(productCode)}/electricity-tariffs/${encodeURIComponent(normalizedTariffCode)}/${endpoint}/`);
  url.searchParams.set("period_from", periodFromIso);
  url.searchParams.set("period_to", periodToIso);
  url.searchParams.set("page_size", "1500");

  return fetchAllPages(url.toString());
}

async function fetchConsumptionRows(config) {
  const accountNumber = String(config?.accountNumber || "").trim();
  const apiKey = String(config?.apiKey || "").trim();
  const periodFrom = toIso(config?.periodFrom, new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString());
  const periodTo = toIso(config?.periodTo, new Date().toISOString());

  if (!accountNumber || !apiKey) {
    throw new Error("accountNumber and apiKey are required");
  }

  let mpan = config?.mpan ? String(config.mpan).trim() : "";
  let serialNumber = config?.serialNumber ? String(config.serialNumber).trim() : "";

  if (!mpan || !serialNumber) {
    const accountData = await fetchAccount(accountNumber, apiKey);
    const meter = pickImportMeter(accountData);
    if (!meter) {
      throw new Error("Could not find an import electricity meter with serial number on this account.");
    }
    mpan = mpan || meter.mpan;
    serialNumber = serialNumber || meter.serialNumber;
  }

  const url = new URL(`${OCTOPUS_BASE}/electricity-meter-points/${encodeURIComponent(mpan)}/meters/${encodeURIComponent(serialNumber)}/consumption/`);
  url.searchParams.set("period_from", periodFrom);
  url.searchParams.set("period_to", periodTo);
  url.searchParams.set("page_size", "25000");

  const rows = await fetchAllPagesWithInit(url.toString(), {
    headers: {
      Authorization: makeBasicAuthHeader(apiKey),
    },
  });

  return { rows, periodFrom, periodTo, mpan, serialNumber };
}

export async function importOctopusUsageProfile(config) {
  const { rows, periodFrom, periodTo, mpan, serialNumber } = await fetchConsumptionRows(config);
  const totals = Array(48).fill(0);
  const counts = Array(48).fill(0);

  for (const row of rows) {
    const consumption = Number(row?.consumption);
    if (!Number.isFinite(consumption)) continue;
    const intervalStart = row?.interval_start ? new Date(row.interval_start) : null;
    if (!intervalStart || Number.isNaN(intervalStart.getTime())) continue;
    const slot = slotForDate(intervalStart);
    totals[slot] += consumption;
    counts[slot] += 1;
  }

  const fallback = counts.some((c) => c > 0)
    ? totals.reduce((a, b) => a + b, 0) / counts.reduce((a, b) => a + b, 0)
    : 0;
  const slotKwh = totals.map((t, i) => (counts[i] > 0 ? t / counts[i] : fallback));

  return {
    slotKwh,
    meta: {
      source: "octopus-consumption",
      timezone: TARIFF_CLOCK_TIMEZONE,
      periodFrom,
      periodTo,
      mpan,
      serialNumber,
      intervalsUsed: counts.reduce((a, b) => a + b, 0),
    },
  };
}

export async function importOctopusTariff(config) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
  const defaultTo = now.toISOString();

  const periodFrom = toIso(config?.periodFrom, defaultFrom);
  const periodTo = toIso(config?.periodTo, defaultTo);
  const includeVat = config?.includeVat !== false;

  let importTariffCode = config?.importTariffCode || null;
  let exportTariffCode = config?.exportTariffCode || null;

  if (!importTariffCode && config?.accountNumber && config?.apiKey) {
    const detected = await detectOctopusAccountTariffCodes({
      accountNumber: config.accountNumber,
      apiKey: config.apiKey,
      asOf: config.periodTo || new Date().toISOString(),
    });
    importTariffCode = detected.importTariffCode;
    exportTariffCode = exportTariffCode || detected.exportTariffCode;
  }

  if (!importTariffCode) {
    throw new Error("importTariffCode is required (or provide accountNumber + apiKey for auto-detect)");
  }

  const importRows = await fetchTariffRates(importTariffCode, periodFrom, periodTo, "standard-unit-rates");
  const importRate = buildSlotProfileFromRates(importRows, periodFrom, periodTo, includeVat);

  const exportRows = exportTariffCode
    ? await fetchTariffRates(exportTariffCode, periodFrom, periodTo, "standard-unit-rates")
    : [];
  const exportRate = exportRows.length
    ? buildSlotProfileFromRates(exportRows, periodFrom, periodTo, includeVat)
    : Array(48).fill(0);

  const standingRows = await fetchTariffRates(importTariffCode, periodFrom, periodTo, "standing-charges");
  const standingChargePerDay = averageStandingCharge(standingRows, includeVat);

  const tariffName = config.name || `Octopus ${importTariffCode}`;

  return {
    id: `octopus-${Date.now()}`,
    name: tariffName,
    standingChargePerDay,
    importRate,
    exportRate,
    enabled: true,
    meta: {
      source: "octopus",
      importedAt: new Date().toISOString(),
      periodFrom,
      periodTo,
      importTariffCode,
      exportTariffCode,
      includeVat,
    },
  };
}
