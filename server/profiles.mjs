import fs from "node:fs";
import path from "node:path";

import { inferContextWindow } from "./drivers/utils.mjs";

function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Manages ALilaS model defaults, user-defined custom upstream profiles (env-var API keys only),
 * global settings, and persistent cross-session token telemetry (daily heatmap, per-driver, per-model,
 * and recent call performance metrics).
 */
export function createProfileStore(dataDir) {
  const filePath = path.join(dataDir, "profiles.json");

  function defaultData() {
    return {
      version: 2,
      defaultSelection: {
        driver: "", // auto-pick first installed driver if empty
        model: "",
        effort: "high",
        profileId: "",
      },
      settings: {
        idleTimeoutSec: 180,
        scanDshDesktop: true,
      },
      customProfiles: [],
      telemetry: {
        allTimeTokens: 0,
        allTimeInputTokens: 0,
        allTimeCacheReadTokens: 0,
        allTimeOutputTokens: 0,
        totalRuns: 0,
        lastTps: 0,
        lastTtftSec: 0,
        lastDurationSec: 0,
        firstUsedAt: null,
        byDriver: {},
        byModel: {},
        daily: {},
        recentCalls: [],
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
          const t = raw.telemetry || {};
          return {
            version: 2,
            defaultSelection: { ...base.defaultSelection, ...(raw.defaultSelection || {}) },
            settings: { ...base.settings, ...(raw.settings || {}) },
            customProfiles: Array.isArray(raw.customProfiles) ? raw.customProfiles : [],
            telemetry: {
              ...base.telemetry,
              ...t,
              byDriver: t.byDriver && typeof t.byDriver === "object" ? { ...t.byDriver } : {},
              byModel: t.byModel && typeof t.byModel === "object" ? { ...t.byModel } : {},
              daily: t.daily && typeof t.daily === "object" ? { ...t.daily } : {},
              recentCalls: Array.isArray(t.recentCalls) ? t.recentCalls.slice(0, 20) : [],
            },
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
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, filePath);
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
      settings: { ...data.settings },
      customProfiles: data.customProfiles.map((p) => ({ ...p })),
      telemetry: {
        ...data.telemetry,
        byDriver: { ...(data.telemetry.byDriver || {}) },
        byModel: { ...(data.telemetry.byModel || {}) },
        daily: { ...(data.telemetry.daily || {}) },
        recentCalls: (data.telemetry.recentCalls || []).slice(0, 20),
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

  function updateSettings(partial = {}) {
    let changed = false;
    if (typeof partial.idleTimeoutSec === "number" && Number.isFinite(partial.idleTimeoutSec)) {
      const clamped = Math.max(60, Math.min(Math.round(partial.idleTimeoutSec), 600));
      if (data.settings.idleTimeoutSec !== clamped) {
        data.settings.idleTimeoutSec = clamped;
        changed = true;
      }
    }
    if (typeof partial.scanDshDesktop === "boolean") {
      if (data.settings.scanDshDesktop !== partial.scanDshDesktop) {
        data.settings.scanDshDesktop = partial.scanDshDesktop;
        changed = true;
      }
    }
    if (changed) save(data);
    return { ...data.settings };
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

  function pruneOldDaily() {
    const keys = Object.keys(data.telemetry.daily || {}).sort();
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 400)) {
        delete data.telemetry.daily[k];
      }
    }
  }

  function recordUsageDelta({
    driver,
    model = "",
    effort = "",
    inputTokens = 0,
    cacheReadTokens = 0,
    outputTokens = 0,
    totalTokens = 0,
    tps = 0,
    ttftSec = 0,
    durationSec = 0,
    status = "ok",
    incrementRun = false,
  }) {
    let changed = false;
    const now = Date.now();
    const dayKey = localDateKey(now);

    if (!data.telemetry.firstUsedAt && (totalTokens > 0 || incrementRun)) {
      data.telemetry.firstUsedAt = now;
      changed = true;
    }

    if (totalTokens > 0 || incrementRun) {
      if (!data.telemetry.daily[dayKey]) {
        data.telemetry.daily[dayKey] = {
          tokens: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          runs: 0,
        };
      }
    }

    if (totalTokens > 0) {
      data.telemetry.allTimeTokens = (data.telemetry.allTimeTokens || 0) + totalTokens;
      data.telemetry.allTimeInputTokens = (data.telemetry.allTimeInputTokens || 0) + Math.max(0, inputTokens);
      data.telemetry.allTimeCacheReadTokens = (data.telemetry.allTimeCacheReadTokens || 0) + Math.max(0, cacheReadTokens);

      const dKey = driver || "unknown";
      data.telemetry.byDriver[dKey] = (data.telemetry.byDriver[dKey] || 0) + totalTokens;

      const mKey = model ? `${dKey}/${model}` : dKey;
      const prevM = data.telemetry.byModel[mKey] || { tokens: 0, runs: 0, lastTps: 0 };
      prevM.tokens += totalTokens;
      if (tps > 0) prevM.lastTps = Math.round(tps * 10) / 10;
      data.telemetry.byModel[mKey] = prevM;

      const day = data.telemetry.daily[dayKey];
      day.tokens += totalTokens;
      day.inputTokens += Math.max(0, inputTokens);
      day.cacheReadTokens += Math.max(0, cacheReadTokens);
      day.outputTokens += Math.max(0, outputTokens);
      pruneOldDaily();

      data.telemetry.recentCalls = [
        {
          time: now,
          driver: dKey,
          model: model || dKey,
          effort: effort || "",
          inputTokens: Math.max(0, inputTokens),
          cacheReadTokens: Math.max(0, cacheReadTokens),
          outputTokens: Math.max(0, outputTokens),
          totalTokens,
          tps: tps > 0 ? Math.round(tps * 10) / 10 : 0,
          ttftSec: ttftSec > 0 ? Math.round(ttftSec * 100) / 100 : 0,
          durationSec: durationSec > 0 ? Math.round(durationSec * 10) / 10 : 0,
          status,
        },
        ...(data.telemetry.recentCalls || []),
      ].slice(0, 20);
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
    if (ttftSec > 0) {
      data.telemetry.lastTtftSec = Math.round(ttftSec * 100) / 100;
      changed = true;
    }
    if (durationSec > 0) {
      data.telemetry.lastDurationSec = Math.round(durationSec * 10) / 10;
      changed = true;
    }
    if (incrementRun) {
      data.telemetry.totalRuns = (data.telemetry.totalRuns || 0) + 1;
      if (data.telemetry.daily[dayKey]) {
        data.telemetry.daily[dayKey].runs += 1;
      }
      const dKey = driver || "unknown";
      const mKey = model ? `${dKey}/${model}` : dKey;
      const prevM = data.telemetry.byModel[mKey] || { tokens: 0, runs: 0, lastTps: 0 };
      prevM.runs += 1;
      data.telemetry.byModel[mKey] = prevM;
      changed = true;
    }
    if (changed) save(data);
  }

  return {
    getVersion,
    getSnapshot,
    setDefaultSelection,
    updateSettings,
    upsertCustomProfile,
    deleteCustomProfile,
    findProfile,
    recordUsageDelta,
  };
}
