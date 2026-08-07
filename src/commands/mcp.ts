/**
 * MCP Command Group - Model Context Protocol CLI commands.
 *
 * This simplified command set focuses on the stdio transport, which is the
 * only supported transport for Backlog.md's local MCP integration.
 */

import type { Command } from "commander";
import { createMcpServer, type McpServer } from "../mcp/server.ts";
import { findBacklogRoot } from "../utils/find-backlog-root.ts";
import { resolveRuntimeCwd } from "../utils/runtime-cwd.ts";

type StartOptions = {
	debug?: boolean;
	cwd?: string;
};

/**
 * Register MCP command group with CLI program.
 *
 * @param program - Commander program instance
 */
export function registerMcpCommand(program: Command): void {
	const mcpCmd = program.command("mcp");
	registerStartCommand(mcpCmd);
}

/**
 * Register 'mcp start' command for stdio transport.
 */
function registerStartCommand(mcpCmd: Command): void {
	mcpCmd
		.command("start")
		.description("Start the MCP server using stdio transport")
		.option("-d, --debug", "Enable debug logging", false)
		.option("--cwd <path>", "Directory to resolve Backlog root from (overrides BACKLOG_CWD)")
		.action(async (options: StartOptions) => {
			// HYBRID-BOARD: Signal handlers installed BEFORE async init (TASK-95).
			// If the MCP adapter kills us during createMcpServer/connect (workspace
			// switch, session restart), these ensure we exit cleanly instead of
			// relying on SIGKILL — which fails if the process is in uninterruptible
			// wait (UE) state. The server reference starts null; shutdown checks
			// before calling stop().
			let server: McpServer | null = null;
			let shutdownTriggered = false;

			const shutdown = async (signal: string) => {
				if (shutdownTriggered) {
					return;
				}
				shutdownTriggered = true;
				if (options.debug) {
					console.error(`Received ${signal}, shutting down MCP server...`);
				}

				try {
					if (server) {
						await server.stop();
					}
					process.exit(0);
				} catch (error) {
					console.error("Error during MCP server shutdown:", error);
					process.exit(1);
				}
			};

			// Install signal handlers BEFORE any async work
			const handleStdioClose = () => shutdown("stdio");
			process.stdin.once("end", handleStdioClose);
			if (process.platform !== "win32") {
				// On Windows, stdin can emit "close" while the MCP stdio pipe is still usable.
				process.stdin.once("close", handleStdioClose);
			}

			const handlePipeError = (error: unknown) => {
				const code =
					error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code ?? "") : "";
				if (code === "EPIPE") {
					void shutdown("EPIPE");
				}
			};
			process.stdout.once("error", handlePipeError);
			process.stderr.once("error", handlePipeError);

			process.once("SIGINT", () => shutdown("SIGINT"));
			process.once("SIGTERM", () => shutdown("SIGTERM"));
			if (process.platform !== "win32") {
				process.once("SIGHUP", () => shutdown("SIGHUP"));
				process.once("SIGPIPE", () => shutdown("SIGPIPE"));
			}

			// Async init — if killed here, signal handlers above ensure clean exit
			try {
				const runtimeCwd = await resolveRuntimeCwd({ cwd: options.cwd });
				const projectRoot = (await findBacklogRoot(runtimeCwd.cwd)) ?? runtimeCwd.cwd;
				// An explicit --cwd/BACKLOG_CWD pins the root; an inferred process.cwd()
				// lets the server follow the client's workspace roots instead.
				const pinned = runtimeCwd.source !== "process";
				server = await createMcpServer(projectRoot, { debug: options.debug, pinned });

				await server.connect();
				await server.start();

				if (options.debug) {
					if (runtimeCwd.source !== "process") {
						console.error(`Using MCP start directory from ${runtimeCwd.sourceLabel}: ${runtimeCwd.cwd}`);
					}
					console.error("Backlog.md MCP server started (stdio transport)");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to start MCP server: ${message}`);
				process.exit(1);
			}
		});
}
