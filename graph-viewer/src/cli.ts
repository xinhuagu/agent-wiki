#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "./server.js";

interface Args {
  wikiPath?: string;
  port?: number;
  host?: string;
  open?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--wiki-path":
      case "-w":
        out.wikiPath = argv[++i];
        break;
      case "--port":
      case "-p":
        out.port = Number(argv[++i]);
        break;
      case "--host":
        out.host = argv[++i];
        break;
      case "--open":
        out.open = true;
        break;
      default:
        if (!out.wikiPath && !a.startsWith("-")) out.wikiPath = a;
    }
  }
  return out;
}

function usage(): string {
  return [
    "agent-wiki-graph — realtime 3D knowledge graph viewer",
    "",
    "Usage:",
    "  agent-wiki-graph --wiki-path <dir> [--port 4711] [--host 127.0.0.1] [--open]",
    "",
    "Options:",
    "  -w, --wiki-path <dir>   Path to the wiki directory (required)",
    "  -p, --port <n>          HTTP port (default 4711)",
    "      --host <host>       Bind host (default 127.0.0.1)",
    "      --open              Open the browser on startup",
    "  -h, --help              Show this help",
  ].join("\n");
}

async function tryOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // best-effort; user can open the URL manually
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.wikiPath) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }
  const wikiDir = resolve(args.wikiPath!);
  if (!existsSync(wikiDir)) {
    console.error(`wiki path does not exist: ${wikiDir}`);
    process.exit(1);
  }

  const server = await startServer({
    wikiDir,
    port: args.port,
    host: args.host,
  });
  console.log(`agent-wiki graph viewer → ${server.url}`);
  console.log(`  wiki: ${wikiDir}`);
  console.log(`  watching for *.md changes. Ctrl+C to stop.`);

  if (args.open) await tryOpenBrowser(server.url);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
