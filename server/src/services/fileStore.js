import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProject } from "../utils/validate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../data");
const projectPath = path.join(dataDir, "project.json");
const defaultProjectPath = path.join(dataDir, "defaultProject.json");
const pvgisCachePath = path.join(dataDir, "pvgisCache.json");

async function ensureFile(targetPath, fallbackPath, fallbackData = "{}") {
  try {
    await fs.access(targetPath);
  } catch {
    const initial = fallbackPath ? await fs.readFile(fallbackPath, "utf-8") : fallbackData;
    await fs.writeFile(targetPath, initial, "utf-8");
  }
}

export async function loadProject() {
  await ensureFile(projectPath, defaultProjectPath);
  const raw = await fs.readFile(projectPath, "utf-8");
  return JSON.parse(raw);
}

export async function saveProject(project) {
  validateProject(project);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2), "utf-8");
  return project;
}

export async function loadPVGISCache() {
  await fs.mkdir(dataDir, { recursive: true });
  await ensureFile(pvgisCachePath, null, "{}");
  const raw = await fs.readFile(pvgisCachePath, "utf-8");
  return JSON.parse(raw);
}

export async function savePVGISCache(cache) {
  await fs.writeFile(pvgisCachePath, JSON.stringify(cache, null, 2), "utf-8");
}
