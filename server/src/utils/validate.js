import { SLOTS_PER_DAY } from "./time.js";

function assertArrayLen(arr, len, path) {
  if (!Array.isArray(arr) || arr.length !== len) {
    throw new Error(`${path} must be an array with length ${len}`);
  }
}

export function validateProject(project) {
  if (!project || typeof project !== "object") {
    throw new Error("Project payload is required");
  }

  if (!project.location || Number.isNaN(Number(project.location.latitude)) || Number.isNaN(Number(project.location.longitude))) {
    throw new Error("Location latitude/longitude are required numbers");
  }

  if (!Array.isArray(project.arrays) || !project.arrays.length) {
    throw new Error("At least one array is required");
  }

  project.arrays.forEach((a, idx) => {
    if (Number(a.peakPowerKw) <= 0) {
      throw new Error(`arrays[${idx}].peakPowerKw must be > 0`);
    }
  });

  if (!Array.isArray(project.systems) || project.systems.length === 0) {
    throw new Error("At least one system is required");
  }
  project.systems.forEach((s, idx) => {
    if (!Array.isArray(s.arrayIds)) {
      throw new Error(`systems[${idx}].arrayIds must be an array`);
    }
    if (!s.inverter || Number(s.inverter.acPowerKw) <= 0) {
      throw new Error(`systems[${idx}].inverter.acPowerKw must be > 0`);
    }
    if (!s.battery || typeof s.battery !== "object") {
      throw new Error(`systems[${idx}].battery is required`);
    }
  });

  if (project.batteryControl && typeof project.batteryControl !== "object") {
    throw new Error("batteryControl must be an object");
  }
  if (project.batteryControl?.autoOptimizeForceCharge !== undefined && typeof project.batteryControl.autoOptimizeForceCharge !== "boolean") {
    throw new Error("batteryControl.autoOptimizeForceCharge must be boolean");
  }
  if (project.batteryControl?.autoOptimizeForceChargeStepPercent !== undefined) {
    const n = Number(project.batteryControl.autoOptimizeForceChargeStepPercent);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      throw new Error("batteryControl.autoOptimizeForceChargeStepPercent must be in range 1..50");
    }
  }
  if (project.batteryControl?.forceChargeWindows && !Array.isArray(project.batteryControl.forceChargeWindows)) {
    throw new Error("batteryControl.forceChargeWindows must be an array");
  }
  if (project.batteryControl?.forceDischargeWindows && !Array.isArray(project.batteryControl.forceDischargeWindows)) {
    throw new Error("batteryControl.forceDischargeWindows must be an array");
  }
  if (Array.isArray(project.batteryControl?.forceChargeWindows)) {
    project.batteryControl.forceChargeWindows.forEach((w, idx) => {
      if (w?.targetSocPercentByMonth !== undefined) {
        assertArrayLen(w.targetSocPercentByMonth, 12, `batteryControl.forceChargeWindows[${idx}].targetSocPercentByMonth`);
        if (w.targetSocPercentByMonth.some((v) => Number.isNaN(Number(v)))) {
          throw new Error(`batteryControl.forceChargeWindows[${idx}].targetSocPercentByMonth must contain numeric values`);
        }
      }
    });
  }

  if (project.consumption?.slotKwh) {
    assertArrayLen(project.consumption.slotKwh, SLOTS_PER_DAY, "consumption.slotKwh");
  }
  if (project.consumption?.minuteShapeKw) {
    assertArrayLen(project.consumption.minuteShapeKw, 1440, "consumption.minuteShapeKw");
  }

  if (project.evs) {
    if (!Array.isArray(project.evs)) {
      throw new Error("evs must be an array");
    }

    project.evs.forEach((ev, idx) => {
      if (ev?.chargeDays && !Array.isArray(ev.chargeDays)) {
        throw new Error(`evs[${idx}].chargeDays must be a 7-item boolean array`);
      }
      if (Array.isArray(ev?.chargeDays)) {
        assertArrayLen(ev.chargeDays, 7, `evs[${idx}].chargeDays`);
      }
    });
  }

  if (project.tariffs) {
    project.tariffs.forEach((t, idx) => {
      if (Array.isArray(t.importRate)) {
        assertArrayLen(t.importRate, SLOTS_PER_DAY, `tariffs[${idx}].importRate`);
      } else {
        assertArrayLen(t.importRateWeekday, SLOTS_PER_DAY, `tariffs[${idx}].importRateWeekday`);
      }

      if (Array.isArray(t.exportRate)) {
        assertArrayLen(t.exportRate, SLOTS_PER_DAY, `tariffs[${idx}].exportRate`);
      } else {
        assertArrayLen(t.exportRateWeekday, SLOTS_PER_DAY, `tariffs[${idx}].exportRateWeekday`);
      }
    });
  }
}
