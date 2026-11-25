import fs from "node:fs";
import path from "node:path";

import { inferContextWindow } from "./drivers/utils.mjs";

/**
 * Manages ALilaS model defaults, user-defined custom upstream profiles (env-var API keys only),
 * and persistent cross-session token telemetry (`allTimeTokens`, `totalRuns`, per-driver totals).
 */
export function createProfileStore(dataDir) {
  const filePath = path.join(dataDir, "profiles.json");

  function defaultData() {
    return {
      version: 1,
      defaultSelection: {
        driver: "", // auto-pick first installed driver if empty
        model: "",
        effort: "high",
        profileId: "",
      },
      customProfiles: [],
      telemetry: {
        allTimeTokens: 0,
        allTimeOutputTokens: 0,
        totalRuns: 0,
        lastTps: 0,
        byDriver: {},
      },
    };
  }

  function load() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (raw && typeof raw === "object") {
          const base = defaultData();
          return {
            version: 1,
            defaultSelection: { ...base.defaultSelection, ...(raw.defaultSelection || {}) },
            customProfiles: Array.isArray(raw.customProfiles) ? raw.customProfiles : [],
            telemetry: { ...base.telemetry, ...(raw.telemetry || {}) },
          };
        }
      }
    } catch {
      // ignore
    }
    const init = defaultData();
    save(init);
    return init;
  }

  let version = 1;
  function save(data) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
      version++;
    } catch {
      // ignore
    }
  }

  const data = load();

  function getVersion() {
    return version;
  }

  function getSnapshot() {
    return {
      defaultSelection: { ...data.defaultSelection },
      customProfiles: data.customProfiles.map((p) => ({ ...p })),
      telemetry: {
        ...data.telemetry,
        byDriver: { ...(data.telemetry.byDriver || {}) },
      },
    };
  }

  function setDefaultSelection({ driver, model, effort, profileId }) {
    if (typeof driver === "string") data.defaultSelection.driver = driver.trim();
    if (typeof model === "string") data.defaultSelection.model = model.trim();
    if (typeof effort === "string") data.defaultSelection.effort = effort.trim();
    if (typeof profileId === "string") data.defaultSelection.profileId = profileId.trim();
    save(data);
    return data.defaultSelection;
  }

  function upsertCustomProfile(profile) {
    const id =
      (profile.id || "").trim() ||
      `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const clean = {
      id,
      name: String(profile.name || profile.model || id).trim().slice(0, 60),
      driver: ["dsh", "claude", "codex", "agy"].includes(profile.driver)
        ? profile.driver
        : "dsh",
      provider: String(profile.provider || "custom").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "custom",
      baseURL: String(profile.baseURL || "").trim(),
      // Strictly store env variable NAME, never raw secret keys
      apiKeyEnv: String(profile.apiKeyEnv || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64),
      api: String(profile.api || "openai-responses").trim(),
      model: String(profile.model || "").trim(),
      contextWindow: Number(profile.contextWindow) || inferContextWindow(profile.model, 200_000),
      maxTokens: Number(profile.maxTokens) || 64_000,
      effort: String(profile.effort || "high").trim(),
    };
    const idx = data.customProfiles.findIndex((p) => p.id === id);
    if (idx >= 0) data.customProfiles[idx] = clean;
    else data.customProfiles.push(clean);
    save(data);
    return clean;
  }

  function deleteCustomProfile(id) {
    const before = data.customProfiles.length;
    data.customProfiles = data.customProfiles.filter((p) => p.id !== id);
    if (data.defaultSelection.profileId === id) {
      data.defaultSelection.profileId = "";
    }
    if (data.customProfiles.length !== before) save(data);
    return true;
  }

  function findProfile(profileId) {
    if (!profileId) return null;
    return data.customProfiles.find((p) => p.id === profileId) || null;
  }

  function recordUsageDelta({ driver, totalTokens = 0, outputTokens = 0, tps = 0, incrementRun = false }) {
    let changed = false;
    if (totalTokens > 0) {
      data.telemetry.allTimeTokens = (data.telemetry.allTimeTokens || 0) + totalTokens;
      const dKey = driver || "unknown";
      data.telemetry.byDriver[dKey] = (data.telemetry.byDriver[dKey] || 0) + totalTokens;
      changed = true;
    }
    if (outputTokens > 0) {
      data.telemetry.allTimeOutputTokens = (data.telemetry.allTimeOutputTokens || 0) + outputTokens;
      changed = true;
    }
    if (tps > 0) {
      data.telemetry.lastTps = Math.round(tps * 10) / 10;
      changed = true;
    }
    if (incrementRun) {
      data.telemetry.totalRuns = (data.telemetry.totalRuns || 0) + 1;
      changed = true;
    }
    if (changed) save(data);
  }

  return {
    getVersion,
    getSnapshot,
    setDefaultSelection,
    upsertCustomProfile,
    deleteCustomProfile,
    findProfile,
    recordUsageDelta,
  };
}
