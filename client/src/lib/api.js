export async function fetchProject() {
  const res = await fetch("/api/project");
  if (!res.ok) throw new Error("Could not load project");
  return res.json();
}

export async function saveProject(project) {
  const res = await fetch("/api/project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not save project");
  return data;
}

export async function runSimulation(project, tariffIds = null, selectedDay = null) {
  const res = await fetch("/api/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, tariffIds, selectedDay }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Simulation failed");
  return data;
}

export async function importOctopusTariff(payload) {
  const res = await fetch("/api/import-octopus-tariff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Octopus import failed");
  return data;
}

export async function importOctopusYearTariffs(payload) {
  const res = await fetch("/api/import-octopus-year-tariffs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Octopus yearly tariff import failed");
  return data;
}

export async function detectOctopusAccountTariffs(payload) {
  const res = await fetch("/api/octopus/account-tariffs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Octopus account tariff detection failed");
  return data;
}

export async function fetchOctopusAvailableTariffs(asOf = null) {
  const url = new URL("/api/octopus/available-tariffs", window.location.origin);
  if (asOf) url.searchParams.set("asOf", asOf);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not load Octopus tariffs from .env account");
  return data;
}

export async function importOctopusUsageProfile(payload = {}) {
  const res = await fetch("/api/octopus/import-usage-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not import Octopus usage profile");
  return data;
}

export async function importHomeAssistantCsv(csvPath) {
  const res = await fetch("/api/import-homeassistant-csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not import Home Assistant CSV");
  return data;
}
