import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  Area,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Bar,
} from "recharts";
import {
  fetchOctopusAvailableTariffs,
  fetchProject,
  importHomeAssistantCsv,
  importOctopusTariff,
  importOctopusYearTariffs,
  runSimulation,
  saveProject,
} from "./lib/api";

const EMPTY_48 = Array(48).fill(0.25);

function toCsv48(arr) {
  const normalized = Array.isArray(arr) ? arr : EMPTY_48;
  return normalized.map((n) => Number(n || 0).toFixed(4)).join(", ");
}

function fromCsv48(value, fallback = 0) {
  const vals = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));

  if (vals.length !== 48 || vals.some((n) => Number.isNaN(n))) {
    throw new Error("Expected exactly 48 numeric comma-separated values");
  }

  return vals.map((n) => Number.isFinite(n) ? n : fallback);
}

function fromCsv12(value, fallback = 1) {
  const vals = String(value || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));

  if (vals.length !== 12 || vals.some((n) => Number.isNaN(n))) {
    throw new Error("Expected exactly 12 numeric values");
  }

  return vals.map((n) => Number.isFinite(n) ? n : fallback);
}

function toCsv12(arr) {
  const normalized = Array.isArray(arr) && arr.length === 12 ? arr : Array(12).fill(1);
  return normalized.map((n) => Number(n || 1).toFixed(4)).join(", ");
}

function fromHourly24(value) {
  const vals = String(value || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));

  if (vals.length !== 24 || vals.some((n) => Number.isNaN(n))) {
    throw new Error("Expected exactly 24 numeric values for hourly consumption");
  }

  const slotKwh = [];
  const minuteShapeKw = [];
  for (const hourKwh of vals) {
    const halfHourKwh = Number(hourKwh) / 2;
    slotKwh.push(halfHourKwh, halfHourKwh);
    const hourKw = Number(hourKwh);
    for (let m = 0; m < 60; m += 1) {
      minuteShapeKw.push(hourKw);
    }
  }
  return { slotKwh, minuteShapeKw };
}

function fmtCurrency(v) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(v || 0);
}

function fmtSignedCurrency(v) {
  const n = Number(v || 0);
  if (n > 0) return `+${fmtCurrency(Math.abs(n))}`;
  if (n < 0) return `-${fmtCurrency(Math.abs(n))}`;
  return fmtCurrency(0);
}

function fmtNum(v, digits = 1) {
  return Number(v || 0).toFixed(digits);
}

function roundTo(value, digits = 3) {
  const n = Number(value || 0);
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function slotToTime(slot) {
  const safe = Math.max(0, Math.min(47, Number(slot) || 0));
  const hours = String(Math.floor(safe / 2)).padStart(2, "0");
  const mins = safe % 2 === 0 ? "00" : "30";
  return `${hours}:${mins}`;
}

function timeToSlot(value) {
  const [h, m] = String(value || "00:00").split(":");
  const hours = Math.max(0, Math.min(23, Number(h) || 0));
  const mins = Number(m) >= 30 ? 1 : 0;
  return (hours * 2) + mins;
}

const MODEL_DAY_MIN = "2025-01-01";
const MODEL_DAY_MAX = "2025-12-31";

function shiftIsoDay(isoDay, deltaDays) {
  const base = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return isoDay;
  base.setUTCDate(base.getUTCDate() + deltaDays);
  const shifted = base.toISOString().slice(0, 10);
  if (shifted < MODEL_DAY_MIN) return MODEL_DAY_MIN;
  if (shifted > MODEL_DAY_MAX) return MODEL_DAY_MAX;
  return shifted;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_OPTIONS = [
  { idx: 1, label: "Mon" },
  { idx: 2, label: "Tue" },
  { idx: 3, label: "Wed" },
  { idx: 4, label: "Thu" },
  { idx: 5, label: "Fri" },
  { idx: 6, label: "Sat" },
  { idx: 0, label: "Sun" },
];

function normalizeChargeDays(days) {
  if (Array.isArray(days) && days.length === 7) {
    return days.map((v) => v === true);
  }
  return [false, true, true, true, true, true, false];
}

function defaultSystemBattery() {
  return {
    enabled: true,
    capacityKwh: 10,
    usableCapacityPercent: 95,
    initialSocPercent: 50,
    minSocPercent: 15,
    targetSocPercent: 70,
    maxChargeKw: 5,
    maxDischargeKw: 5,
    chargeEfficiencyPercent: 95,
    dischargeEfficiencyPercent: 95,
    degradationCostPerKwh: 0.01,
  };
}

function defaultBatteryControl() {
  return {
    forceChargeWindows: [],
    forceDischargeWindows: [],
    autoOptimizeForceCharge: false,
    autoOptimizeForceChargeStepPercent: 10,
  };
}

function normalizeProject(p) {
  const systems = Array.isArray(p?.systems) && p.systems.length
    ? p.systems.map((s, idx) => ({
      id: s.id || `system-${idx + 1}`,
      name: s.name || `System ${idx + 1}`,
      arrayIds: Array.isArray(s.arrayIds) ? s.arrayIds : [],
      inverter: {
        acPowerKw: Number(s?.inverter?.acPowerKw ?? 5),
        efficiencyPercent: Number(s?.inverter?.efficiencyPercent ?? 97),
      },
      battery: { ...defaultSystemBattery(), ...(s?.battery || {}) },
      batteryCoupling: s?.batteryCoupling === "dc" ? "dc" : "ac",
    }))
    : [];

  return {
    ...p,
    systems,
    pvgis: {
      sourceYear: Number(p?.pvgis?.sourceYear ?? 2020),
    },
    batteryControl: {
      ...defaultBatteryControl(),
      ...(p?.batteryControl || {}),
      autoOptimizeForceCharge: p?.batteryControl?.autoOptimizeForceCharge === true,
      autoOptimizeForceChargeStepPercent: Number(p?.batteryControl?.autoOptimizeForceChargeStepPercent ?? 10),
    },
    evs: Array.isArray(p?.evs)
      ? p.evs.map((ev) => ({ ...ev, chargeDays: normalizeChargeDays(ev?.chargeDays) }))
      : [],
  };
}

function DaySeriesChart({ series }) {
  const [lineVisible, setLineVisible] = useState({
    pv: true,
    house: true,
    ev: true,
    grid: true,
    battery: true,
  });

  if (!series?.slots?.length) {
    return <p className="muted">No day data available for selected date.</p>;
  }

  const slotData = series.slots.map((s) => ({
    ...s,
    gridExportNegativeKwh: -Number(s.gridExportKwh || 0),
    forcedMode: Number(s.batteryChargeFromGridKwh || 0) > 0
      ? "FC"
      : (Number(s.batteryDischargeToExportKwh || 0) > 0 ? "FD" : ""),
    batteryDischargeKwh: Number(s.batteryDischargeToLoadKwh || 0) + Number(s.batteryDischargeToExportKwh || 0),
  }));
  const batteryUsableCapacityKwh = Number(series?.batteryUsableCapacityKwh || 0);
  const socCapacityKwh = batteryUsableCapacityKwh > 0
    ? batteryUsableCapacityKwh
    : Math.max(1, ...slotData.map((s) => Number(s.socKwh || 0)));
  const socFullThreshold = socCapacityKwh - 0.001;
  const socChartData = slotData.map((s) => ({
    ...s,
    socPercent: roundTo((Number(s.socKwh || 0) / socCapacityKwh) * 100, 2),
  }));
  const reachedSoc100Minute = Array.isArray(series.minutes)
    ? series.minutes.find((m) => Number(m.socKwh || 0) >= socFullThreshold)
    : null;
  const reachedSoc100Slot = slotData.find((s) => Number(s.socKwh || 0) >= socFullThreshold);
  const socReached100At = reachedSoc100Minute
    ? minuteToClockLabel(Number(reachedSoc100Minute.minute || 0))
    : (reachedSoc100Slot ? reachedSoc100Slot.time : "Not reached");

  const sum = (key) => slotData.reduce((acc, h) => acc + Number(h[key] || 0), 0);
  const totals = {
    loadKwh: sum("loadKwh"),
    houseLoadKwh: sum("houseLoadKwh"),
    evLoadKwh: sum("evLoadKwh"),
    pvKwh: sum("pvKwh"),
    gridImportKwh: sum("gridImportKwh"),
    gridExportKwh: sum("gridExportKwh"),
    chargePvKwh: sum("batteryChargeFromPvKwh"),
    chargeGridKwh: sum("batteryChargeFromGridKwh"),
    dischargeLoadKwh: sum("batteryDischargeToLoadKwh"),
    dischargeExportKwh: sum("batteryDischargeToExportKwh"),
    importCost: sum("importCost"),
    exportRevenue: sum("exportRevenue"),
  };
  const dayNetCost = totals.importCost - totals.exportRevenue;
  const dayNetCashflow = -dayNetCost;
  const moneyClass = (v) => (Number(v || 0) >= 0 ? "metric-value positive" : "metric-value negative");
  const pvArrayMeta = Array.isArray(series?.arrays) ? series.arrays : [];
  const pvArrayColors = ["#2563eb", "#16a34a", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#a16207", "#4f46e5"];
  const [pvArrayVisible, setPvArrayVisible] = useState({});
  useEffect(() => {
    setPvArrayVisible((prev) => {
      const next = {};
      for (const arr of pvArrayMeta) {
        next[arr.id] = prev[arr.id] ?? true;
      }
      return next;
    });
  }, [series?.day, pvArrayMeta.map((a) => a.id).join(",")]);
  const hasSunshine = slotData.some((s) => Number(s.sunshineWm2 || 0) > 0);
  const pvArrayChartData = slotData.map((s) => {
    const row = { time: s.time };
    for (const arr of pvArrayMeta) {
      row[`arr_${arr.id}`] = Number(s.arrayPvKwh?.[arr.id] || 0);
    }
    return row;
  });
  const slotChartData = slotData.map((s) => {
    const batteryNetKwh = (
      Number(s.batteryChargeFromPvKwh || 0)
      + Number(s.batteryChargeFromGridKwh || 0)
      - Number(s.batteryDischargeToLoadKwh || 0)
      - Number(s.batteryDischargeToExportKwh || 0)
    );
    return {
      ...s,
      gridNetKwh: Number(s.gridImportKwh || 0) - Number(s.gridExportKwh || 0),
      batteryNetKwh,
    };
  });
  const slotPowerData = slotChartData.map((s) => ({
    ...s,
    pvKw: Number(s.pvKwh || 0) / 0.5,
    houseKw: Number(s.houseLoadKwh || 0) / 0.5,
    evKw: Number(s.evLoadKwh || 0) / 0.5,
    gridNetKw: Number(s.gridNetKwh || 0) / 0.5,
    batteryNetKw: Number(s.batteryNetKwh || 0) / 0.5,
  }));
  const hourlyData = [];
  for (let i = 0; i < slotData.length; i += 2) {
    const a = slotData[i];
    const b = slotData[i + 1] || null;
    const importKwh = Number(a?.gridImportKwh || 0) + Number(b?.gridImportKwh || 0);
    const exportKwh = Number(a?.gridExportKwh || 0) + Number(b?.gridExportKwh || 0);
    const importRate = importKwh > 0
      ? (
        ((Number(a?.importRate || 0) * Number(a?.gridImportKwh || 0))
          + (Number(b?.importRate || 0) * Number(b?.gridImportKwh || 0)))
        / importKwh
      )
      : ((Number(a?.importRate || 0) + Number(b?.importRate || 0)) / (b ? 2 : 1));
    const exportRate = exportKwh > 0
      ? (
        ((Number(a?.exportRate || 0) * Number(a?.gridExportKwh || 0))
          + (Number(b?.exportRate || 0) * Number(b?.gridExportKwh || 0)))
        / exportKwh
      )
      : ((Number(a?.exportRate || 0) + Number(b?.exportRate || 0)) / (b ? 2 : 1));
    const modes = [a?.forcedMode, b?.forcedMode].filter(Boolean);
    const forcedMode = [...new Set(modes)].join("/");

    hourlyData.push({
      time: a?.time || "",
      houseLoadKwh: Number(a?.houseLoadKwh || 0) + Number(b?.houseLoadKwh || 0),
      evLoadKwh: Number(a?.evLoadKwh || 0) + Number(b?.evLoadKwh || 0),
      loadKwh: Number(a?.loadKwh || 0) + Number(b?.loadKwh || 0),
      pvKwh: Number(a?.pvKwh || 0) + Number(b?.pvKwh || 0),
      forcedMode,
      batteryDischargeKwh: Number(a?.batteryDischargeKwh || 0) + Number(b?.batteryDischargeKwh || 0),
      socKwh: Number(b?.socKwh ?? a?.socKwh ?? 0),
      gridImportKwh: importKwh,
      importRate,
      importCost: Number(a?.importCost || 0) + Number(b?.importCost || 0),
      gridExportKwh: exportKwh,
      exportRate,
      exportRevenue: Number(a?.exportRevenue || 0) + Number(b?.exportRevenue || 0),
    });
  }

  return (
    <div className="daily-charts">
      <div className="chart-wrap">
        <h4>Daily Totals</h4>
        <div className="daily-totals-dashboard">
          <div className="metric-card">
            <p className="metric-label">Load (Total)</p>
            <p className="metric-value">{fmtNum(totals.loadKwh, 2)} kWh</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Load (House / EV)</p>
            <p className="metric-value">{fmtNum(totals.houseLoadKwh, 2)} / {fmtNum(totals.evLoadKwh, 2)} kWh</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">PV</p>
            <p className="metric-value">{fmtNum(totals.pvKwh, 2)} kWh</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Import / Export</p>
            <p className="metric-value">{fmtNum(totals.gridImportKwh, 2)} / {fmtNum(totals.gridExportKwh, 2)} kWh</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Bat Charge (PV / Grid)</p>
            <p className="metric-value">{fmtNum(totals.chargePvKwh, 2)} / {fmtNum(totals.chargeGridKwh, 2)} kWh</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Bat Discharge (Load / Export)</p>
            <p className="metric-value">{fmtNum(totals.dischargeLoadKwh, 2)} / {fmtNum(totals.dischargeExportKwh, 2)} kWh</p>
          </div>
          <div className="metric-card money">
            <p className="metric-label">Import Cost</p>
            <p className={moneyClass(-totals.importCost)}>{fmtSignedCurrency(-totals.importCost)}</p>
          </div>
          <div className="metric-card money">
            <p className="metric-label">Export Revenue</p>
            <p className={moneyClass(totals.exportRevenue)}>{fmtSignedCurrency(totals.exportRevenue)}</p>
          </div>
          <div className="metric-card money">
            <p className="metric-label">Day Net Cashflow</p>
            <p className={moneyClass(dayNetCashflow)}>{fmtSignedCurrency(dayNetCashflow)}</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">SOC Reached 100% At</p>
            <p className="metric-value">{socReached100At}</p>
          </div>
        </div>
      </div>

      <div className="chart-wrap">
        <h4>Battery State of Charge (SOC)</h4>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={socChartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" interval={1} minTickGap={14} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${fmtNum(v, 0)}%`} />
            <Tooltip formatter={(value) => [`${fmtNum(value, 2)}%`, "SOC"]} />
            <Legend />
            <Area type="linear" dataKey="socPercent" name="SOC (%)" fill="#9bd7e8" stroke="#3b82f6" strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-wrap">
        <h4>PV Generation vs House Consumption (kW)</h4>
        <div className="line-toggles">
          <label className="check"><input type="checkbox" checked={lineVisible.pv} onChange={(e) => setLineVisible((v) => ({ ...v, pv: e.target.checked }))} /> PV</label>
          <label className="check"><input type="checkbox" checked={lineVisible.house} onChange={(e) => setLineVisible((v) => ({ ...v, house: e.target.checked }))} /> House</label>
          <label className="check"><input type="checkbox" checked={lineVisible.ev} onChange={(e) => setLineVisible((v) => ({ ...v, ev: e.target.checked }))} /> EV</label>
          <label className="check"><input type="checkbox" checked={lineVisible.grid} onChange={(e) => setLineVisible((v) => ({ ...v, grid: e.target.checked }))} /> Grid Net</label>
          <label className="check"><input type="checkbox" checked={lineVisible.battery} onChange={(e) => setLineVisible((v) => ({ ...v, battery: e.target.checked }))} /> Battery</label>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={slotPowerData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" interval={1} minTickGap={14} />
            <YAxis tickFormatter={(v) => `${fmtNum(v, 3)} kW`} />
            <ReferenceLine y={0} stroke="#6b7280" strokeWidth={2} strokeDasharray="4 4" />
            <Tooltip
              labelFormatter={(v) => String(v)}
              formatter={(value, name) => {
                const kw = Number(value || 0);
                return [`${fmtNum(kw, 3)} kW`, name];
              }}
            />
            <Legend />
            {lineVisible.pv ? <Line type="monotone" dataKey="pvKw" name="PV Generation (kW)" stroke="#2563eb" dot={false} strokeWidth={2} /> : null}
            {lineVisible.house ? <Line type="monotone" dataKey="houseKw" name="House Consumption (kW)" stroke="#f59e0b" dot={false} strokeWidth={2} /> : null}
            {lineVisible.ev ? <Line type="monotone" dataKey="evKw" name="EV Charging (kW)" stroke="#14b8a6" dot={false} strokeWidth={2} /> : null}
            {lineVisible.grid ? <Line type="monotone" dataKey="gridNetKw" name="Grid Net (kW)" stroke="#ef4444" dot={false} strokeWidth={2} /> : null}
            {lineVisible.battery ? <Line type="monotone" dataKey="batteryNetKw" name="Battery Net (kW)" stroke="#8b5cf6" dot={false} strokeWidth={2} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {lineVisible.pv ? (
        <div className="chart-wrap">
          <h4>PV Generation (kW)</h4>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={slotPowerData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis tickFormatter={(v) => `${fmtNum(v, 3)} kW`} />
              <ReferenceLine y={0} stroke="#6b7280" strokeWidth={2} strokeDasharray="4 4" />
              <Tooltip formatter={(value) => [`${fmtNum(value, 3)} kW`, "PV Generation (kW)"]} />
              <Line type="monotone" dataKey="pvKw" name="PV Generation (kW)" stroke="#2563eb" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {lineVisible.house ? (
        <div className="chart-wrap">
          <h4>House Consumption (kW)</h4>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={slotPowerData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis tickFormatter={(v) => `${fmtNum(v, 3)} kW`} />
              <ReferenceLine y={0} stroke="#6b7280" strokeWidth={2} strokeDasharray="4 4" />
              <Tooltip formatter={(value) => [`${fmtNum(value, 3)} kW`, "House Consumption (kW)"]} />
              <Line type="monotone" dataKey="houseKw" name="House Consumption (kW)" stroke="#f59e0b" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {lineVisible.ev ? (
        <div className="chart-wrap">
          <h4>EV Charging (kW)</h4>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={slotPowerData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis tickFormatter={(v) => `${fmtNum(v, 3)} kW`} />
              <ReferenceLine y={0} stroke="#6b7280" strokeWidth={2} strokeDasharray="4 4" />
              <Tooltip formatter={(value) => [`${fmtNum(value, 3)} kW`, "EV Charging (kW)"]} />
              <Line type="monotone" dataKey="evKw" name="EV Charging (kW)" stroke="#14b8a6" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {lineVisible.grid ? (
        <div className="chart-wrap">
          <h4>Grid Net (kW)</h4>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={slotPowerData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis tickFormatter={(v) => `${fmtNum(v, 3)} kW`} />
              <ReferenceLine y={0} stroke="#6b7280" strokeWidth={2} strokeDasharray="4 4" />
              <Tooltip formatter={(value) => [`${fmtNum(value, 3)} kW`, "Grid Net (kW)"]} />
              <Line type="monotone" dataKey="gridNetKw" name="Grid Net (kW)" stroke="#ef4444" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {lineVisible.battery ? (
        <div className="chart-wrap">
          <h4>Battery Net (kW)</h4>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={slotPowerData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis tickFormatter={(v) => `${fmtNum(v, 3)} kW`} />
              <ReferenceLine y={0} stroke="#6b7280" strokeWidth={2} strokeDasharray="4 4" />
              <Tooltip formatter={(value) => [`${fmtNum(value, 3)} kW`, "Battery Net (kW)"]} />
              <Line type="monotone" dataKey="batteryNetKw" name="Battery Net (kW)" stroke="#8b5cf6" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {pvArrayMeta.length ? (
        <div className="chart-wrap">
          <h4>PV Generation by Array (Stacked)</h4>
          <div className="line-toggles">
            {pvArrayMeta.map((arr) => (
              <label key={`pv-arr-toggle-${arr.id}`} className="check">
                <input
                  type="checkbox"
                  checked={pvArrayVisible[arr.id] !== false}
                  onChange={(e) => setPvArrayVisible((prev) => ({ ...prev, [arr.id]: e.target.checked }))}
                />
                {arr.name || arr.id}
              </label>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={pvArrayChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis />
              <Tooltip />
              <Legend />
              {pvArrayMeta.map((arr, idx) => (
                pvArrayVisible[arr.id] !== false ? (
                  <Area
                    key={`pv-arr-${arr.id}`}
                    type="linear"
                    dataKey={`arr_${arr.id}`}
                    name={`${arr.name} (kWh)`}
                    stackId="pv"
                    stroke={pvArrayColors[idx % pvArrayColors.length]}
                    fill={pvArrayColors[idx % pvArrayColors.length]}
                    fillOpacity={0.35}
                  />
                ) : null
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {hasSunshine ? (
        <div className="chart-wrap">
          <h4>PVGIS Sunshine Level</h4>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={slotData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" interval={1} minTickGap={14} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="linear" dataKey="sunshineWm2" name="Sunshine (W/m²)" stroke="#f59e0b" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      <div className="chart-wrap">
        <h4>Energy Tariff</h4>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={slotData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" interval={1} minTickGap={14} />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line type="stepAfter" dataKey="importRate" name="Import Price (GBP/kWh)" stroke="#ef4444" dot={false} strokeWidth={2} />
            <Line type="stepAfter" dataKey="exportRate" name="Export Price (GBP/kWh)" stroke="#22c55e" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-wrap">
        <div className="chart-title-row">
          <h4>Energy Import / Export</h4>
          <p className="totals-inline">
            <span className="red">{fmtNum(totals.gridImportKwh, 2)} kWh</span> / <span className="green">{fmtNum(totals.gridExportKwh, 2)} kWh</span>
          </p>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={slotData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" interval={1} minTickGap={14} />
            <YAxis />
            <Tooltip
              formatter={(value, name) => [`${fmtNum(value, 3)} kWh`, name]}
            />
            <Legend />
            <Line type="linear" dataKey="gridImportKwh" name="Import (kWh)" stroke="#ef4444" dot={false} strokeWidth={2} />
            <Line type="linear" dataKey="gridExportNegativeKwh" name="Export (kWh)" stroke="#22c55e" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-wrap">
        <h4>Detailed Calculations (1h)</h4>
        <div className="monthly-wrap">
          <table className="monthly-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>House kWh</th>
                <th>EV kWh</th>
                <th>Total Load kWh</th>
                <th>PV kWh</th>
                <th>Forced Chg/Dischg</th>
                <th>Battery Discharge kWh</th>
                <th>Battery Level kWh</th>
                <th>Grid Import</th>
                <th>Import £/kWh</th>
                <th>Import Cost</th>
                <th>Grid Export</th>
                <th>Export £/kWh</th>
                <th>Export Revenue</th>
              </tr>
            </thead>
            <tbody>
              {hourlyData.map((s) => (
                <tr key={`hour-${s.time}`}>
                  <td>{s.time}</td>
                  <td>{fmtNum(s.houseLoadKwh, 3)}</td>
                  <td>{fmtNum(s.evLoadKwh, 3)}</td>
                  <td>{fmtNum(s.loadKwh, 3)}</td>
                  <td>{fmtNum(s.pvKwh, 3)}</td>
                  <td>{s.forcedMode}</td>
                  <td>{fmtNum(s.batteryDischargeKwh, 3)}</td>
                  <td>{fmtNum(s.socKwh, 3)}</td>
                  <td>{fmtNum(s.gridImportKwh, 3)}</td>
                  <td>{fmtCurrency(s.importRate)}</td>
                  <td>{fmtNum(s.importCost, 3)}</td>
                  <td>{fmtNum(s.gridExportKwh, 3)}</td>
                  <td>{fmtCurrency(s.exportRate)}</td>
                  <td>{fmtNum(s.exportRevenue, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MonthlyStatsTable({ monthly }) {
  if (!Array.isArray(monthly) || !monthly.length) {
    return <p className="muted">No monthly stats available.</p>;
  }

  const moneyCell = (value) => {
    const n = Number(value || 0);
    return <span className={n >= 0 ? "money-positive" : "money-negative"}>{fmtSignedCurrency(n)}</span>;
  };

  const totals = monthly.reduce((acc, m) => ({
    pvKwh: acc.pvKwh + Number(m.pvKwh || 0),
    loadKwh: acc.loadKwh + Number(m.loadKwh || 0),
    houseLoadKwh: acc.houseLoadKwh + Number(m.houseLoadKwh || 0),
    evLoadKwh: acc.evLoadKwh + Number(m.evLoadKwh || 0),
    gridImportKwh: acc.gridImportKwh + Number(m.gridImportKwh || 0),
    importCost: acc.importCost + Number(m.importCost || 0),
    gridExportKwh: acc.gridExportKwh + Number(m.gridExportKwh || 0),
    exportRevenue: acc.exportRevenue + Number(m.exportRevenue || 0),
    standingCharge: acc.standingCharge + Number(m.standingCharge || 0),
    baselineCost: acc.baselineCost + Number(m.baselineCost || 0),
    totalCost: acc.totalCost + Number(m.totalCost || 0),
  }), {
    pvKwh: 0,
    loadKwh: 0,
    houseLoadKwh: 0,
    evLoadKwh: 0,
    gridImportKwh: 0,
    importCost: 0,
    gridExportKwh: 0,
    exportRevenue: 0,
    standingCharge: 0,
    baselineCost: 0,
    totalCost: 0,
  });

  return (
    <div className="monthly-wrap">
      <table className="monthly-table">
        <thead>
          <tr>
            <th>Month</th>
            <th>PV (kWh)</th>
            <th>Load (kWh)</th>
            <th>House (kWh)</th>
            <th>EV (kWh)</th>
            <th>Import (kWh)</th>
            <th>Import Cost</th>
            <th>Export (kWh)</th>
            <th>Export Revenue</th>
            <th>Standing</th>
            <th>Baseline Net Cashflow (incl standing)</th>
            <th>Net Cashflow (incl standing)</th>
          </tr>
        </thead>
        <tbody>
          {monthly.map((m, idx) => (
            <tr key={MONTH_NAMES[idx]}>
              <td>{MONTH_NAMES[idx]}</td>
              <td>{fmtNum(m.pvKwh)}</td>
              <td>{fmtNum(m.loadKwh)}</td>
              <td>{fmtNum(m.houseLoadKwh)}</td>
              <td>{fmtNum(m.evLoadKwh)}</td>
              <td>{fmtNum(m.gridImportKwh)}</td>
              <td>{moneyCell(-m.importCost)}</td>
              <td>{fmtNum(m.gridExportKwh)}</td>
              <td>{moneyCell(m.exportRevenue)}</td>
              <td>{moneyCell(-m.standingCharge)}</td>
              <td>{moneyCell(-(Number(m.baselineCost || 0) + Number(m.standingCharge || 0)))}</td>
              <td>{moneyCell(-m.totalCost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            <td><strong>{fmtNum(totals.pvKwh)}</strong></td>
            <td><strong>{fmtNum(totals.loadKwh)}</strong></td>
            <td><strong>{fmtNum(totals.houseLoadKwh)}</strong></td>
            <td><strong>{fmtNum(totals.evLoadKwh)}</strong></td>
            <td><strong>{fmtNum(totals.gridImportKwh)}</strong></td>
            <td><strong>{moneyCell(-totals.importCost)}</strong></td>
            <td><strong>{fmtNum(totals.gridExportKwh)}</strong></td>
            <td><strong>{moneyCell(totals.exportRevenue)}</strong></td>
            <td><strong>{moneyCell(-totals.standingCharge)}</strong></td>
            <td><strong>{moneyCell(-(totals.baselineCost + totals.standingCharge))}</strong></td>
            <td><strong>{moneyCell(-totals.totalCost)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function YearlyDailyTotalsTable({ rows }) {
  if (!Array.isArray(rows) || !rows.length) {
    return <p className="muted">No daily totals available.</p>;
  }

  const moneyCell = (value) => {
    const n = Number(value || 0);
    return <span className={n >= 0 ? "money-positive" : "money-negative"}>{fmtSignedCurrency(n)}</span>;
  };

  return (
    <div className="monthly-wrap">
      <table className="monthly-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Load (kWh)</th>
            <th>House (kWh)</th>
            <th>EV (kWh)</th>
            <th>PV (kWh)</th>
            <th>Import (kWh)</th>
            <th>Export (kWh)</th>
            <th>Bat Chg PV (kWh)</th>
            <th>Bat Chg Grid (kWh)</th>
            <th>Bat Dischg Load (kWh)</th>
            <th>Bat Dischg Export (kWh)</th>
            <th>Import Cost</th>
            <th>Export Revenue</th>
            <th>Day Net Cashflow</th>
            <th>FC Target % (Auto)</th>
            <th>SOC 100% At</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{fmtNum(d.loadKwh, 3)}</td>
              <td>{fmtNum(d.houseLoadKwh, 3)}</td>
              <td>{fmtNum(d.evLoadKwh, 3)}</td>
              <td>{fmtNum(d.pvKwh, 3)}</td>
              <td>{fmtNum(d.gridImportKwh, 3)}</td>
              <td>{fmtNum(d.gridExportKwh, 3)}</td>
              <td>{fmtNum(d.chargePvKwh, 3)}</td>
              <td>{fmtNum(d.chargeGridKwh, 3)}</td>
              <td>{fmtNum(d.dischargeLoadKwh, 3)}</td>
              <td>{fmtNum(d.dischargeExportKwh, 3)}</td>
              <td>{moneyCell(-Number(d.importCost || 0))}</td>
              <td>{moneyCell(d.exportRevenue)}</td>
              <td>{moneyCell(d.dayNetCashflow)}</td>
              <td>{d.forceChargeTargetSocPercent ?? "-"}</td>
              <td>{d.socReached100At || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function YearlyDailyTotalsCharts({ rows }) {
  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  return (
    <div className="daily-charts">
      <div className="chart-wrap">
        <h4>Daily Totals (Year) - Energy (kWh)</h4>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis />
            <Tooltip formatter={(v) => [`${fmtNum(v, 3)} kWh`, ""]} />
            <Legend />
            <Line type="monotone" dataKey="loadKwh" name="Load" stroke="#111827" dot={false} strokeWidth={1.8} />
            <Line type="monotone" dataKey="houseLoadKwh" name="House" stroke="#f59e0b" dot={false} strokeWidth={1.4} />
            <Line type="monotone" dataKey="evLoadKwh" name="EV" stroke="#ea580c" dot={false} strokeWidth={1.4} />
            <Line type="monotone" dataKey="pvKwh" name="PV" stroke="#2563eb" dot={false} strokeWidth={1.8} />
            <Line type="monotone" dataKey="gridImportKwh" name="Grid Import" stroke="#ef4444" dot={false} strokeWidth={1.4} />
            <Line type="monotone" dataKey="gridExportKwh" name="Grid Export" stroke="#22c55e" dot={false} strokeWidth={1.4} />
            <Line type="monotone" dataKey="chargePvKwh" name="Bat Charge PV" stroke="#0ea5e9" dot={false} strokeWidth={1.2} />
            <Line type="monotone" dataKey="chargeGridKwh" name="Bat Charge Grid" stroke="#8b5cf6" dot={false} strokeWidth={1.2} />
            <Line type="monotone" dataKey="dischargeLoadKwh" name="Bat Discharge Load" stroke="#14b8a6" dot={false} strokeWidth={1.2} />
            <Line type="monotone" dataKey="dischargeExportKwh" name="Bat Discharge Export" stroke="#84cc16" dot={false} strokeWidth={1.2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-wrap">
        <h4>Daily Totals (Year) - Financials</h4>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" minTickGap={24} />
            <YAxis />
            <Tooltip formatter={(v) => [fmtSignedCurrency(v), ""]} />
            <Legend />
            <Line type="monotone" dataKey="importCost" name="Import Cost" stroke="#dc2626" dot={false} strokeWidth={1.8} />
            <Line type="monotone" dataKey="exportRevenue" name="Export Revenue" stroke="#16a34a" dot={false} strokeWidth={1.8} />
            <Line type="monotone" dataKey="dayNetCashflow" name="Day Net Cashflow" stroke="#1d4ed8" dot={false} strokeWidth={2.1} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function minuteToClockLabel(minute) {
  const h = String(Math.floor(minute / 60)).padStart(2, "0");
  const m = String(minute % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function MinuteShapePreview({ minuteShapeKw }) {
  if (!Array.isArray(minuteShapeKw) || minuteShapeKw.length !== 1440) return null;

  const data = minuteShapeKw.map((kw, minute) => ({
    minute,
    kw: Number(kw || 0),
  }));

  const avgKw = data.reduce((acc, d) => acc + d.kw, 0) / 1440;
  const peakKw = data.reduce((max, d) => Math.max(max, d.kw), 0);

  return (
    <div className="chart-wrap">
      <div className="chart-title-row">
        <h4>Imported Minute Load Shape (Typical Day)</h4>
        <p className="totals-inline">Avg {fmtNum(avgKw, 2)} kW | Peak {fmtNum(peakKw, 2)} kW</p>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="minute"
            type="number"
            domain={[0, 1439]}
            ticks={[0, 120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200, 1320, 1439]}
            tickFormatter={(v) => minuteToClockLabel(v)}
          />
          <YAxis />
          <Tooltip labelFormatter={(v) => minuteToClockLabel(Number(v))} formatter={(v) => [`${fmtNum(v, 3)} kW`, "Load"]} />
          <Line type="monotone" dataKey="kw" name="Load (kW)" stroke="#111827" dot={false} strokeWidth={1.5} />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="muted">Simulation uses this minute profile for intra-slot dispatch while billing remains 30-minute.</p>
    </div>
  );
}

function GlobalBatteryControlSection({ project, updateProject, setError }) {
  return (
    <section className="card">
      <h2>Global Battery Control Windows</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={project.batteryControl?.autoOptimizeForceCharge === true}
          onChange={(e) => updateProject((p) => ({
            ...p,
            batteryControl: {
              ...(p.batteryControl || defaultBatteryControl()),
              autoOptimizeForceCharge: e.target.checked,
            },
          }))}
        />
        Auto-optimize force-charge SOC target per day
      </label>
      <label>Auto-optimize step (% points)
        <input
          type="number"
          min="1"
          max="50"
          value={project.batteryControl?.autoOptimizeForceChargeStepPercent ?? 10}
          onChange={(e) => updateProject((p) => ({
            ...p,
            batteryControl: {
              ...(p.batteryControl || defaultBatteryControl()),
              autoOptimizeForceChargeStepPercent: Number(e.target.value),
            },
          }))}
        />
      </label>
      <p className="muted">When enabled, simulation picks daily force-charge SOC target that maximizes that day cashflow using PV forecast, load, tariffs, and force-discharge windows.</p>
      <h3>Force Charge (grid)</h3>
      {(project.batteryControl?.forceChargeWindows || []).map((w, i) => (
        <div className="row" key={`fc-${i}`}>
          <label>Name
            <input value={w.name || ""} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceChargeWindows || [])];
              windows[i] = { ...windows[i], name: e.target.value };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
            })} />
          </label>
          <label>Start
            <input type="time" step="1800" value={slotToTime(w.startSlot ?? 0)} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceChargeWindows || [])];
              windows[i] = { ...windows[i], startSlot: timeToSlot(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
            })} />
          </label>
          <label>End
            <input type="time" step="1800" value={slotToTime(w.endSlot ?? 0)} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceChargeWindows || [])];
              windows[i] = { ...windows[i], endSlot: timeToSlot(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
            })} />
          </label>
          <label>Power kW
            <input type="number" value={w.powerKw ?? 0} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceChargeWindows || [])];
              windows[i] = { ...windows[i], powerKw: Number(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
            })} />
          </label>
          <label>Target SOC %
            <input type="number" value={w.targetSocPercent ?? 80} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceChargeWindows || [])];
              windows[i] = { ...windows[i], targetSocPercent: Number(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
            })} />
          </label>
          <label>Target SOC by month % (12 values Jan..Dec)
            <textarea
              key={`fc-monthly-${i}-${(Array.isArray(w.targetSocPercentByMonth) && w.targetSocPercentByMonth.length === 12
                ? w.targetSocPercentByMonth
                : Array(12).fill(Number(w.targetSocPercent ?? 80))).join(",")}`}
              defaultValue={toCsv12(
                Array.isArray(w.targetSocPercentByMonth) && w.targetSocPercentByMonth.length === 12
                  ? w.targetSocPercentByMonth
                  : Array(12).fill(Number(w.targetSocPercent ?? 80)),
              )}
              onBlur={(e) => {
                try {
                  const parsed = fromCsv12(e.target.value, Number(w.targetSocPercent ?? 80));
                  updateProject((p) => {
                    const windows = [...(p.batteryControl?.forceChargeWindows || [])];
                    windows[i] = { ...windows[i], targetSocPercentByMonth: parsed };
                    return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
                  });
                  setError("");
                } catch (err) {
                  setError(err.message);
                }
              }}
            />
          </label>
          <label>Set all months SOC %
            <input
              type="number"
              value={w.monthlySocOverridePercent ?? w.targetSocPercent ?? 80}
              onChange={(e) => updateProject((p) => {
                const windows = [...(p.batteryControl?.forceChargeWindows || [])];
                windows[i] = { ...windows[i], monthlySocOverridePercent: Number(e.target.value) };
                return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
              })}
            />
          </label>
          <button type="button" onClick={() => updateProject((p) => {
            const windows = [...(p.batteryControl?.forceChargeWindows || [])];
            const v = Number(windows[i]?.monthlySocOverridePercent ?? windows[i]?.targetSocPercent ?? 80);
            windows[i] = {
              ...windows[i],
              targetSocPercent: v,
              targetSocPercentByMonth: Array(12).fill(v),
            };
            return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
          })}>
            Apply SOC to all months
          </button>
          <label className="check">
            <input type="checkbox" checked={w.enabled !== false} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceChargeWindows || [])];
              windows[i] = { ...windows[i], enabled: e.target.checked };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceChargeWindows: windows } };
            })} />
            Enabled
          </label>
          <button onClick={() => updateProject((p) => ({
            ...p,
            batteryControl: {
              ...(p.batteryControl || defaultBatteryControl()),
              forceChargeWindows: (p.batteryControl?.forceChargeWindows || []).filter((_, idx) => idx !== i),
            },
          }))}>Remove</button>
        </div>
      ))}
      <button onClick={() => updateProject((p) => ({
        ...p,
        batteryControl: {
          ...(p.batteryControl || defaultBatteryControl()),
          forceChargeWindows: [...(p.batteryControl?.forceChargeWindows || []), { name: "New charge", startSlot: 0, endSlot: 6, powerKw: 2, targetSocPercent: 80, targetSocPercentByMonth: Array(12).fill(80), enabled: true }],
        },
      }))}>Add force-charge window</button>

      <h3>Force Discharge</h3>
      {(project.batteryControl?.forceDischargeWindows || []).map((w, i) => (
        <div className="row" key={`fd-${i}`}>
          <label>Name
            <input value={w.name || ""} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceDischargeWindows || [])];
              windows[i] = { ...windows[i], name: e.target.value };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceDischargeWindows: windows } };
            })} />
          </label>
          <label>Start
            <input type="time" step="1800" value={slotToTime(w.startSlot ?? 0)} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceDischargeWindows || [])];
              windows[i] = { ...windows[i], startSlot: timeToSlot(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceDischargeWindows: windows } };
            })} />
          </label>
          <label>End
            <input type="time" step="1800" value={slotToTime(w.endSlot ?? 0)} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceDischargeWindows || [])];
              windows[i] = { ...windows[i], endSlot: timeToSlot(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceDischargeWindows: windows } };
            })} />
          </label>
          <label>Power kW
            <input type="number" value={w.powerKw ?? 0} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceDischargeWindows || [])];
              windows[i] = { ...windows[i], powerKw: Number(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceDischargeWindows: windows } };
            })} />
          </label>
          <label>Target SOC %
            <input type="number" value={w.targetSocPercent ?? 15} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceDischargeWindows || [])];
              windows[i] = { ...windows[i], targetSocPercent: Number(e.target.value) };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceDischargeWindows: windows } };
            })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={w.enabled !== false} onChange={(e) => updateProject((p) => {
              const windows = [...(p.batteryControl?.forceDischargeWindows || [])];
              windows[i] = { ...windows[i], enabled: e.target.checked };
              return { ...p, batteryControl: { ...(p.batteryControl || defaultBatteryControl()), forceDischargeWindows: windows } };
            })} />
            Enabled
          </label>
          <button onClick={() => updateProject((p) => ({
            ...p,
            batteryControl: {
              ...(p.batteryControl || defaultBatteryControl()),
              forceDischargeWindows: (p.batteryControl?.forceDischargeWindows || []).filter((_, idx) => idx !== i),
            },
          }))}>Remove</button>
        </div>
      ))}
      <button onClick={() => updateProject((p) => ({
        ...p,
        batteryControl: {
          ...(p.batteryControl || defaultBatteryControl()),
          forceDischargeWindows: [...(p.batteryControl?.forceDischargeWindows || []), { name: "New discharge", startSlot: 34, endSlot: 40, powerKw: 2, targetSocPercent: 15, enabled: true }],
        },
      }))}>Add force-discharge window</button>
    </section>
  );
}

function App() {
  const [project, setProject] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedTariffs, setSelectedTariffs] = useState([]);
  const [selectedDay, setSelectedDay] = useState("2025-06-21");
  const [consumptionDraft, setConsumptionDraft] = useState("");
  const [consumption24Draft, setConsumption24Draft] = useState("");
  const [monthlyAdjustmentDraft, setMonthlyAdjustmentDraft] = useState("");
  const [activeTab, setActiveTab] = useState("settings");
  const [autoSaveStatus, setAutoSaveStatus] = useState("saved");
  const [haCsvPath, setHaCsvPath] = useState("/Users/pawel/Downloads/history (1).csv");
  const lastSavedProjectRef = useRef("");
  const [octopusImport, setOctopusImport] = useState({
    name: "",
    importTariffCode: "",
    exportTariffCode: "",
    periodFrom: "",
    periodTo: "",
    includeVat: true,
  });
  const [octopusAvailable, setOctopusAvailable] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await fetchProject();
        const normalized = normalizeProject(p);
        setProject(normalized);
        lastSavedProjectRef.current = JSON.stringify(normalized);
        setConsumptionDraft(toCsv48(p?.consumption?.slotKwh));
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  useEffect(() => {
    if (project?.consumption?.slotKwh) {
      setConsumptionDraft(toCsv48(project.consumption.slotKwh));
      const slots = project.consumption.slotKwh;
      if (Array.isArray(slots) && slots.length === 48) {
        const hourly = [];
        for (let i = 0; i < 24; i += 1) {
          const hourSum = Number(slots[i * 2] || 0) + Number(slots[(i * 2) + 1] || 0);
          hourly.push(hourSum.toFixed(4));
        }
        setConsumption24Draft(hourly.join(", "));
      }
    }
  }, [project?.consumption?.slotKwh]);

  useEffect(() => {
    setMonthlyAdjustmentDraft(toCsv12(project?.consumption?.monthlyAdjustment));
  }, [project?.consumption?.monthlyAdjustment]);

  useEffect(() => {
    if (!project) return;
    const serialized = JSON.stringify(project);
    if (!lastSavedProjectRef.current || serialized === lastSavedProjectRef.current) return;

    setAutoSaveStatus("saving");
    const timer = setTimeout(async () => {
      try {
        await saveProject(project);
        lastSavedProjectRef.current = serialized;
        setAutoSaveStatus("saved");
      } catch (e) {
        setAutoSaveStatus("error");
        setError(e.message);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [project]);

  const activeTariffs = useMemo(() => (project?.tariffs || []).filter((t) => t.enabled !== false), [project]);

  const updateProject = (updater) => {
    setProject((prev) => (typeof updater === "function" ? updater(prev) : updater));
  };

  async function onSimulate() {
    if (!project) return;
    try {
      setBusy(true);
      setError("");
      const output = await runSimulation(project, selectedTariffs.length ? selectedTariffs : null, selectedDay);
      setResult(output);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!project) return;
    onSimulate();
  }, [selectedDay]);

  async function onImportOctopusTariff() {
    try {
      setBusy(true);
      setError("");
      const imported = await importOctopusTariff({
        name: octopusImport.name,
        importTariffCode: octopusImport.importTariffCode || undefined,
        exportTariffCode: octopusImport.exportTariffCode || undefined,
        periodFrom: octopusImport.periodFrom || undefined,
        periodTo: octopusImport.periodTo || undefined,
        includeVat: octopusImport.includeVat,
      });
      updateProject((p) => ({ ...p, tariffs: [...(p.tariffs || []), imported] }));
      setSelectedTariffs((prev) => [...new Set([...prev, imported.id])]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onImportOctopusYearSplitTariffs() {
    try {
      setBusy(true);
      setError("");
      const sourceYear = Number(project?.pvgis?.sourceYear ?? 2020);
      const imported = await importOctopusYearTariffs({
        namePrefix: octopusImport.name || `Octopus ${sourceYear}`,
        importTariffCode: octopusImport.importTariffCode || undefined,
        exportTariffCode: octopusImport.exportTariffCode || undefined,
        includeVat: octopusImport.includeVat,
        year: sourceYear,
      });
      const newTariffs = Array.isArray(imported?.tariffs) ? imported.tariffs : [];
      if (!newTariffs.length) {
        throw new Error("No tariffs were imported for the selected year.");
      }
      updateProject((p) => ({ ...p, tariffs: [...(p.tariffs || []), ...newTariffs] }));
      setSelectedTariffs((prev) => [...new Set([...prev, ...newTariffs.map((t) => t.id)])]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onLoadOctopusAvailableTariffs() {
    try {
      setBusy(true);
      setError("");
      const detected = await fetchOctopusAvailableTariffs();
      setOctopusAvailable(detected);
      setOctopusImport((s) => ({
        ...s,
        importTariffCode: detected.activeImportTariffCode || s.importTariffCode,
        exportTariffCode: detected.activeExportTariffCode || s.exportTariffCode,
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onImportHomeAssistantCsv() {
    try {
      setBusy(true);
      setError("");
      const data = await importHomeAssistantCsv(haCsvPath);
      updateProject((p) => ({
        ...p,
        consumption: {
          ...p.consumption,
          slotKwh: data.slotKwh,
          minuteShapeKw: data.minuteShapeKw,
        },
      }));
      setConsumptionDraft(toCsv48(data.slotKwh));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return <div className="app">Loading...</div>;
  }

  return (
    <div className="app app-shell">
      <div className="app-topbar">
        <div>
          <h1>Solar Typical-Year Budget Model</h1>
          <p className="muted">Minute-level simulation (with 30-minute tariff settlement) using PVGIS proxy generation, battery control, and multi-tariff comparison.</p>
        </div>
        <div className="tab-row">
          <button type="button" className={activeTab === "settings" ? "tab active" : "tab"} onClick={() => setActiveTab("settings")}>Settings</button>
          <button type="button" className={activeTab === "model" ? "tab active" : "tab"} onClick={() => setActiveTab("model")}>Model</button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}

      <div className="app-layout">
        <aside className="app-sidebar">
          <section className="card">
            <h2>Model Run</h2>
            <label>Day for 30-min chart
              <input type="date" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} min={MODEL_DAY_MIN} max={MODEL_DAY_MAX} />
            </label>
            <div className="actions day-nav">
              <button type="button" onClick={() => setSelectedDay((d) => shiftIsoDay(d, -1))} disabled={busy || selectedDay <= MODEL_DAY_MIN}>Previous day</button>
              <button type="button" onClick={() => setSelectedDay((d) => shiftIsoDay(d, 1))} disabled={busy || selectedDay >= MODEL_DAY_MAX}>Next day</button>
            </div>
            <button disabled={busy} onClick={onSimulate}>Run yearly simulation</button>
            <p className="muted">
              Auto-save: {autoSaveStatus === "saving" ? "Saving..." : autoSaveStatus === "error" ? "Error" : "Saved"}
            </p>
          </section>
          <GlobalBatteryControlSection project={project} updateProject={updateProject} setError={setError} />
        </aside>
        <main className="app-main">
          {activeTab === "settings" ? (
            <>
      <section className="card">
        <h2>Project</h2>
        <div className="row">
          <label>Project Name
            <input value={project.name || ""} onChange={(e) => updateProject((p) => ({ ...p, name: e.target.value }))} />
          </label>
          <label>Country
            <input value={project.location?.country || ""} onChange={(e) => updateProject((p) => ({ ...p, location: { ...p.location, country: e.target.value } }))} />
          </label>
        </div>
      </section>

      <section className="card two-col">
        <div>
          <h2>Location</h2>
          <label>Latitude<input type="number" value={project.location.latitude} onChange={(e) => updateProject((p) => ({ ...p, location: { ...p.location, latitude: Number(e.target.value) } }))} /></label>
          <label>Longitude<input type="number" value={project.location.longitude} onChange={(e) => updateProject((p) => ({ ...p, location: { ...p.location, longitude: Number(e.target.value) } }))} /></label>
          <label>PVGIS Source Year
            <input
              type="number"
              min="2005"
              value={project.pvgis?.sourceYear ?? 2020}
              onChange={(e) => updateProject((p) => ({
                ...p,
                pvgis: { ...(p.pvgis || {}), sourceYear: Number(e.target.value) },
              }))}
            />
          </label>
          <p className="muted">PV generation profile is fetched from PVGIS for this specific source year.</p>
        </div>
        <div>
          <h2>Grid</h2>
          <label>Export limit kW<input type="number" value={project.exportLimitKw} onChange={(e) => updateProject((p) => ({ ...p, exportLimitKw: Number(e.target.value) }))} /></label>
          <p className="muted">Configure inverter settings per system in the Systems section.</p>
        </div>
      </section>

      <section className="card">
        <h2>Arrays</h2>
        {(project.arrays || []).map((arr, i) => (
          <div className="row" key={arr.id || i}>
            <label>Name
              <input value={arr.name} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], name: e.target.value };
                return { ...p, arrays };
              })} />
            </label>
            <label>Peak Power (kWp)
              <input type="number" value={arr.peakPowerKw} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], peakPowerKw: Number(e.target.value) };
                return { ...p, arrays };
              })} />
            </label>
            <label>Tilt (deg)
              <input type="number" value={arr.tiltDeg} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], tiltDeg: Number(e.target.value) };
                return { ...p, arrays };
              })} />
            </label>
            <label>Azimuth (0..360 compass; 180=S, 270=W)
              <input type="number" min="0" max="360" value={arr.azimuthDeg} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], azimuthDeg: Number(e.target.value) };
                return { ...p, arrays };
              })} />
            </label>
            <label>Loss (%)
              <input type="number" value={arr.lossPercent} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], lossPercent: Number(e.target.value) };
                return { ...p, arrays };
              })} />
            </label>
            <label>Shading (% after start time)
              <input type="number" min="0" max="100" value={arr.shadingPercent ?? 0} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], shadingPercent: Number(e.target.value) };
                return { ...p, arrays };
              })} />
            </label>
            <label>Shading Start Time
              <input type="time" step="1800" value={slotToTime(arr.shadingStartSlot ?? 0)} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], shadingStartSlot: timeToSlot(e.target.value) };
                return { ...p, arrays };
              })} />
            </label>
            <label className="check">Enabled
              <input type="checkbox" checked={arr.enabled !== false} onChange={(e) => updateProject((p) => {
                const arrays = [...p.arrays];
                arrays[i] = { ...arrays[i], enabled: e.target.checked };
                return { ...p, arrays };
              })} />
            </label>
            <button onClick={() => updateProject((p) => {
              const removed = p.arrays[i];
              const arrays = p.arrays.filter((_, idx) => idx !== i);
              const systems = (p.systems || []).map((s) => ({
                ...s,
                arrayIds: (s.arrayIds || []).filter((id) => id !== removed?.id),
              }));
              return { ...p, arrays, systems };
            })}>Remove</button>
          </div>
        ))}
        <button onClick={() => updateProject((p) => ({
          ...p,
          arrays: [...p.arrays, { id: `array-${Date.now()}`, name: "New Array", peakPowerKw: 2, tiltDeg: 35, azimuthDeg: 180, lossPercent: 14, shadingPercent: 0, shadingStartSlot: 30, enabled: true }],
        }))}>Add Array</button>
      </section>

      <section className="card">
        <h2>Systems</h2>
        <p className="muted">Each system represents an inverter+battery path. Assign arrays below and choose AC/DC coupling.</p>
        {(project.systems || []).map((sys, i) => (
          <div className="tariff" key={sys.id || i}>
            <div className="row">
              <label>Name
                <input value={sys.name || ""} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], name: e.target.value };
                  return { ...p, systems };
                })} />
              </label>
              <label>Inverter AC kW
                <input type="number" min="0.1" step="0.1" value={sys?.inverter?.acPowerKw ?? 5} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], inverter: { ...(systems[i].inverter || {}), acPowerKw: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Inverter eff %
                <input type="number" min="1" max="100" value={sys?.inverter?.efficiencyPercent ?? 97} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], inverter: { ...(systems[i].inverter || {}), efficiencyPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Battery Coupling
                <select value={sys.batteryCoupling === "dc" ? "dc" : "ac"} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], batteryCoupling: e.target.value === "dc" ? "dc" : "ac" };
                  return { ...p, systems };
                })}>
                  <option value="ac">AC Coupled</option>
                  <option value="dc">DC Coupled</option>
                </select>
              </label>
              <button onClick={() => updateProject((p) => ({ ...p, systems: (p.systems || []).filter((_, idx) => idx !== i) }))}>Remove</button>
            </div>
            <div className="actions">
              {(project.arrays || []).map((arr) => {
                const selected = Array.isArray(sys.arrayIds) && sys.arrayIds.includes(arr.id);
                return (
                  <label key={`${sys.id}-arr-${arr.id}`} className="check">
                    <input type="checkbox" checked={selected} onChange={(e) => updateProject((p) => {
                      const systems = [...(p.systems || [])];
                      const current = Array.isArray(systems[i].arrayIds) ? [...systems[i].arrayIds] : [];
                      const next = e.target.checked
                        ? [...new Set([...current, arr.id])]
                        : current.filter((id) => id !== arr.id);
                      systems[i] = { ...systems[i], arrayIds: next };
                      return { ...p, systems };
                    })} />
                    {arr.name || arr.id}
                  </label>
                );
              })}
            </div>
            <div className="row">
              <label>Battery Enabled
                <select value={String(sys?.battery?.enabled !== false)} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), enabled: e.target.value === "true" } };
                  return { ...p, systems };
                })}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label>Battery Capacity kWh
                <input type="number" value={sys?.battery?.capacityKwh ?? 0} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), capacityKwh: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Usable %
                <input type="number" value={sys?.battery?.usableCapacityPercent ?? 95} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), usableCapacityPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Initial SOC %
                <input type="number" value={sys?.battery?.initialSocPercent ?? 50} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), initialSocPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Min SOC %
                <input type="number" value={sys?.battery?.minSocPercent ?? 15} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), minSocPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Target SOC %
                <input type="number" value={sys?.battery?.targetSocPercent ?? 70} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), targetSocPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Max Charge kW
                <input type="number" value={sys?.battery?.maxChargeKw ?? 0} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), maxChargeKw: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Max Discharge kW
                <input type="number" value={sys?.battery?.maxDischargeKw ?? 0} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), maxDischargeKw: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Charge efficiency %
                <input type="number" value={sys?.battery?.chargeEfficiencyPercent ?? 95} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), chargeEfficiencyPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Discharge efficiency %
                <input type="number" value={sys?.battery?.dischargeEfficiencyPercent ?? 95} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), dischargeEfficiencyPercent: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
              <label>Degradation £/kWh
                <input type="number" value={sys?.battery?.degradationCostPerKwh ?? 0} onChange={(e) => updateProject((p) => {
                  const systems = [...(p.systems || [])];
                  systems[i] = { ...systems[i], battery: { ...(systems[i].battery || defaultSystemBattery()), degradationCostPerKwh: Number(e.target.value) } };
                  return { ...p, systems };
                })} />
              </label>
            </div>

          </div>
        ))}
        <button onClick={() => updateProject((p) => ({
          ...p,
          systems: [
            ...(p.systems || []),
            {
              id: `system-${Date.now()}`,
              name: `System ${(p.systems || []).length + 1}`,
              arrayIds: [],
              inverter: { acPowerKw: 5, efficiencyPercent: 97 },
              battery: defaultSystemBattery(),
              batteryCoupling: "ac",
            },
          ],
        }))}>Add System</button>
      </section>

      <section className="card">
          <h2>Consumption + Economics</h2>
          <label>Annual maintenance £<input type="number" value={project.economics.annualMaintenanceCost} onChange={(e) => updateProject((p) => ({ ...p, economics: { ...p.economics, annualMaintenanceCost: Number(e.target.value) } }))} /></label>
          <label>Import VAT %<input type="number" value={project.economics.importVatPercent} onChange={(e) => updateProject((p) => ({ ...p, economics: { ...p.economics, importVatPercent: Number(e.target.value) } }))} /></label>
          <label>Export tax %<input type="number" value={project.economics.exportTaxPercent} onChange={(e) => updateProject((p) => ({ ...p, economics: { ...p.economics, exportTaxPercent: Number(e.target.value) } }))} /></label>
          <label>Discount rate %<input type="number" value={project.economics.discountRatePercent ?? 0} onChange={(e) => updateProject((p) => ({ ...p, economics: { ...p.economics, discountRatePercent: Number(e.target.value) } }))} /></label>
          <label>Grid CO2 kg/kWh<input type="number" value={project.economics.co2KgPerKwhGrid} onChange={(e) => updateProject((p) => ({ ...p, economics: { ...p.economics, co2KgPerKwhGrid: Number(e.target.value) } }))} /></label>
          <div className="row">
            <label>Home Assistant CSV path
              <input value={haCsvPath} onChange={(e) => setHaCsvPath(e.target.value)} />
            </label>
            <button disabled={busy || !haCsvPath.trim()} onClick={onImportHomeAssistantCsv}>Import HA Typical Day</button>
          </div>
          <label>Typical day load (48 slots kWh comma-separated)
            <textarea value={consumptionDraft} onChange={(e) => setConsumptionDraft(e.target.value)} onBlur={(e) => {
              try {
                const parsed = fromCsv48(e.target.value);
                updateProject((p) => ({ ...p, consumption: { ...p.consumption, slotKwh: parsed } }));
                setError("");
              } catch (err) {
                setError(err.message);
              }
            }} />
          </label>
          <label>Typical day load (24 hourly kWh values, comma/space/newline separated)
            <textarea value={consumption24Draft} onChange={(e) => setConsumption24Draft(e.target.value)} />
          </label>
          <button type="button" onClick={() => {
            try {
              const parsed = fromHourly24(consumption24Draft);
              updateProject((p) => ({
                ...p,
                consumption: {
                  ...p.consumption,
                  slotKwh: parsed.slotKwh,
                  minuteShapeKw: parsed.minuteShapeKw,
                },
              }));
              setConsumptionDraft(toCsv48(parsed.slotKwh));
              setError("");
            } catch (err) {
              setError(err.message);
            }
          }}>Apply 24h values</button>
          <label>Monthly adjustment (12 values Jan..Dec, multiplier)
            <textarea value={monthlyAdjustmentDraft} onChange={(e) => setMonthlyAdjustmentDraft(e.target.value)} onBlur={(e) => {
              try {
                const parsed = fromCsv12(e.target.value);
                updateProject((p) => ({ ...p, consumption: { ...p.consumption, monthlyAdjustment: parsed } }));
                setError("");
              } catch (err) {
                setError(err.message);
              }
            }} />
          </label>
          <MinuteShapePreview minuteShapeKw={project?.consumption?.minuteShapeKw} />
      </section>

      <section className="card">
        <h2>EV Charging</h2>
        <p className="muted">EV charging is modeled as additional demand based on active days, charge window, charge power, and daily energy cap (battery capacity).</p>
        {(project.evs || []).map((ev, i) => (
          <div className="tariff" key={ev.id || i}>
            <div className="row">
              <label>Name
                <input value={ev.name || ""} onChange={(e) => updateProject((p) => {
                  const evs = [...(p.evs || [])];
                  evs[i] = { ...evs[i], name: e.target.value };
                  return { ...p, evs };
                })} />
              </label>
              <label>Charge Rate (kW)
                <input type="number" min="0" step="0.1" value={ev.chargePowerKw ?? 0} onChange={(e) => updateProject((p) => {
                  const evs = [...(p.evs || [])];
                  evs[i] = { ...evs[i], chargePowerKw: Number(e.target.value) };
                  return { ...p, evs };
                })} />
              </label>
              <label>Battery Capacity (kWh)
                <input type="number" min="0" step="0.1" value={ev.batteryCapacityKwh ?? 0} onChange={(e) => updateProject((p) => {
                  const evs = [...(p.evs || [])];
                  evs[i] = { ...evs[i], batteryCapacityKwh: Number(e.target.value) };
                  return { ...p, evs };
                })} />
              </label>
              <label>Start Time
                <input type="time" step="1800" value={slotToTime(ev.startSlot ?? 0)} onChange={(e) => updateProject((p) => {
                  const evs = [...(p.evs || [])];
                  evs[i] = { ...evs[i], startSlot: timeToSlot(e.target.value) };
                  return { ...p, evs };
                })} />
              </label>
              <label>End Time
                <input type="time" step="1800" value={slotToTime(ev.endSlot ?? 0)} onChange={(e) => updateProject((p) => {
                  const evs = [...(p.evs || [])];
                  evs[i] = { ...evs[i], endSlot: timeToSlot(e.target.value) };
                  return { ...p, evs };
                })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={ev.enabled !== false} onChange={(e) => updateProject((p) => {
                  const evs = [...(p.evs || [])];
                  evs[i] = { ...evs[i], enabled: e.target.checked };
                  return { ...p, evs };
                })} />
                Enabled
              </label>
              <button onClick={() => updateProject((p) => ({ ...p, evs: (p.evs || []).filter((_, idx) => idx !== i) }))}>Remove</button>
            </div>
            <div className="actions">
              {DOW_OPTIONS.map((d) => (
                <label key={`ev-${i}-day-${d.idx}`} className="check">
                  <input type="checkbox" checked={normalizeChargeDays(ev.chargeDays)[d.idx]} onChange={(e) => updateProject((p) => {
                    const evs = [...(p.evs || [])];
                    const days = normalizeChargeDays(evs[i]?.chargeDays);
                    days[d.idx] = e.target.checked;
                    evs[i] = { ...evs[i], chargeDays: days };
                    return { ...p, evs };
                  })} />
                  {d.label}
                </label>
              ))}
            </div>
          </div>
        ))}
        <button onClick={() => updateProject((p) => ({
          ...p,
          evs: [
            ...(p.evs || []),
            {
              id: `ev-${Date.now()}`,
              name: `EV ${(p.evs || []).length + 1}`,
              chargePowerKw: 7.2,
              batteryCapacityKwh: 60,
              startSlot: 1,
              endSlot: 11,
              chargeDays: [false, true, true, true, true, true, false],
              enabled: true,
            },
          ],
        }))}>Add EV</button>
      </section>

      <section className="card">
        <h2>Tariffs (48 slots each)</h2>
        <p className="muted">Select one or more tariffs to compare. Single daily 48-slot rates are used (no weekday/weekend split). Rates are per kWh in GBP.</p>
        <div className="octopus-import">
          <h3>Import From Octopus</h3>
          <p className="muted">Reads `OCTOPUS_API_KEY` and `OCTOPUS_ACCOUNT_NUMBER` from `.env` and loads tariff dropdowns.</p>
          <div className="row">
            <label>Tariff Name (optional)
              <input value={octopusImport.name} onChange={(e) => setOctopusImport((s) => ({ ...s, name: e.target.value }))} placeholder="My Agile Import" />
            </label>
            <label>Import Tariff Code
              <select value={octopusImport.importTariffCode} onChange={(e) => setOctopusImport((s) => ({ ...s, importTariffCode: e.target.value }))}>
                <option value="">Select import tariff...</option>
                {(octopusAvailable?.importTariffs || []).map((t) => (
                  <option key={`${t.tariffCode}-${t.mpan || "na"}`} value={t.tariffCode}>
                    {t.tariffCode}{t.isActive ? " (active)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>Export Tariff Code (optional)
              <select value={octopusImport.exportTariffCode} onChange={(e) => setOctopusImport((s) => ({ ...s, exportTariffCode: e.target.value }))}>
                <option value="">None</option>
                {(octopusAvailable?.exportTariffs || []).map((t) => (
                  <option key={`${t.tariffCode}-${t.mpan || "na"}`} value={t.tariffCode}>
                    {t.tariffCode}{t.isActive ? " (active)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>Period From (optional)
              <input type="datetime-local" value={octopusImport.periodFrom} onChange={(e) => setOctopusImport((s) => ({ ...s, periodFrom: e.target.value }))} />
            </label>
            <label>Period To (optional)
              <input type="datetime-local" value={octopusImport.periodTo} onChange={(e) => setOctopusImport((s) => ({ ...s, periodTo: e.target.value }))} />
            </label>
            <label className="check">
              <input type="checkbox" checked={octopusImport.includeVat} onChange={(e) => setOctopusImport((s) => ({ ...s, includeVat: e.target.checked }))} />
              Import VAT-inclusive rates
            </label>
            <button disabled={busy} onClick={onLoadOctopusAvailableTariffs}>Load Tariffs From .env</button>
            <button disabled={busy || !octopusImport.importTariffCode.trim()} onClick={onImportOctopusTariff}>Import Tariff</button>
            <button
              disabled={busy || (!octopusImport.importTariffCode.trim() && !octopusImport.exportTariffCode.trim())}
              onClick={onImportOctopusYearSplitTariffs}
            >
              Import PVGIS Year (Split I/E)
            </button>
          </div>
          <p className="muted">Split import creates two tariffs for the selected PVGIS year: import-only and export-only. You can model them separately and mix different code pairs by importing again.</p>
          {octopusAvailable ? (
            <p className="muted">
              Loaded {octopusAvailable.importTariffs?.length || 0} import and {octopusAvailable.exportTariffs?.length || 0} export tariffs.
              {octopusAvailable.activeImportTariffCode ? ` Active import: ${octopusAvailable.activeImportTariffCode}.` : ""}
            </p>
          ) : null}
        </div>
        {(project.tariffs || []).map((t, i) => (
          <div className="tariff" key={t.id || i}>
            <div className="row">
              <input value={t.name} onChange={(e) => updateProject((p) => {
                const tariffs = [...p.tariffs];
                tariffs[i] = { ...tariffs[i], name: e.target.value };
                return { ...p, tariffs };
              })} />
              <label className="check"><input type="checkbox" checked={selectedTariffs.includes(t.id)} onChange={(e) => {
                setSelectedTariffs((prev) => e.target.checked ? [...new Set([...prev, t.id])] : prev.filter((id) => id !== t.id));
              }} /> Model</label>
              <label className="check"><input type="checkbox" checked={t.enabled !== false} onChange={(e) => updateProject((p) => {
                const tariffs = [...p.tariffs];
                tariffs[i] = { ...tariffs[i], enabled: e.target.checked };
                return { ...p, tariffs };
              })} /> Enabled</label>
              <label>Standing/day<input type="number" value={t.standingChargePerDay} onChange={(e) => updateProject((p) => {
                const tariffs = [...p.tariffs];
                tariffs[i] = { ...tariffs[i], standingChargePerDay: Number(e.target.value) };
                return { ...p, tariffs };
              })} /></label>
              <button onClick={() => updateProject((p) => ({ ...p, tariffs: p.tariffs.filter((_, idx) => idx !== i) }))}>Remove</button>
            </div>
            <label>Import rate (48 slots)<textarea defaultValue={toCsv48(t.importRate || t.importRateWeekday)} onBlur={(e) => {
              try {
                const parsed = fromCsv48(e.target.value);
                updateProject((p) => {
                  const tariffs = [...p.tariffs];
                  tariffs[i] = { ...tariffs[i], importRate: parsed };
                  return { ...p, tariffs };
                });
                setError("");
              } catch (err) { setError(err.message); }
            }} /></label>
            <label>Export rate (48 slots)<textarea defaultValue={toCsv48(t.exportRate || t.exportRateWeekday)} onBlur={(e) => {
              try {
                const parsed = fromCsv48(e.target.value);
                updateProject((p) => {
                  const tariffs = [...p.tariffs];
                  tariffs[i] = { ...tariffs[i], exportRate: parsed };
                  return { ...p, tariffs };
                });
                setError("");
              } catch (err) { setError(err.message); }
            }} /></label>
          </div>
        ))}
        <button onClick={() => updateProject((p) => ({
          ...p,
          tariffs: [
            ...p.tariffs,
            {
              id: `tariff-${Date.now()}`,
              name: "New Tariff",
              standingChargePerDay: 0.5,
              importRate: [...EMPTY_48],
              exportRate: Array(48).fill(0.1),
              enabled: true,
            },
          ],
        }))}>Add tariff</button>
      </section>

            </>
          ) : (
            <>
      {result ? (
        <section className="card">
          <h2>Results ({result.year})</h2>
          <p className="muted">{result.assumptions.note}</p>
          <div className="grid-results">
            {result.results.map((r) => (
              <div key={r.tariffId} className="result-card">
                <h3>{r.tariffName}</h3>
                <p><strong>Total annual cost:</strong> {fmtCurrency(r.summary.annual.totalCost)}</p>
                <p><strong>Baseline (no PV/battery):</strong> {fmtCurrency(r.summary.annual.baselineCost)}</p>
                <p><strong>Annual savings vs baseline:</strong> {fmtCurrency(r.summary.annual.savingsVsBaseline)}</p>
                <p>Load (House / EV): {fmtNum(r.summary.annual.houseLoadKwh)} / {fmtNum(r.summary.annual.evLoadKwh)} kWh</p>
                <p>Import: {fmtNum(r.summary.annual.gridImportKwh)} kWh ({fmtCurrency(r.summary.annual.importCost)})</p>
                <p>Export: {fmtNum(r.summary.annual.gridExportKwh)} kWh ({fmtCurrency(r.summary.annual.exportRevenue)})</p>
                <p>Standing: {fmtCurrency(r.summary.annual.standingCharge)}</p>
                <p>Battery degradation: {fmtCurrency(r.summary.annual.batteryDegradationCost)}</p>
                <p>Autarky: {fmtNum(r.summary.annual.autarkyPercent)}%</p>
                <p>Self-consumption: {fmtNum(r.summary.annual.selfConsumptionPercent)}%</p>
                <p>PV curtailed: {fmtNum(r.summary.annual.pvCurtailedKwh)} kWh</p>
                <p>Estimated cycles: {fmtNum(r.summary.annual.estimatedCycles)}</p>
                <p>CO2 from import: {fmtNum(r.summary.annual.co2Kg)} kg</p>
                <h4>Monthly Stats</h4>
                <MonthlyStatsTable monthly={r.summary.monthly} />
                <h4>Daily Totals (Year)</h4>
                <YearlyDailyTotalsCharts rows={r.dailyTotals} />
                <YearlyDailyTotalsTable rows={r.dailyTotals} />
                <h4>Selected day: {selectedDay}</h4>
                <DaySeriesChart series={r.dailySeries} />
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="card">
          <p className="muted">Run yearly simulation to view model outputs.</p>
        </section>
      )}
            </>
          )}
          <footer className="muted">Data is stored in a local JSON file on the server. No database.</footer>
        </main>
      </div>
    </div>
  );
}

export default App;
