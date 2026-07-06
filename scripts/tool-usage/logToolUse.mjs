#!/usr/bin/env node
// PostToolUse フック本体。ツール実行のたびに 1イベントをローカルJSONLへ追記する。
// ネットワークもブロッキングも無し。失敗してもフックを壊さないよう常に exit 0。
//
// 標準入力(hook JSON)例:
//   { "session_id":"...", "hook_event_name":"PostToolUse",
//     "tool_name":"Bash", "tool_input":{...}, "cwd":"...", ... }

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { baseDir, eventsFile, resolveUser } from "./lib.mjs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function gitEmail() {
  try {
    return execFileSync("git", ["config", "--get", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
}

try {
  const input = JSON.parse(readStdin() || "{}");
  const tool = input.tool_name;
  if (tool) {
    const session = input.session_id || "unknown";
    const event = {
      ts: new Date().toISOString(),
      user: resolveUser(process.env, gitEmail()),
      session,
      tool,
      env: process.env.CLAUDE_ENV_KIND || (process.env.CLAUDE_CODE_REMOTE ? "web" : "local"),
    };
    const file = eventsFile(session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
    // 掃除用に baseDir を確保(synced ディレクトリ)
    fs.mkdirSync(path.join(baseDir(), "synced"), { recursive: true });
  }
} catch (e) {
  try {
    fs.appendFileSync(path.join(baseDir(), "errors.log"), `[log ${new Date().toISOString()}] ${e}\n`);
  } catch {
    /* noop */
  }
}
process.exit(0);
