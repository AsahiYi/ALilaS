import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Locate an executable on PATH (cross-platform, zero shell injection).
 */
export function findExecutableOnPath(names) {
  const candidates = Array.isArray(names) ? names : [names];
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((e) => e.toLowerCase())
      : [""];

  for (const name of candidates) {
    if (path.isAbsolute(name) && fs.existsSync(name)) return name;
    for (const dir of dirs) {
      const direct = path.join(dir, name);
      if (fs.existsSync(direct) && !fs.statSync(direct).isDirectory()) {
        return direct;
      }
      if (process.platform === "win32") {
        for (const ext of exts) {
          const withExt = direct + ext;
          if (fs.existsSync(withExt) && !fs.statSync(withExt).isDirectory()) {
            return withExt;
          }
        }
      }
    }
  }
  return null;
}

export function runQuickCommand(cmd, args, timeoutMs = 4500) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd),
    });
    return {
      ok: res.status === 0,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

export function inferContextWindow(modelId, fallback = 200000) {
  const m = String(modelId || "").toLowerCase();
  if (!m) return fallback;
  if (m.includes("gemini") || m.includes("deepseek-v4") || m.includes("orchestrator")) {
    return 1_000_000;
  }
  if (m.includes("claude-opus-5") || m.includes("claude-sonnet-5")) {
    return 1_000_000;
  }
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-5") || m.includes("o3") || m.includes("o4")) return 400_000;
  if (m.includes("gpt-oss") || m.includes("deepseek-v3") || m.includes("deepseek-r1")) {
    return 128_000;
  }
  return fallback;
}
