import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

// A minimal MCP client: newline-delimited JSON-RPC over a child's stdio. It is
// the ONLY way the tests talk to DemoMotion the way a real MCP client does —
// spawning the server as a process and reading its stdout byte by byte — and it
// is shared by the repo e2e suite (tsx entry) and the pack suite (the tarball's
// bin), so the two exercise one and the same wire.

export type ToolResult = { isError: boolean; text: string; payload: any };

/** Longest a single JSON-RPC call may take before the test calls it a hang. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export interface StartOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Client name sent in `initialize`. */
  clientName?: string;
  /** Called with every tool name `callTool` sends; a coverage hook. */
  onToolCall?: (name: string) => void;
  /** Forward the spawned server's stderr to ours (DEMOMOTION_E2E_DEBUG=1 does this). */
  forwardStderr?: boolean;
}

/** Progress marker on stderr — the only way to see where a wire test is stuck. */
export function step(message: string) {
  process.stderr.write(`[e2e ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

export class McpStdioClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (msg: any) => void>();
  /** The very first chunk the server wrote to stdout, untouched. */
  firstStdoutChunk: string | undefined;
  /** Everything the server wrote to stderr, for assertions about warnings. */
  stderr = "";
  /** The `initialize` result. */
  initResult: any;

  /** The spawned server's pid: the ancestor of every browser it launches. */
  get pid(): number {
    return this.child.pid!;
  }

  private constructor(private readonly child: ChildProcess, private readonly onToolCall?: (name: string) => void) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (this.firstStdoutChunk === undefined) this.firstStdoutChunk = chunk;
      this.onData(chunk);
    });
    child.stderr!.setEncoding("utf8");
  }

  static async start(options: StartOptions): Promise<McpStdioClient> {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? { ...process.env }
    });
    const client = new McpStdioClient(child, options.onToolCall);
    const forward = options.forwardStderr ?? process.env.DEMOMOTION_E2E_DEBUG === "1";
    child.stderr!.on("data", (d: string) => {
      client.stderr += d;
      if (forward) process.stderr.write(`[server] ${d}`);
    });
    client.initResult = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: options.clientName ?? "demomotion-test", version: "0" }
    });
    assert.equal(client.initResult.serverInfo?.name, "demomotion",
      `unexpected serverInfo: ${JSON.stringify(client.initResult)}`);
    client.notify("notifications/initialized", {});
    return client;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = message.id != null ? this.pending.get(message.id) : undefined;
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  /**
   * Resolves with the JSON-RPC `result`; rejects on a transport-level `error`.
   * A call that never answers rejects too — a wire that hangs is a failure, and
   * a test that waited forever would report nothing at all.
   */
  request(method: string, params: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown) {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /**
   * Calls a tool and decodes the result BODY.
   *
   * An MCP tool failure is a normal result carrying `isError: true`, not a
   * transport failure — a test that only checked "no exception was thrown"
   * would pass on every single broken tool. Nothing here throws on `isError`;
   * the caller decides which half it is asserting.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> {
    step(`-> ${name}`);
    this.onToolCall?.(name);
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    step(`<- ${name}${result.isError === true ? " (isError)" : ""}`);
    const text = result?.content?.[0]?.text ?? "";
    assert.equal(result?.content?.[0]?.type, "text", `${name} returned no text content: ${JSON.stringify(result)}`);
    let payload: any = undefined;
    if (result.isError !== true) {
      payload = JSON.parse(text); // every tool answers with JSON.stringify'd data
    }
    return { isError: result.isError === true, text, payload };
  }

  /** Calls a tool and asserts it SUCCEEDED, surfacing the error body if not. */
  async callOk(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    const result = await this.callTool(name, args, timeoutMs);
    assert.equal(result.isError, false, `${name} came back as an MCP error: ${result.text}`);
    return result.payload;
  }

  /**
   * Tears the server down for real. SIGTERM alone left the child alive in an
   * early version of this test, and a live child keeps the runner's event loop
   * open — the process then hangs AFTER the assertions, and node:test never
   * flushes the failure. SIGKILL, then drop the stream handles.
   */
  close() {
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.stdin?.destroy();
    this.child.kill("SIGKILL");
    this.child.unref();
  }
}
