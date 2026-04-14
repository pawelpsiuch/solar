import { getPVGenerationSlotsByArray } from "./pvgis.js";
import { SLOTS_PER_DAY, SLOT_HOURS, getYearSlots, getSlotIndex, slotInWindow } from "../utils/time.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampPercent(v, fallback = 0) {
  return Math.max(0, Math.min(100, safeNum(v, fallback)));
}

function getRate(arr, slot, fallback = 0) {
  return safeNum(arr?.[slot], fallback);
}

function getTariffRateArray(tariff, type) {
  if (type === "import") {
    return tariff.importRate || tariff.importRateWeekday || tariff.importRateWeekend || [];
  }

  return tariff.exportRate || tariff.exportRateWeekday || tariff.exportRateWeekend || [];
}

function getConsumptionForSlot(project, date) {
  const slot = getSlotIndex(date);
  const base = safeNum(project.consumption?.slotKwh?.[slot], 0);
  const monthAdj = safeNum(project.consumption?.monthlyAdjustment?.[date.getUTCMonth()], 1);
  return base * monthAdj;
}

function defaultBatteryConfig() {
  return {
    enabled: false,
    capacityKwh: 0,
    usableCapacityPercent: 95,
    initialSocPercent: 50,
    minSocPercent: 15,
    targetSocPercent: 70,
    maxChargeKw: 0,
    maxDischargeKw: 0,
    chargeEfficiencyPercent: 95,
    dischargeEfficiencyPercent: 95,
    degradationCostPerKwh: 0,
    forceChargeWindows: [],
    forceDischargeWindows: [],
  };
}

function sumWindowPowerKw(windows, slot, field = "powerKw") {
  let power = 0;
  for (const window of windows || []) {
    if (window?.enabled !== false && slotInWindow(slot, safeNum(window.startSlot, 0), safeNum(window.endSlot, 0))) {
      power += safeNum(window[field], 0);
    }
  }
  return power;
}

function getChargeTargetSoc(windows, slot, monthIndex, fallbackPercent) {
  let target = null;
  for (const window of windows || []) {
    if (window?.enabled !== false && slotInWindow(slot, safeNum(window.startSlot, 0), safeNum(window.endSlot, 0))) {
      const monthly = Array.isArray(window.targetSocPercentByMonth) && window.targetSocPercentByMonth.length === 12
        ? safeNum(window.targetSocPercentByMonth[monthIndex], safeNum(window.targetSocPercent, fallbackPercent))
        : safeNum(window.targetSocPercent, fallbackPercent);
      target = target === null ? monthly : Math.max(target, monthly);
    }
  }
  return target === null ? fallbackPercent : target;
}

function buildForceTargetCandidates(stepPercent) {
  const step = Math.max(1, Math.min(50, Math.round(safeNum(stepPercent, 10))));
  const values = [];
  for (let p = 0; p <= 100; p += step) {
    values.push(p);
  }
  if (values[values.length - 1] !== 100) values.push(100);
  return values;
}

function getDischargeTargetSoc(windows, slot, fallbackPercent) {
  let target = fallbackPercent;
  let found = false;
  for (const window of windows || []) {
    if (window?.enabled !== false && slotInWindow(slot, safeNum(window.startSlot, 0), safeNum(window.endSlot, 0))) {
      const v = safeNum(window.targetSocPercent, fallbackPercent);
      target = found ? Math.min(target, v) : v;
      found = true;
    }
  }
  return target;
}

function buildSystems(project) {
  const systems = Array.isArray(project.systems) ? project.systems : [];
  if (systems.length === 0) {
    throw new Error("At least one system is required");
  }

  return systems.map((s, idx) => {
    if (!s?.battery || typeof s.battery !== "object") {
      throw new Error(`systems[${idx}].battery is required`);
    }

    return {
    id: s.id || `system-${idx + 1}`,
    name: s.name || `System ${idx + 1}`,
    arrayIds: Array.isArray(s.arrayIds) ? s.arrayIds : [],
    inverter: s.inverter || { acPowerKw: 5, efficiencyPercent: 97 },
    battery: s.battery,
    batteryCoupling: s.batteryCoupling === "dc" ? "dc" : "ac",
    };
  });
}

function aggregateBatteryFromSystems(systems) {
  const batteries = systems.map((s) => s.battery || defaultBatteryConfig());
  const enabled = batteries.filter((b) => b.enabled !== false);

  const usableByBattery = enabled.map((b) => safeNum(b.capacityKwh, 0) * safeNum(b.usableCapacityPercent, 100) / 100);
  const usableCapacityKwh = usableByBattery.reduce((a, b) => a + b, 0);
  const batteryEnabled = usableCapacityKwh > 0;
  const maxSocKwh = usableCapacityKwh;
  const minSocKwh = enabled.reduce(
    (acc, b, i) => acc + (usableByBattery[i] * safeNum(b.minSocPercent, 0) / 100),
    0,
  );
  const initialSocKwh = enabled.reduce(
    (acc, b, i) => acc + (usableByBattery[i] * safeNum(b.initialSocPercent, 0) / 100),
    0,
  );
  const defaultTargetSocPercent = usableCapacityKwh > 0
    ? enabled.reduce((acc, b, i) => acc + (usableByBattery[i] * safeNum(b.targetSocPercent, 0)), 0) / usableCapacityKwh
    : 0;

  const totalChargeKw = enabled.reduce((acc, b) => acc + Math.max(0, safeNum(b.maxChargeKw, 0)), 0);
  const totalDischargeKw = enabled.reduce((acc, b) => acc + Math.max(0, safeNum(b.maxDischargeKw, 0)), 0);
  const chargeEff = totalChargeKw > 0
    ? enabled.reduce((acc, b) => acc + (Math.max(0, safeNum(b.maxChargeKw, 0)) * (safeNum(b.chargeEfficiencyPercent, 95) / 100)), 0) / totalChargeKw
    : 0.95;
  const dischargeEff = totalDischargeKw > 0
    ? enabled.reduce((acc, b) => acc + (Math.max(0, safeNum(b.maxDischargeKw, 0)) * (safeNum(b.dischargeEfficiencyPercent, 95) / 100)), 0) / totalDischargeKw
    : 0.95;

  const maxChargeInputKwh = enabled.reduce((acc, b) => acc + (Math.max(0, safeNum(b.maxChargeKw, 0)) * SLOT_HOURS), 0);
  const maxDischargeOutputKwh = enabled.reduce(
    (acc, b) => acc + (Math.max(0, safeNum(b.maxDischargeKw, 0)) * SLOT_HOURS * (safeNum(b.dischargeEfficiencyPercent, 95) / 100)),
    0,
  );
  const degradationCostPerKwh = usableCapacityKwh > 0
    ? enabled.reduce((acc, b, i) => acc + (usableByBattery[i] * safeNum(b.degradationCostPerKwh, 0)), 0) / usableCapacityKwh
    : 0;

  const minSocPercentWeighted = usableCapacityKwh > 0
    ? enabled.reduce((acc, b, i) => acc + (usableByBattery[i] * safeNum(b.minSocPercent, 0)), 0) / usableCapacityKwh
    : 0;

  return {
    batteryEnabled,
    usableCapacityKwh,
    minSocKwh,
    maxSocKwh,
    initialSocKwh,
    defaultTargetSocPercent,
    chargeEff,
    dischargeEff,
    maxChargeInputKwh,
    maxDischargeOutputKwh,
    degradationCostPerKwh,
    minSocPercentWeighted,
  };
}

function getSlotPvSources({
  systems,
  arraySlotsById,
  slotIndex,
}) {
  let pvAcKwh = 0;
  let pvDcToBatteryKwh = 0;
  let pvTotalKwh = 0;

  for (const system of systems) {
    const invEff = safeNum(system.inverter?.efficiencyPercent, 97) / 100;
    const acCapKwh = safeNum(system.inverter?.acPowerKw, 5) * SLOT_HOURS;
    const dcKwh = (system.arrayIds || []).reduce((acc, arrayId) => acc + safeNum(arraySlotsById[arrayId]?.[slotIndex], 0), 0);
    if (dcKwh <= 0) continue;

    const acFromDcKwh = Math.min(dcKwh * invEff, acCapKwh);
    pvAcKwh += acFromDcKwh;
    pvTotalKwh += dcKwh;

    if (system.batteryCoupling === "dc" && invEff > 0) {
      const dcSpentForAc = acFromDcKwh / invEff;
      const dcBypass = Math.max(0, dcKwh - dcSpentForAc);
      pvDcToBatteryKwh += dcBypass;
    }
  }

  return { pvAcKwh, pvDcToBatteryKwh, pvTotalKwh };
}

function isEvActiveOnDay(ev, utcDay) {
  const days = ev?.chargeDays;
  if (Array.isArray(days) && days.length === 7) {
    return days[utcDay] === true;
  }

  if (days && typeof days === "object") {
    const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    return days[map[utcDay]] === true;
  }

  return false;
}

function getEvStartSlot(ev) {
  return Math.max(0, Math.min(47, safeNum(ev?.startSlot, 0)));
}

function getEvEndSlot(ev) {
  return Math.max(0, Math.min(48, safeNum(ev?.endSlot, 0)));
}

function buildEvDemandSlots(evs, slots) {
  const demandBySlot = Array(slots.length).fill(0);
  const list = Array.isArray(evs) ? evs.filter((ev) => ev?.enabled !== false) : [];
  if (!list.length) return demandBySlot;

  let currentDayIso = "";
  let remainingByEv = [];

  for (let i = 0; i < slots.length; i += 1) {
    const date = slots[i];
    const dayIso = toIsoDay(date);
    const slot = getSlotIndex(date);

    if (dayIso !== currentDayIso) {
      currentDayIso = dayIso;
      const utcDay = date.getUTCDay();
      remainingByEv = list.map((ev) => (
        isEvActiveOnDay(ev, utcDay) ? Math.max(0, safeNum(ev.batteryCapacityKwh, 0)) : 0
      ));
    }

    let slotEvDemand = 0;
    for (let evIdx = 0; evIdx < list.length; evIdx += 1) {
      const ev = list[evIdx];
      const remaining = remainingByEv[evIdx] ?? 0;
      if (remaining <= 0) continue;

      const startSlot = getEvStartSlot(ev);
      const endSlot = getEvEndSlot(ev);
      if (!slotInWindow(slot, startSlot, endSlot)) continue;

      const slotChargeKwh = Math.max(0, safeNum(ev.chargePowerKw, 0)) * SLOT_HOURS;
      if (slotChargeKwh <= 0) continue;

      const charged = Math.min(slotChargeKwh, remaining);
      remainingByEv[evIdx] = remaining - charged;
      slotEvDemand += charged;
    }

    demandBySlot[i] = slotEvDemand;
  }

  return demandBySlot;
}

function buildTariffSummary() {
  return {
    annual: {
      loadKwh: 0,
      pvKwh: 0,
      pvCurtailedKwh: 0,
      pvUsedDirectKwh: 0,
      batteryChargeFromPvKwh: 0,
      batteryChargeFromGridKwh: 0,
      batteryDischargeToLoadKwh: 0,
      batteryDischargeToExportKwh: 0,
      batteryThroughputKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      importCost: 0,
      exportRevenue: 0,
      standingCharge: 0,
      maintenanceCost: 0,
      batteryDegradationCost: 0,
      totalCost: 0,
      autarkyPercent: 0,
      selfConsumptionPercent: 0,
      peakImportKw: 0,
      peakExportKw: 0,
      estimatedCycles: 0,
      co2Kg: 0,
      baselineCost: 0,
      savingsVsBaseline: 0,
      houseLoadKwh: 0,
      evLoadKwh: 0,
    },
    monthly: Array.from({ length: 12 }, () => ({
      loadKwh: 0,
      pvKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      importCost: 0,
      exportRevenue: 0,
      standingCharge: 0,
      netCost: 0,
      totalCost: 0,
      baselineCost: 0,
      savingsVsBaseline: 0,
      houseLoadKwh: 0,
      evLoadKwh: 0,
    })),
  };
}

function toIsoDay(date) {
  return date.toISOString().slice(0, 10);
}

function toSlotLabel(slotIndex) {
  const hours = Math.floor(slotIndex / 2).toString().padStart(2, "0");
  const mins = slotIndex % 2 === 0 ? "00" : "30";
  return `${hours}:${mins}`;
}

function minuteToTimeLabel(minuteOfDay) {
  const safeMinute = Math.max(0, Math.min(1439, Math.floor(safeNum(minuteOfDay, 0))));
  const hours = Math.floor(safeMinute / 60).toString().padStart(2, "0");
  const mins = (safeMinute % 60).toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

function daysInMonthUtc(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function round3(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

function roundNumbersDeep(value) {
  if (typeof value === "number") return round3(value);
  if (Array.isArray(value)) return value.map(roundNumbersDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = roundNumbersDeep(v);
    }
    return out;
  }
  return value;
}

function getMinuteWeightsForSlot(consumption, slot) {
  const shape = consumption?.minuteShapeKw;
  if (!Array.isArray(shape) || shape.length !== 1440) {
    return [1];
  }

  const start = slot * 30;
  const values = shape.slice(start, start + 30).map((v) => Math.max(0, safeNum(v, 0)));
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return Array(30).fill(1 / 30);
  }

  return values.map((v) => v / total);
}

function optimizeForceChargeTargetForDay({
  dayIndexes,
  socStartKwh,
  slots,
  houseDemandSlots,
  evDemandSlots,
  pvSlots,
  importRateArray,
  exportRateArray,
  vatFactor,
  exportTaxFactor,
  forceChargeWindows,
  forceDischargeWindows,
  defaultTargetSocPercent,
  minSocPercentWeighted,
  usableCapacityKwh,
  inverterCapKwhPerSlot,
  maxChargeInputKwh,
  maxDischargeOutputKwh,
  minSocKwh,
  maxSocKwh,
  chargeEff,
  dischargeEff,
  batteryEnabled,
  exportLimitKwh,
  minuteWeightsBySlot,
  stepPercent,
}) {
  const candidates = buildForceTargetCandidates(stepPercent);
  let bestTarget = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const targetPercent of candidates) {
    let socKwh = socStartKwh;
    let dayCashflow = 0;
    let forcedExportKwh = 0;

    for (const idx of dayIndexes) {
      const date = slots[idx];
      const slot = getSlotIndex(date);
      const importRate = getRate(importRateArray, slot);
      const exportRate = getRate(exportRateArray, slot);
      const forceDischargeKw = sumWindowPowerKw(forceDischargeWindows, slot);
      const forceChargeKw = sumWindowPowerKw(forceChargeWindows, slot);
      const forceDischargeTargetSocPercent = getDischargeTargetSoc(forceDischargeWindows, slot, minSocPercentWeighted);
      const targetSocKwh = usableCapacityKwh * clampPercent(targetPercent, defaultTargetSocPercent) / 100;
      const forceDischargeTargetSocKwh = usableCapacityKwh * forceDischargeTargetSocPercent / 100;

      const dispatch = runDispatchForSlot({
        houseDemandKwh: safeNum(houseDemandSlots[idx], 0),
        evDemandKwh: safeNum(evDemandSlots[idx], 0),
        pvAcKwh: safeNum(pvSlots[idx]?.pvAcKwh, 0),
        pvDcToBatteryKwh: safeNum(pvSlots[idx]?.pvDcToBatteryKwh, 0),
        pvTotalKwh: safeNum(pvSlots[idx]?.pvTotalKwh, 0),
        socKwh,
        minuteWeights: minuteWeightsBySlot[slot],
        inverterCapKwhPerSlot,
        maxChargeInputKwh,
        maxDischargeOutputKwh,
        minSocKwh,
        maxSocKwh,
        chargeEff,
        dischargeEff,
        batteryEnabled,
        usableCapacityKwh,
        forceDischargeKw,
        forceDischargeTargetSocKwh,
        forceChargeKw,
        targetSocKwh,
        exportLimitKwh,
      });

      socKwh = dispatch.socKwh;
      forcedExportKwh += safeNum(dispatch.dischargeToExport, 0);
      const importCostWithVat = dispatch.gridImportKwh * importRate * vatFactor;
      const exportRevenueAfterTax = dispatch.gridExportKwh * exportRate * exportTaxFactor;
      dayCashflow += (exportRevenueAfterTax - importCostWithVat);
    }

    const score = (forcedExportKwh * 1_000_000) + dayCashflow;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      bestTarget = targetPercent;
    } else if (Math.abs(score - bestScore) <= 1e-9 && bestTarget !== null && targetPercent > bestTarget) {
      bestTarget = targetPercent;
    }
  }

  return bestTarget;
}

function runDispatchForSlot({
  houseDemandKwh,
  evDemandKwh,
  pvAcKwh,
  pvDcToBatteryKwh,
  pvTotalKwh,
  socKwh,
  minuteWeights,
  inverterCapKwhPerSlot,
  maxChargeInputKwh,
  maxDischargeOutputKwh,
  minSocKwh,
  maxSocKwh,
  chargeEff,
  dischargeEff,
  batteryEnabled,
  usableCapacityKwh,
  forceDischargeKw,
  forceDischargeTargetSocKwh,
  forceChargeKw,
  targetSocKwh,
  exportLimitKwh,
  minuteStartIndex = null,
}) {
  const steps = minuteWeights.length;
  const stepHours = SLOT_HOURS / steps;
  const minuteTrace = [];
  const demandKwh = safeNum(houseDemandKwh, 0) + safeNum(evDemandKwh, 0);

  let demandRemainTotal = 0;
  let pvRemainTotal = 0;
  let dischargeToLoad = 0;
  let dischargeToExport = 0;
  let chargeFromPvStored = 0;
  let chargeFromGridStored = 0;
  let gridImportKwh = 0;
  let gridExportKwh = 0;
  let curtailedKwh = 0;
  let pvToLoadTotal = 0;
  let maxImportKw = 0;
  let maxExportKw = 0;
  let firstFullStep = null;

  const stepPvAc = pvAcKwh / steps;
  const stepPvDc = pvDcToBatteryKwh / steps;
  const stepPvTotal = pvTotalKwh / steps;
  const stepEvFlatKwh = safeNum(evDemandKwh, 0) / steps;

  for (let step = 0; step < steps; step += 1) {
    const stepHouseDemand = safeNum(houseDemandKwh, 0) * minuteWeights[step];
    const stepEvDemand = stepEvFlatKwh;
    const stepDemandInput = stepHouseDemand + stepEvDemand;
    let demand = stepDemandInput;
    let pvRemaining = stepPvAc;
    let pvDcRemaining = stepPvDc;
    const inverterCapStep = inverterCapKwhPerSlot / steps;

    const pvToLoad = Math.min(pvRemaining, demand);
    pvRemaining -= pvToLoad;
    demand -= pvToLoad;
    pvToLoadTotal += pvToLoad;

    let stepDischargeToLoad = 0;
    let stepDischargeToExport = 0;
    let stepChargeFromPvStored = 0;
    let stepChargeFromGridStored = 0;
    let stepGridForBatteryCharge = 0;

    if (batteryEnabled && usableCapacityKwh > 0) {
      const forceChargeActive = forceChargeKw > 0 && socKwh < (targetSocKwh - 1e-9);
      const remainingInverterOutStep = Math.max(0, inverterCapStep - stepPvAc);
      const normalDischargeCap = Math.min(
        maxDischargeOutputKwh * (stepHours / SLOT_HOURS),
        remainingInverterOutStep,
        Math.max(0, (socKwh - minSocKwh) * dischargeEff),
      );

      if (!forceChargeActive) {
        stepDischargeToLoad = Math.min(demand, normalDischargeCap);
        if (stepDischargeToLoad > 0) {
          socKwh -= stepDischargeToLoad / dischargeEff;
          demand -= stepDischargeToLoad;
        }
      }

      if (!forceChargeActive && forceDischargeKw > 0) {
        const forceDischargeFloorSocKwh = Math.max(minSocKwh, safeNum(forceDischargeTargetSocKwh, minSocKwh));
        const forcedCap = Math.min(
          forceDischargeKw * stepHours * dischargeEff,
          remainingInverterOutStep,
          Math.max(0, (socKwh - forceDischargeFloorSocKwh) * dischargeEff),
        );
        stepDischargeToExport = Math.max(0, forcedCap);
        if (stepDischargeToExport > 0) {
          socKwh -= stepDischargeToExport / dischargeEff;
        }
      }

      const stepMaxChargeInput = maxChargeInputKwh * (stepHours / SLOT_HOURS);
      const storableCap = Math.max(0, Math.min(
        (maxSocKwh - socKwh),
        stepMaxChargeInput * chargeEff,
      ));
      const chargeFromPvDcStored = Math.min(storableCap, pvDcRemaining * chargeEff);
      if (chargeFromPvDcStored > 0) {
        pvDcRemaining -= chargeFromPvDcStored / chargeEff;
        socKwh += chargeFromPvDcStored;
      }

      const storableAfterDc = Math.max(0, storableCap - chargeFromPvDcStored);
      const chargeFromPvAcStored = Math.min(storableAfterDc, pvRemaining * chargeEff);
      if (chargeFromPvAcStored > 0) {
        pvRemaining -= chargeFromPvAcStored / chargeEff;
        socKwh += chargeFromPvAcStored;
      }
      stepChargeFromPvStored = chargeFromPvDcStored + chargeFromPvAcStored;

      if (forceChargeKw > 0) {
        const required = Math.max(0, targetSocKwh - socKwh);
        const forceStoreCap = Math.min(
          required,
          stepMaxChargeInput * chargeEff,
          forceChargeKw * stepHours * chargeEff,
        );
        stepChargeFromGridStored = Math.max(0, forceStoreCap);
        if (stepChargeFromGridStored > 0) {
          stepGridForBatteryCharge = stepChargeFromGridStored / chargeEff;
          socKwh += stepChargeFromGridStored;
        }
      }

      if (firstFullStep === null && maxSocKwh > 0 && socKwh >= (maxSocKwh - 1e-9)) {
        firstFullStep = step;
      }
    }

    let stepGridImport = Math.max(0, demand) + stepGridForBatteryCharge;
    const stepExportLimit = exportLimitKwh * (stepHours / SLOT_HOURS);

    // Battery cannot discharge-to-export beyond remaining export headroom after PV export.
    if (stepDischargeToExport > 0 && stepExportLimit >= 0) {
      const pvExportCandidate = Math.max(0, pvRemaining);
      const exportHeadroomForBattery = Math.max(0, stepExportLimit - pvExportCandidate);
      if (stepDischargeToExport > exportHeadroomForBattery) {
        const reduced = stepDischargeToExport - exportHeadroomForBattery;
        stepDischargeToExport = exportHeadroomForBattery;
        // Undo SOC drop for discharge that could not be exported.
        socKwh += reduced / Math.max(dischargeEff, 1e-9);
      }
    }

    const stepRawExport = Math.max(0, pvRemaining) + stepDischargeToExport;
    let stepGridExport = Math.min(stepRawExport, stepExportLimit);

    // Physical meter flow is net at any instant: cannot import and export simultaneously.
    if (stepGridImport > 0 && stepGridExport > 0) {
      if (stepGridImport >= stepGridExport) {
        stepGridImport -= stepGridExport;
        stepGridExport = 0;
      } else {
        stepGridExport -= stepGridImport;
        stepGridImport = 0;
      }
    }

    const stepCurtailed = Math.max(0, stepRawExport - stepGridExport) + Math.max(0, pvDcRemaining);

    dischargeToLoad += stepDischargeToLoad;
    dischargeToExport += stepDischargeToExport;
    chargeFromPvStored += stepChargeFromPvStored;
    chargeFromGridStored += stepChargeFromGridStored;
    gridImportKwh += stepGridImport;
    gridExportKwh += stepGridExport;
    curtailedKwh += stepCurtailed;
    demandRemainTotal += Math.max(0, demand);
    pvRemainTotal += Math.max(0, pvRemaining);

    maxImportKw = Math.max(maxImportKw, stepGridImport / stepHours);
    maxExportKw = Math.max(maxExportKw, stepGridExport / stepHours);

    if (minuteStartIndex !== null) {
      const minuteIndex = minuteStartIndex + step;
      const pvKw = stepHours > 0 ? stepPvTotal / stepHours : 0;
      const houseKw = stepHours > 0 ? stepHouseDemand / stepHours : 0;
      const evKw = stepHours > 0 ? stepEvDemand / stepHours : 0;
      const loadKw = stepHours > 0 ? stepDemandInput / stepHours : 0;
      const gridNetKw = stepHours > 0 ? (stepGridImport - stepGridExport) / stepHours : 0;
      const batteryNetKw = stepHours > 0
        ? (
          ((stepChargeFromPvStored / chargeEff) + stepGridForBatteryCharge)
          - (stepDischargeToLoad + stepDischargeToExport)
        ) / stepHours
        : 0;
      minuteTrace.push({
        minute: minuteIndex,
        pvKw,
        houseKw,
        evKw,
        loadKw,
        gridKw: gridNetKw,
        batteryKw: batteryNetKw,
        importKw: Math.max(gridNetKw, 0),
        exportKwNegative: Math.min(gridNetKw, 0),
        socKwh,
      });
    }
  }

  return {
    socKwh,
    demandRemainTotal,
    pvRemainTotal,
    dischargeToLoad,
    dischargeToExport,
    chargeFromPvStored,
    chargeFromGridStored,
    gridImportKwh,
    gridExportKwh,
    curtailedKwh,
    pvToLoadTotal,
    maxImportKw,
    maxExportKw,
    minuteTrace,
    firstFullStep,
  };
}

export async function simulateProject(project, tariffIds = null, selectedDay = null) {
  const simYear = 2025;
  const slots = getYearSlots(simYear);
  const pvByArray = await getPVGenerationSlotsByArray(project);
  const arraySlotsById = pvByArray?.byArrayId || {};
  const sunshineSlots = Array.isArray(pvByArray?.sunshineSlots) ? pvByArray.sunshineSlots : [];
  const tariffs = (project.tariffs || []).filter((t) => t.enabled !== false);
  const selectedTariffs = Array.isArray(tariffIds) && tariffIds.length
    ? tariffs.filter((t) => tariffIds.includes(t.id))
    : tariffs;

  const systems = buildSystems(project);
  const inverterCapKwhPerSlot = systems.reduce((acc, s) => acc + (safeNum(s.inverter?.acPowerKw, 5) * SLOT_HOURS), 0);

  const {
    batteryEnabled,
    usableCapacityKwh,
    minSocKwh,
    maxSocKwh,
    initialSocKwh,
    defaultTargetSocPercent,
    chargeEff,
    dischargeEff,
    maxChargeInputKwh,
    maxDischargeOutputKwh,
    degradationCostPerKwh,
    minSocPercentWeighted,
  } = aggregateBatteryFromSystems(systems);
  const forceChargeWindows = Array.isArray(project?.batteryControl?.forceChargeWindows)
    ? project.batteryControl.forceChargeWindows
    : [];
  const forceDischargeWindows = Array.isArray(project?.batteryControl?.forceDischargeWindows)
    ? project.batteryControl.forceDischargeWindows
    : [];

  const pvSlots = slots.map((_, idx) => getSlotPvSources({
    systems,
    arraySlotsById,
    slotIndex: idx,
  }));

  const exportLimitKwh = safeNum(project.exportLimitKw, 99) * SLOT_HOURS;
  const economics = project.economics || {};
  const selectedDayIso = typeof selectedDay === "string" && selectedDay.length === 10 ? selectedDay : null;
  const houseDemandSlots = slots.map((date) => getConsumptionForSlot(project, date));
  const evDemandSlots = buildEvDemandSlots(project.evs, slots);
  const minuteWeightsBySlot = Array.from({ length: SLOTS_PER_DAY }, (_, slot) => getMinuteWeightsForSlot(project.consumption, slot));
  const enabledArrays = (project.arrays || []).filter((a) => a.enabled !== false);
  const autoOptimizeForceCharge = project?.batteryControl?.autoOptimizeForceCharge === true;
  const autoOptimizeForceChargeStepPercent = Math.max(1, Math.min(50, Math.round(safeNum(project?.batteryControl?.autoOptimizeForceChargeStepPercent, 10))));

  const allTariffResults = selectedTariffs.map((tariff) => {
    const summary = buildTariffSummary();
    const vatFactor = 1 + safeNum(economics.importVatPercent, 0) / 100;
    const exportTaxFactor = 1 - safeNum(economics.exportTaxPercent, 0) / 100;
    const daySeries = selectedDayIso ? {
      day: selectedDayIso,
      slots: [],
      minutes: [],
      arrays: enabledArrays.map((a) => ({ id: a.id, name: a.name || a.id })),
      batteryUsableCapacityKwh: usableCapacityKwh,
    } : null;
    const importRateArray = getTariffRateArray(tariff, "import");
    const exportRateArray = getTariffRateArray(tariff, "export");
    let socKwh = Math.min(Math.max(initialSocKwh, minSocKwh), maxSocKwh);
    const dailyTotals = [];
    let currentDayIso = "";
    let dayAgg = null;
    let activeAutoForceTargetPercent = null;

    for (let i = 0; i < slots.length; i += 1) {
      const date = slots[i];
      const dayIso = toIsoDay(date);
      const month = date.getUTCMonth();
      const slot = getSlotIndex(date);
      const importRate = getRate(importRateArray, slot);
      const exportRate = getRate(exportRateArray, slot);

      if (dayIso !== currentDayIso) {
        if (dayAgg) {
          dayAgg.dayNetCost = dayAgg.importCost - dayAgg.exportRevenue;
          dayAgg.dayNetCashflow = dayAgg.exportRevenue - dayAgg.importCost;
          dailyTotals.push(dayAgg);
        }
        currentDayIso = dayIso;
        activeAutoForceTargetPercent = null;
        if (autoOptimizeForceCharge && usableCapacityKwh > 0 && forceChargeWindows.length > 0) {
          let dayEnd = i;
          while (dayEnd < slots.length && toIsoDay(slots[dayEnd]) === dayIso) {
            dayEnd += 1;
          }
          const dayIndexes = [];
          for (let idx = i; idx < dayEnd; idx += 1) dayIndexes.push(idx);
          activeAutoForceTargetPercent = optimizeForceChargeTargetForDay({
            dayIndexes,
            socStartKwh: socKwh,
            slots,
            houseDemandSlots,
            evDemandSlots,
            pvSlots,
            importRateArray,
            exportRateArray,
            vatFactor,
            exportTaxFactor,
            forceChargeWindows,
            forceDischargeWindows,
            defaultTargetSocPercent,
            minSocPercentWeighted,
            usableCapacityKwh,
            inverterCapKwhPerSlot,
            maxChargeInputKwh,
            maxDischargeOutputKwh,
            minSocKwh,
            maxSocKwh,
            chargeEff,
            dischargeEff,
            batteryEnabled,
            exportLimitKwh,
            minuteWeightsBySlot,
            stepPercent: autoOptimizeForceChargeStepPercent,
          });
        }
        dayAgg = {
          day: dayIso,
          loadKwh: 0,
          houseLoadKwh: 0,
          evLoadKwh: 0,
          pvKwh: 0,
          gridImportKwh: 0,
          gridExportKwh: 0,
          chargePvKwh: 0,
          chargeGridKwh: 0,
          dischargeLoadKwh: 0,
          dischargeExportKwh: 0,
          importCost: 0,
          exportRevenue: 0,
          socReached100At: "",
          forceChargeTargetSocPercent: activeAutoForceTargetPercent,
        };
      }

      const houseDemandKwh = safeNum(houseDemandSlots[i], 0);
      const evDemandKwh = safeNum(evDemandSlots[i], 0);
      const demandKwh = houseDemandKwh + evDemandKwh;
      const pvKwh = safeNum(pvSlots[i]?.pvTotalKwh, 0);
      const pvAcKwh = safeNum(pvSlots[i]?.pvAcKwh, 0);
      const pvDcToBatteryKwh = safeNum(pvSlots[i]?.pvDcToBatteryKwh, 0);
      const forceDischargeKw = sumWindowPowerKw(forceDischargeWindows, slot);
      const forceChargeKw = sumWindowPowerKw(forceChargeWindows, slot);
      const targetSocPercent = forceChargeKw > 0 && activeAutoForceTargetPercent !== null
        ? clampPercent(activeAutoForceTargetPercent, defaultTargetSocPercent)
        : getChargeTargetSoc(forceChargeWindows, slot, month, defaultTargetSocPercent);
      const forceDischargeTargetSocPercent = getDischargeTargetSoc(forceDischargeWindows, slot, minSocPercentWeighted);
      const targetSocKwh = usableCapacityKwh * targetSocPercent / 100;
      const forceDischargeTargetSocKwh = usableCapacityKwh * forceDischargeTargetSocPercent / 100;
      const socStartKwh = socKwh;

      summary.annual.loadKwh += demandKwh;
      summary.annual.houseLoadKwh += houseDemandKwh;
      summary.annual.evLoadKwh += evDemandKwh;
      summary.annual.pvKwh += pvKwh;
      summary.monthly[month].loadKwh += demandKwh;
      summary.monthly[month].houseLoadKwh += houseDemandKwh;
      summary.monthly[month].evLoadKwh += evDemandKwh;
      summary.monthly[month].pvKwh += pvKwh;
      const minuteWeights = minuteWeightsBySlot[slot];

      const dispatch = runDispatchForSlot({
        houseDemandKwh,
        evDemandKwh,
        pvAcKwh,
        pvDcToBatteryKwh,
        pvTotalKwh: pvKwh,
        socKwh,
        minuteWeights,
        inverterCapKwhPerSlot,
        maxChargeInputKwh,
        maxDischargeOutputKwh,
        minSocKwh,
        maxSocKwh,
        chargeEff,
        dischargeEff,
        batteryEnabled,
        usableCapacityKwh,
        forceDischargeKw,
        forceDischargeTargetSocKwh,
        forceChargeKw,
        targetSocKwh,
        exportLimitKwh,
        minuteStartIndex: daySeries && toIsoDay(date) === selectedDayIso ? slot * 30 : null,
      });

      socKwh = dispatch.socKwh;
      const dischargeToLoad = dispatch.dischargeToLoad;
      const dischargeToExport = dispatch.dischargeToExport;
      const chargeFromPvStored = dispatch.chargeFromPvStored;
      const chargeFromGridStored = dispatch.chargeFromGridStored;
      const gridImportKwh = dispatch.gridImportKwh;
      const gridExportKwh = dispatch.gridExportKwh;
      const curtailedKwh = dispatch.curtailedKwh;
      const pvToLoad = dispatch.pvToLoadTotal;

      summary.annual.batteryChargeFromPvKwh += chargeFromPvStored;
      summary.annual.batteryChargeFromGridKwh += chargeFromGridStored;
      summary.annual.batteryDischargeToLoadKwh += dischargeToLoad;
      summary.annual.batteryDischargeToExportKwh += dischargeToExport;
      summary.annual.batteryThroughputKwh += (chargeFromPvStored + chargeFromGridStored + dischargeToLoad + dischargeToExport);
      summary.annual.gridImportKwh += gridImportKwh;
      summary.annual.gridExportKwh += gridExportKwh;
      summary.annual.pvCurtailedKwh += curtailedKwh;
      summary.annual.peakImportKw = Math.max(summary.annual.peakImportKw, dispatch.maxImportKw);
      summary.annual.peakExportKw = Math.max(summary.annual.peakExportKw, dispatch.maxExportKw);

      summary.monthly[month].gridImportKwh += gridImportKwh;
      summary.monthly[month].gridExportKwh += gridExportKwh;

      const importCost = gridImportKwh * importRate;
      const exportRevenue = gridExportKwh * exportRate;
      const baselineImportCost = demandKwh * importRate;
      const importCostWithVat = importCost * vatFactor;
      const exportRevenueAfterTax = exportRevenue * exportTaxFactor;

      summary.annual.importCost += importCost;
      summary.annual.exportRevenue += exportRevenue;
      summary.annual.baselineCost += baselineImportCost;
      summary.monthly[month].importCost += importCost;
      summary.monthly[month].exportRevenue += exportRevenue;
      summary.monthly[month].baselineCost += baselineImportCost;

      dayAgg.loadKwh += demandKwh;
      dayAgg.houseLoadKwh += houseDemandKwh;
      dayAgg.evLoadKwh += evDemandKwh;
      dayAgg.pvKwh += pvKwh;
      dayAgg.gridImportKwh += gridImportKwh;
      dayAgg.gridExportKwh += gridExportKwh;
      dayAgg.chargePvKwh += chargeFromPvStored;
      dayAgg.chargeGridKwh += chargeFromGridStored;
      dayAgg.dischargeLoadKwh += dischargeToLoad;
      dayAgg.dischargeExportKwh += dischargeToExport;
      dayAgg.importCost += importCostWithVat;
      dayAgg.exportRevenue += exportRevenueAfterTax;
      if (!dayAgg.socReached100At && dispatch.firstFullStep !== null && maxSocKwh > 0) {
        const stepCount = minuteWeights.length;
        const minuteOffset = Math.floor(dispatch.firstFullStep * (30 / Math.max(1, stepCount)));
        const minuteOfDay = (slot * 30) + minuteOffset;
        dayAgg.socReached100At = minuteToTimeLabel(minuteOfDay);
      }

      if (daySeries && toIsoDay(date) === selectedDayIso) {
        const slotArrayPvKwh = {};
        for (const arr of enabledArrays) {
          slotArrayPvKwh[arr.id] = safeNum(arraySlotsById[arr.id]?.[i], 0);
        }
        daySeries.minutes.push(...dispatch.minuteTrace);
        daySeries.slots.push({
          slot,
          time: toSlotLabel(slot),
          socStartKwh,
          loadKwh: demandKwh,
          houseLoadKwh: houseDemandKwh,
          evLoadKwh: evDemandKwh,
          pvKwh,
          pvToLoadKwh: pvToLoad,
          batteryChargeFromPvKwh: chargeFromPvStored,
          batteryChargeFromGridKwh: chargeFromGridStored,
          batteryDischargeToLoadKwh: dischargeToLoad,
          batteryDischargeToExportKwh: dischargeToExport,
          gridImportKwh,
          gridExportKwh,
          curtailedKwh,
          socKwh,
          importRate,
          exportRate,
          importCost: importCostWithVat,
          exportRevenue: exportRevenueAfterTax,
          arrayPvKwh: slotArrayPvKwh,
          sunshineWm2: safeNum(sunshineSlots[i], 0),
        });
      }
    }

    if (dayAgg) {
      dayAgg.dayNetCost = dayAgg.importCost - dayAgg.exportRevenue;
      dayAgg.dayNetCashflow = dayAgg.exportRevenue - dayAgg.importCost;
      dailyTotals.push(dayAgg);
    }

    const days = slots.length / SLOTS_PER_DAY;

    summary.annual.importCost *= vatFactor;
    summary.annual.exportRevenue *= exportTaxFactor;
    summary.annual.baselineCost *= vatFactor;
    summary.annual.standingCharge = days * safeNum(tariff.standingChargePerDay, 0);
    summary.annual.maintenanceCost = safeNum(economics.annualMaintenanceCost, 0);
    summary.annual.batteryDegradationCost = summary.annual.batteryThroughputKwh * safeNum(degradationCostPerKwh, 0);
    summary.annual.co2Kg = summary.annual.gridImportKwh * safeNum(economics.co2KgPerKwhGrid, 0);

    summary.annual.totalCost =
      summary.annual.importCost +
      summary.annual.standingCharge +
      summary.annual.maintenanceCost +
      summary.annual.batteryDegradationCost -
      summary.annual.exportRevenue;
    summary.annual.baselineCost += summary.annual.standingCharge;
    summary.annual.savingsVsBaseline = summary.annual.baselineCost - summary.annual.totalCost;

    summary.annual.autarkyPercent = summary.annual.loadKwh
      ? ((summary.annual.loadKwh - summary.annual.gridImportKwh) / summary.annual.loadKwh) * 100
      : 0;

    const pvConsumed = summary.annual.pvUsedDirectKwh + summary.annual.batteryChargeFromPvKwh;
    summary.annual.selfConsumptionPercent = summary.annual.pvKwh
      ? (pvConsumed / summary.annual.pvKwh) * 100
      : 0;

    summary.annual.estimatedCycles = usableCapacityKwh
      ? summary.annual.batteryThroughputKwh / (2 * usableCapacityKwh)
      : 0;

    for (let m = 0; m < 12; m += 1) {
      summary.monthly[m].importCost *= vatFactor;
      summary.monthly[m].exportRevenue *= exportTaxFactor;
      summary.monthly[m].baselineCost *= vatFactor;
      summary.monthly[m].standingCharge = daysInMonthUtc(simYear, m) * safeNum(tariff.standingChargePerDay, 0);
      summary.monthly[m].netCost = summary.monthly[m].importCost - summary.monthly[m].exportRevenue;
      summary.monthly[m].totalCost = summary.monthly[m].netCost + summary.monthly[m].standingCharge;
      summary.monthly[m].savingsVsBaseline = (summary.monthly[m].baselineCost + summary.monthly[m].standingCharge) - summary.monthly[m].totalCost;
    }

    return {
      tariffId: tariff.id,
      tariffName: tariff.name,
      summary,
      dailySeries: daySeries,
      dailyTotals,
    };
  });

  const output = {
    year: simYear,
    location: project.location,
    results: allTariffResults,
    assumptions: {
      pvgisYearProxy: 2020,
      simulationYear: simYear,
      slotsPerDay: 48,
      note: "PV uses PVGIS seriescalc hourly production for 2020 as a typical-year proxy.",
    },
  };

  return roundNumbersDeep(output);
}
