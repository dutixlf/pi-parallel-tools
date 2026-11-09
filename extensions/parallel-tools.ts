/**
 * parallel-tools — background execution for pi's built-in tools.
 *
 *   bash/read/grep/find/ls  gain an optional `background: true` parameter: the call returns a job id
 *                           immediately and the result is delivered later
 *   job_poll                check / wait for background jobs, collect results, or cancel them
 *   /jobs                   list (or `/jobs kill <id|all>`) background jobs
 *
 * Parallel execution of tool calls issued in the same assistant message is already pi's default.
 * Finished background jobs nobody is waiting for notify the model automatically.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	defineTool,
	type ExtensionAPI,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type Block = TextBlock | ImageBlock;

type JobStatus = "running" | "done" | "error" | "cancelled";

interface Job {
	id: string;
	tool: string;
	hint: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	controller: AbortController;
	text: string;
	images: ImageBlock[];
	progress: string;
	delivered: boolean;
	watchers: number;
}

const MAX_JOBS_RUNNING = 16;
const MAX_JOBS_KEPT = 100;
const NOTIFY_DEBOUNCE_MS = 300;
const NOTIFY_INLINE_CHARS = 1500;
const DEFAULT_POLL_CHARS = 20_000;

const BACKGROUND_NOTE =
	" Set background=true to run it without waiting: it returns a job id immediately and the result is delivered later (job_poll collects it).";

const WRAPPED: Record<string, (cwd: string) => any> = {
	bash: (cwd) => createBashToolDefinition(cwd),
	read: (cwd) => createReadToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
};

const oneLine = (s: string, n: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = Math.floor(max * 0.4);
	const tail = max - head;
	return `${s.slice(0, head)}\n… [${s.length - max} chars omitted] …\n${s.slice(s.length - tail)}`;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

const textOf = (content: readonly Block[] | undefined): string =>
	(content ?? [])
		.filter((b): b is TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n");

const imagesOf = (content: readonly Block[] | undefined): ImageBlock[] =>
	(content ?? []).filter((b): b is ImageBlock => b.type === "image");

function hintOf(args: Record<string, unknown>): string {
	const pick = ["command", "path", "pattern", "query"].find((k) => typeof args[k] === "string");
	return oneLine(pick ? String(args[pick]) : JSON.stringify(args), 80);
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	const waiters = new Set<() => void>();
	let seq = 0;
	let latestCtx: ExtensionToolContext | undefined;
	let notifyTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingNotify: Job[] = [];

	const wakeWaiters = () => {
		for (const w of [...waiters]) w();
	};

	function waitUntil(cond: () => boolean, ms: number, signal: AbortSignal | undefined): Promise<void> {
		return new Promise((resolve) => {
			if (signal?.aborted || cond()) return resolve();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (timer) clearTimeout(timer);
				waiters.delete(check);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			const check = () => {
				if (cond()) finish();
			};
			waiters.add(check);
			timer = setTimeout(finish, ms);
			signal?.addEventListener("abort", finish, { once: true });
		});
	}

	function pruneJobs() {
		if (jobs.size <= MAX_JOBS_KEPT) return;
		for (const [id, j] of jobs) {
			if (jobs.size <= MAX_JOBS_KEPT) break;
			if (j.status !== "running" && j.delivered) jobs.delete(id);
		}
	}

	function flushNotify() {
		notifyTimer = undefined;
		const batch = pendingNotify.filter((j) => !j.delivered && j.watchers === 0 && j.status !== "cancelled");
		pendingNotify = [];
		if (batch.length === 0) return;
		const parts = batch.map((j) => {
			const head = `${j.status === "done" ? "✓" : "✗"} ${j.id} (${j.tool}: ${j.hint}) ${j.status} in ${fmtMs((j.endedAt ?? Date.now()) - j.startedAt)}`;
			if (j.text.length <= NOTIFY_INLINE_CHARS && j.images.length === 0) {
				j.delivered = true;
				return `${head}\n${j.text}`;
			}
			return `${head}\nOutput is ${j.text.length} chars — call job_poll {"ids":["${j.id}"]} to read it.`;
		});
		const content = `Background job${batch.length > 1 ? "s" : ""} finished:\n\n${parts.join("\n\n")}`;
		let idle = true;
		try {
			idle = latestCtx?.isIdle() ?? true;
		} catch {}
		try {
			pi.sendMessage(
				{ customType: "job-complete", content, display: true, details: { ids: batch.map((j) => j.id) } },
				idle ? { triggerTurn: true } : { deliverAs: "steer" },
			);
		} catch {}
	}

	function scheduleNotify(job: Job) {
		if (job.watchers > 0) return;
		pendingNotify.push(job);
		notifyTimer ??= setTimeout(flushNotify, NOTIFY_DEBOUNCE_MS);
	}

	function startJob(
		tool: string,
		hint: string,
		run: (signal: AbortSignal, onProgress: (text: string) => void) => Promise<{ content: Block[]; isError?: boolean }>,
	): Job {
		const job: Job = {
			id: `job_${++seq}`,
			tool,
			hint,
			status: "running",
			startedAt: Date.now(),
			controller: new AbortController(),
			text: "",
			images: [],
			progress: "",
			delivered: false,
			watchers: 0,
		};
		jobs.set(job.id, job);
		const settle = (status: JobStatus, text: string, images: ImageBlock[]) => {
			if (job.status !== "running") return;
			job.status = status;
			job.text = text;
			job.images = images;
			job.endedAt = Date.now();
			wakeWaiters();
			scheduleNotify(job);
		};
		run(job.controller.signal, (t) => {
			job.progress = t.length > 400 ? t.slice(-400) : t;
		}).then(
			(r) => settle(r.isError ? "error" : "done", textOf(r.content), imagesOf(r.content)),
			(err) => settle("error", err instanceof Error ? err.message : String(err), []),
		);
		return job;
	}

	function cancelJob(job: Job) {
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.endedAt = Date.now();
		job.delivered = true;
		job.controller.abort();
		wakeWaiters();
		return true;
	}

	function resetJobs() {
		for (const j of jobs.values()) if (j.status === "running") j.controller.abort();
		jobs.clear();
		waiters.clear();
		pendingNotify = [];
		if (notifyTimer) clearTimeout(notifyTimer);
		notifyTimer = undefined;
	}

	pi.on("session_start", async () => resetJobs());
	pi.on("session_shutdown", async () => resetJobs());

	// ------------------------------------------- built-in tools + `background`

	for (const [name, create] of Object.entries(WRAPPED)) {
		const original = create(process.cwd());
		const impls = new Map<string, any>();
		const implFor = (cwd: string) => {
			let impl = impls.get(cwd);
			if (!impl) impls.set(cwd, (impl = create(cwd)));
			return impl;
		};

		const parameters = Type.Object({
			...original.parameters.properties,
			background: Type.Optional(
				Type.Boolean({ description: "Run in the background and return a job id immediately instead of waiting for the result" }),
			),
		});

		const guidelines = [...(original.promptGuidelines ?? [])];
		if (name === "bash") {
			guidelines.push(
				"Use bash with background=true for slow independent commands (builds, test suites, servers' health checks) when you can make progress without the result; collect it later with job_poll (prefer wait_ms over polling in a loop).",
			);
		}

		pi.registerTool({
			...original,
			description: original.description + BACKGROUND_NOTE,
			promptGuidelines: guidelines,
			parameters,

			async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionToolContext) {
				const { background, ...rest } = params;
				const impl = implFor(ctx.cwd);
				if (!background) return impl.execute(toolCallId, rest, signal, onUpdate, ctx);

				latestCtx = ctx;
				const running = [...jobs.values()].filter((j) => j.status === "running").length;
				if (running >= MAX_JOBS_RUNNING) {
					throw new Error(`Too many running jobs (limit ${MAX_JOBS_RUNNING}). Poll or cancel some first.`);
				}
				const hint = hintOf(rest);
				const job = startJob(name, hint, (sig, progress) =>
					impl.execute(toolCallId, rest, sig, (partial: any) => progress(textOf(partial?.content)), ctx),
				);
				pruneJobs();
				return {
					content: [
						{
							type: "text",
							text: `Started ${job.id} in background (${name}: ${hint}). You'll be notified when it finishes; use job_poll to collect or wait for it.`,
						},
					],
					details: { backgroundJob: { id: job.id, tool: name, hint } },
				};
			},

			renderResult(result: any, options: any, theme: any, context: any) {
				const bg = result.details?.backgroundJob;
				if (bg) {
					return new Text(theme.fg("accent", `⇢ ${bg.id}`) + theme.fg("dim", " running in background"), 0, 0);
				}
				return original.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
			},
		});
	}

	// -------------------------------------------------------------- job_poll

	pi.registerTool(
		defineTool({
			name: "job_poll",
			label: "Poll jobs",
			description:
				"Check background jobs started with background=true on bash/read/grep/find/ls. Returns results of finished jobs (each delivered once unless you pass explicit ids) and status of running ones. " +
				"With wait_ms>0 it blocks until a job finishes (wait_for=any, default) or all do (wait_for=all), or the timeout hits. " +
				"Without ids it covers all running and not-yet-collected jobs. With cancel=true it aborts the selected running jobs (all running jobs when no ids).",
			promptSnippet: "job_poll: check, wait for, collect or cancel background jobs",
			parameters: Type.Object({
				ids: Type.Optional(Type.Array(Type.String(), { description: "Job ids; default all pending jobs" })),
				wait_ms: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 600_000, description: "Block up to this long for completion (default 0 = don't wait)" }),
				),
				wait_for: Type.Optional(StringEnum(["any", "all"] as const, { description: "Default: any" })),
				max_chars: Type.Optional(
					Type.Integer({ minimum: 500, maximum: 200_000, description: `Max output chars per job (default ${DEFAULT_POLL_CHARS})` }),
				),
				cancel: Type.Optional(Type.Boolean({ description: "Abort the selected running jobs instead of polling" })),
			}),

			async execute(_id, params, signal, _onUpdate, ctx) {
				latestCtx = ctx;

				if (params.cancel) {
					const targets = params.ids?.length
						? params.ids.map((id) => jobs.get(id)).filter((j): j is Job => !!j)
						: [...jobs.values()];
					const cancelled = targets.filter(cancelJob).map((j) => j.id);
					return {
						content: [{ type: "text", text: cancelled.length ? `Cancelled: ${cancelled.join(", ")}` : "No running jobs matched." }],
						details: { cancelled },
					};
				}

				const missing: string[] = [];
				let target: Job[];
				if (params.ids?.length) {
					target = [];
					for (const id of params.ids) {
						const j = jobs.get(id);
						if (j) target.push(j);
						else missing.push(id);
					}
				} else {
					target = [...jobs.values()].filter((j) => j.status === "running" || !j.delivered);
				}
				if (target.length === 0) {
					return {
						content: [{ type: "text", text: missing.length ? `Unknown job id(s): ${missing.join(", ")}` : "No pending jobs." }],
						details: { jobs: [] },
					};
				}

				const settled = (j: Job) => j.status !== "running";
				const ready = () => (params.wait_for === "all" ? target.every(settled) : target.some(settled));
				const waitMs = params.wait_ms ?? 0;
				let timedOut = false;
				if (waitMs > 0 && !ready()) {
					for (const j of target) j.watchers++;
					try {
						await waitUntil(ready, waitMs, signal);
					} finally {
						for (const j of target) j.watchers--;
					}
					if (signal?.aborted) throw new Error("job_poll aborted");
					timedOut = !ready();
				}

				const maxChars = params.max_chars ?? DEFAULT_POLL_CHARS;
				const content: Block[] = [];
				const blocks: string[] = [];
				const now = Date.now();
				for (const j of target) {
					const elapsed = fmtMs((j.endedAt ?? now) - j.startedAt);
					const head = `### ${j.id} · ${j.tool} · ${j.status} · ${elapsed}`;
					if (j.status === "running") {
						blocks.push(`${head}\n${j.hint}${j.progress ? `\nlatest output: …${j.progress.slice(-300)}` : ""}`);
					} else {
						j.delivered = true;
						content.push(...j.images);
						blocks.push(`${head}\n${j.status === "cancelled" ? "(cancelled)" : clip(j.text, maxChars)}`);
					}
				}
				if (missing.length) blocks.push(`Unknown job id(s): ${missing.join(", ")}`);
				const stillRunning = [...jobs.values()].filter((j) => j.status === "running").map((j) => j.id);
				const finishedNow = target.filter(settled).length;
				let header = `${finishedNow}/${target.length} job(s) finished`;
				if (timedOut) header = `Timed out after ${fmtMs(waitMs)}; ${header}`;
				const footer = stillRunning.length ? `\n\nStill running: ${stillRunning.join(", ")}` : "";
				content.unshift({ type: "text", text: `${header}\n\n${blocks.join("\n\n")}${footer}` });

				return {
					content,
					details: {
						jobs: target.map((j) => ({ id: j.id, tool: j.tool, status: j.status, ms: (j.endedAt ?? now) - j.startedAt })),
					},
				};
			},

			renderCall(args, theme) {
				let text = theme.fg("toolTitle", theme.bold(args.cancel ? "job_cancel " : "job_poll "));
				text += theme.fg("muted", args.ids?.length ? args.ids.join(", ") : args.cancel ? "all running" : "all pending");
				if (args.wait_ms && !args.cancel) text += theme.fg("dim", ` · wait ${fmtMs(args.wait_ms)} (${args.wait_for ?? "any"})`);
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const lines = textOf(result.content as Block[]).split("\n");
				const shown = expanded ? lines : lines.slice(0, 10);
				let out = shown.map((l) => theme.fg("muted", l)).join("\n");
				if (!expanded && lines.length > 10) out += `\n${theme.fg("dim", `… ${lines.length - 10} more lines`)}`;
				return new Text(out, 0, 0);
			},
		}),
	);

	// ----------------------------------------------------------------- /jobs

	pi.registerCommand("jobs", {
		description: "List background jobs; `/jobs kill <id|all>` cancels",
		handler: async (arg, ctx) => {
			const [cmd, target] = (arg ?? "").trim().split(/\s+/);
			if (cmd === "kill") {
				const list = target === "all" ? [...jobs.values()] : [jobs.get(target)].filter((j): j is Job => !!j);
				const n = list.filter(cancelJob).length;
				ctx.ui.notify(`Cancelled ${n} job(s)`, "info");
				return;
			}
			if (jobs.size === 0) return ctx.ui.notify("No background jobs", "info");
			const lines = [...jobs.values()].map(
				(j) => `${j.id} ${j.status.padEnd(9)} ${fmtMs((j.endedAt ?? Date.now()) - j.startedAt).padStart(7)}  ${j.tool} ${j.hint}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
