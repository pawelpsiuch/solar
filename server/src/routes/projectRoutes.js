import { Router } from "express";
import { loadProject, saveProject } from "../services/fileStore.js";
import { simulateProject } from "../services/simulate.js";
import { importHomeAssistantTypicalDay } from "../services/homeAssistant.js";
import {
  detectOctopusAccountTariffCodes,
  importOctopusTariff,
  importOctopusUsageProfile,
  listOctopusAccountTariffOptions,
} from "../services/octopus.js";

export const projectRouter = Router();

projectRouter.get("/project", async (_req, res) => {
  try {
    const project = await loadProject();
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

projectRouter.post("/project", async (req, res) => {
  try {
    const saved = await saveProject(req.body);
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

projectRouter.post("/simulate", async (req, res) => {
  try {
    const project = req.body?.project ?? await loadProject();
    const tariffIds = req.body?.tariffIds ?? null;
    const selectedDay = req.body?.selectedDay ?? null;
    const output = await simulateProject(project, tariffIds, selectedDay);
    res.json(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

projectRouter.post("/import-octopus-tariff", async (req, res) => {
  try {
    const payload = req.body || {};
    const tariff = await importOctopusTariff({
      ...payload,
      accountNumber: payload.accountNumber || process.env.OCTOPUS_ACCOUNT_NUMBER,
      apiKey: payload.apiKey || process.env.OCTOPUS_API_KEY,
    });
    res.json(tariff);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

projectRouter.post("/octopus/account-tariffs", async (req, res) => {
  try {
    const payload = req.body || {};
    const codes = await detectOctopusAccountTariffCodes({
      ...payload,
      accountNumber: payload.accountNumber || process.env.OCTOPUS_ACCOUNT_NUMBER,
      apiKey: payload.apiKey || process.env.OCTOPUS_API_KEY,
    });
    res.json(codes);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

projectRouter.get("/octopus/available-tariffs", async (req, res) => {
  try {
    const asOf = req.query?.asOf ? String(req.query.asOf) : undefined;
    if (!process.env.OCTOPUS_ACCOUNT_NUMBER || !process.env.OCTOPUS_API_KEY) {
      throw new Error("Missing OCTOPUS_ACCOUNT_NUMBER or OCTOPUS_API_KEY in .env");
    }
    const data = await listOctopusAccountTariffOptions({
      accountNumber: process.env.OCTOPUS_ACCOUNT_NUMBER,
      apiKey: process.env.OCTOPUS_API_KEY,
      asOf,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

projectRouter.post("/octopus/import-usage-profile", async (req, res) => {
  try {
    const payload = req.body || {};
    const data = await importOctopusUsageProfile({
      ...payload,
      accountNumber: payload.accountNumber || process.env.OCTOPUS_ACCOUNT_NUMBER,
      apiKey: payload.apiKey || process.env.OCTOPUS_API_KEY,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

projectRouter.post("/import-homeassistant-csv", async (req, res) => {
  try {
    const csvPath = req.body?.csvPath;
    const data = await importHomeAssistantTypicalDay(csvPath);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
