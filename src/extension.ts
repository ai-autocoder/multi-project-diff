import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { DiffResult } from "./types";
import { DiffItem, ProjectDiffView, TopDiffItem } from "./projectDiffView";
import { WorkerPool } from "./workerPool";
import { DiffCache } from "./diffCache";

export interface DiffGroup {
	name: string;
	ignoreWhiteSpace: boolean;
	workspaces: Array<Project>;
}

export interface Project {
	name: string;
	path: string;
}

export type MatchingGroup = DiffGroup | undefined | null;

// Define a class to manage the shared state
class DiffState {
	private currentFilePath: string | null = null;
	private currentResults: DiffResult[] = [];
	private currentMatchingGroup: MatchingGroup;
	private currentMatchingProject: Project | undefined;
	private currentReferenceFilePath: string | null = null;

	setCurrentState(state: {
		filePath: string | null;
		results: DiffResult[];
		matchingGroup: MatchingGroup;
		matchingProject?: Project;
		referenceFilePath?: string | null;
	}) {
		this.currentFilePath = state.filePath;
		this.currentResults = state.results;
		this.currentMatchingGroup = state.matchingGroup;
		this.currentMatchingProject = state.matchingProject;
		if (state.referenceFilePath !== undefined) {
			this.currentReferenceFilePath = state.referenceFilePath;
		}
	}

	getCurrentState() {
		return {
			filePath: this.currentFilePath,
			results: this.currentResults,
			matchingGroup: this.currentMatchingGroup,
			matchingProject: this.currentMatchingProject,
			referenceFilePath: this.currentReferenceFilePath,
		};
	}

	setReferenceFile(filePath: string | null) {
		this.currentReferenceFilePath = filePath;
	}

	clearState() {
		this.currentFilePath = null;
		this.currentResults = [];
		this.currentMatchingGroup = undefined;
		this.currentMatchingProject = undefined;
		this.currentReferenceFilePath = null;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const projectDiffView = new ProjectDiffView();
	const workspaceConfig =
		vscode.workspace.getConfiguration("multiProjectsDiff");
	const diffState = new DiffState();

	// Cache recent diff results keyed by file paths + mtimes
	const diffCache = new DiffCache(1000);

	// Track concurrent runs to avoid stale updates and allow cancellation
	let currentRunId = 0;
	let activeRunCts: vscode.CancellationTokenSource | null = null;

	// Watch toggle state and context key for menus
	let watchEnabled = false;
	vscode.commands.executeCommand(
		"setContext",
		"multiProjectsDiff.watchEnabled",
		watchEnabled
	);

	// Create and register the TreeView
	const treeView = vscode.window.createTreeView("multiProjectsDiffView", {
		treeDataProvider: projectDiffView,
	});
	context.subscriptions.push(treeView);

	// Heuristics for eligibility
	const MAX_WATCH_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
	const BINARY_EXTS = new Set([
		"png","jpg","jpeg","gif","bmp","ico","webp",
		"mp3","wav","flac","mp4","avi","mov","mkv",
		"zip","rar","7z","gz","bz2","xz","tar",
		"exe","dll","so","dylib","pdf"
	]);

	function isBinaryLike(fsPath: string): boolean {
		const ext = path.extname(fsPath).toLowerCase().replace(/^\./, "");
		if (ext && BINARY_EXTS.has(ext)) return true;
		try {
			const fd = fs.openSync(fsPath, "r");
			try {
				const len = 512;
				const buf = Buffer.allocUnsafe(len);
				const bytes = fs.readSync(fd, buf, 0, len, 0);
				let suspicious = 0;
				for (let i = 0; i < bytes; i++) {
					const c = buf[i];
					if (c === 0) return true; // NUL byte
					// allow tab/newline/carriage return
					if (c === 9 || c === 10 || c === 13) continue;
					// printable ASCII range
					if (c >= 32 && c <= 126) continue;
					// allow some UTF-8 bytes (>127) as text; count as suspicious but tolerate up to 30%
					suspicious++;
				}
				if (bytes > 0 && suspicious / bytes > 0.3) return true;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			// If we can't read the file, play safe and treat as binary-like to avoid noisy diffs
			return true;
		}
		return false;
	}

	function getEligibleActiveFilePath(): string | null {
		const editor = vscode.window.activeTextEditor;
		const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		if (!editor || !activeTab) return null;
		if (activeTab.input instanceof vscode.TabInputTextDiff) return null;
		if (!(activeTab.input instanceof vscode.TabInputText)) return null;
		const uri = editor.document.uri;
		if (uri.scheme !== "file") return null;
		const fsPath = uri.fsPath;
		if (!fs.existsSync(fsPath)) return null;
		try {
			const stat = fs.statSync(fsPath);
			if (!stat.isFile()) return null;
			if (stat.size > MAX_WATCH_FILE_BYTES) return null;
		} catch {
			return null;
		}
		if (isBinaryLike(fsPath)) return null;
		return fsPath;
	}


	// The main diff runner - now accepts optional reference file path
	async function runDiff(
		chosenGroupName?: DiffGroup,
		referenceFilePath?: string
	) {
		// Bump run id and cancel any previous run immediately
		const myRunId = ++currentRunId;
		if (activeRunCts) {
			activeRunCts.cancel();
			activeRunCts.dispose();
		}
		activeRunCts = new vscode.CancellationTokenSource();
		try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage("No active editor found.");
				projectDiffView.refresh({
					filePath: null,
					results: [],
					matchingGroup: null,
					referenceFilePath: null,
				});
				diffState.clearState();
				return;
			}

			const currentFilePath = editor.document.fileName;
			const diffGroups: DiffGroup[] =
				workspaceConfig.get<DiffGroup[]>("diffGroups") || [];

			// Effective reference file path:
			// 1. Provided referenceFilePath
			// 2. Previous reference (if any)
			// 3. Current file (if no previous reference)
			const previousRef =
				diffState.getCurrentState().referenceFilePath ?? undefined;
			const effectiveReferenceFilePath =
				referenceFilePath ?? previousRef ?? currentFilePath;

			// Attempt to find which group the reference file belongs to
			let matchingGroup: DiffGroup | undefined;
			let matchingProject: Project | undefined;

			if (chosenGroupName) {
				matchingGroup = chosenGroupName;
				// Still need to find the matching project for the reference file
				const normFilePath = effectiveReferenceFilePath
					.toLowerCase()
					.replace(/\\/g, "/");
				for (const workspace of matchingGroup.workspaces) {
					const normWorkspacePath = workspace.path
						.toLowerCase()
						.replace(/\\/g, "/");
					if (normFilePath.startsWith(normWorkspacePath)) {
						matchingProject = workspace;
						break;
					}
				}
			} else {
				const normFilePath = effectiveReferenceFilePath
					.toLowerCase()
					.replace(/\\/g, "/");

				for (const group of diffGroups) {
					for (const workspace of group.workspaces) {
						const normWorkspacePath = workspace.path
							.toLowerCase()
							.replace(/\\/g, "/");
						if (normFilePath.startsWith(normWorkspacePath)) {
							matchingGroup = group;
							matchingProject = workspace;
							break;
						}
					}
					if (matchingGroup) break;
				}
			}

			// If we didn't find any group, prompt user to pick from available
			if (!matchingGroup) {
				if (diffGroups.length === 0) {
					vscode.window.showWarningMessage(
						"No matching group for current file."
					);
				}

				const state = {
					filePath: currentFilePath,
					results: [],
					matchingProject: { name: "", path: "" },
					matchingGroup: null,
					referenceFilePath: effectiveReferenceFilePath,
				};
				projectDiffView.refresh(state);
				diffState.setCurrentState(state);
				return;
			}

			// We have a matching group
			// Derive a relative path for the reference file
			const relativePath: string = path.relative(
				matchingProject?.path || "",
				effectiveReferenceFilePath
			);

			// Do the comparisons with a view-scoped progress indicator (concurrency-limited)
			const results: DiffResult[] = await vscode.window.withProgress(
				{
					location: { viewId: "multiProjectsDiffView" },
					title: "Loading diffs...",
				},
				async (progress, token) => {
					const workspaces = matchingGroup!.workspaces;
					const total = workspaces.length;
					const out: DiffResult[] = new Array(total);
					let completed = 0;

					// Progress weighting: 90% for diffing, 10% for post-processing
					const diffWeight = 90;
					const perItemInc = total > 0 ? diffWeight / total : diffWeight;

					const workerPath = path.join(__dirname, "diffWorker.js");
					const poolSize = Math.min(Math.max(1, os.cpus().length - 1), Math.max(1, Math.min(6, total)));
					let pool: WorkerPool<any, DiffResult> | null = new WorkerPool<any, DiffResult>(workerPath, poolSize);
					const localCancel = () => {
						// Best-effort immediate shutdown of workers
						if (pool) {
							const p = pool;
							pool = null;
							// Fire and forget; awaiting in finally
							p.close().catch(() => {});
						}
					};
					const disposables: vscode.Disposable[] = [];
					disposables.push(token.onCancellationRequested(localCancel));
					// Also cancel if a newer run starts
					if (activeRunCts) {
						disposables.push(activeRunCts.token.onCancellationRequested(localCancel));
					}
					// Read the reference file once to avoid re-reading it in every worker
					let baseContent: string | undefined = undefined;
					try {
						baseContent = await fs.promises.readFile(effectiveReferenceFilePath, "utf8");
					} catch {}
					// Stat the reference file once for cache keying
					let baseMtimeMs = -1;
					try {
						const st = await fs.promises.stat(effectiveReferenceFilePath);
						baseMtimeMs = st.mtimeMs;
					} catch {}
					try {
						const tasks = workspaces.map(async (ws, idx) => {
							if (token.isCancellationRequested || (activeRunCts?.token.isCancellationRequested ?? false) || myRunId !== currentRunId) {
								return undefined as unknown as DiffResult;
							}
							const p = pool;
							if (!p) {
								return undefined as unknown as DiffResult;
							}
							// Resolve compare path for cache and self-compare check
							const comparePath = path.join(ws.path, relativePath);
							// Skip self-compare (same file as reference)
							const isSameFile = (process.platform === "win32" || process.platform === "darwin")
								? comparePath.toLowerCase() === effectiveReferenceFilePath.toLowerCase()
								: comparePath === effectiveReferenceFilePath;
							if (isSameFile) {
								const zero: DiffResult = {
									projectName: ws.name,
									diffLineCount: 0,
									diffDetail: { added: 0, removed: 0 },
									compareFilePath: comparePath,
									fileExists: true,
									compareWorkspaceFilePath: ws.path,
								};
								out[idx] = zero;
								completed += 1;
								progress.report({ increment: perItemInc, message: `Skipped ${ws.name}` });
								return zero;
							}

							// Compare file mtime for cache keying
							let compareMtimeMs = -1;
							try {
								const st = await fs.promises.stat(comparePath);
								compareMtimeMs = st.mtimeMs;
							} catch {}

							// Try cache first
							const cached = diffCache.get({
								basePath: effectiveReferenceFilePath,
								baseMtimeMs,
								comparePath,
								compareMtimeMs,
								ignoreWhitespace: matchingGroup!.ignoreWhiteSpace,
							});
							if (cached) {
								// Adjust project/name/path fields to the current ws
								const resFromCache: DiffResult = {
									...cached,
									projectName: ws.name,
									compareFilePath: comparePath,
									compareWorkspaceFilePath: ws.path,
								};
								out[idx] = resFromCache;
								completed += 1;
								progress.report({ increment: perItemInc, message: `Cached ${ws.name}` });
								return resFromCache;
							}

							// Fallback to worker
							const res = await p.run({
								currentFilePath: effectiveReferenceFilePath,
								compareWorkspaceFilePath: ws.path,
								compareRelativeFilePath: relativePath,
								compareWorkspaceName: ws.name,
								ignoreWhiteSpace: matchingGroup!.ignoreWhiteSpace,
								baseContent,
							});
							// Populate cache (even missing files)
							diffCache.set({
								basePath: effectiveReferenceFilePath,
								baseMtimeMs,
								comparePath,
								compareMtimeMs,
								ignoreWhitespace: matchingGroup!.ignoreWhiteSpace,
							}, res);
							out[idx] = res;
							completed += 1;
							progress.report({ increment: perItemInc, message: `Compared ${ws.name}` });
							return res;
						});
						// Wait for tasks to finish, or cancel early if this run becomes stale
						await Promise.race([
							Promise.allSettled(tasks).then(() => undefined),
							new Promise<void>((resolve) => {
								if (activeRunCts) {
									const sub = activeRunCts.token.onCancellationRequested(() => {
										resolve();
										sub.dispose();
									});
								}
							}),
							new Promise<void>((resolve) => {
								const sub = token.onCancellationRequested(() => {
									resolve();
									sub.dispose();
								});
							}),
						]);
					} finally {
						try {
							if (pool) {
								await pool.close();
							}
						} finally {
							for (const d of disposables) d.dispose();
						}
					}

					if (token.isCancellationRequested || (activeRunCts?.token.isCancellationRequested ?? false) || myRunId !== currentRunId) {
						return out.filter(Boolean) as DiffResult[];
					}

					// Post-processing: sort and filter before returning
					progress.report({ message: "Sorting and filtering…" });
					let results = (out.filter(Boolean) as DiffResult[]);
					results.sort((a, b) => {
						if (a.fileExists !== b.fileExists) return a.fileExists ? -1 : 1;
						return a.diffLineCount - b.diffLineCount;
					});

					const isCaseSensitiveFileSystem = process.platform !== "win32" && process.platform !== "darwin";
					results = results.filter((r) => {
						if (isCaseSensitiveFileSystem) {
							return r.compareFilePath !== effectiveReferenceFilePath;
						} else {
							return r.compareFilePath.toLowerCase() !== effectiveReferenceFilePath.toLowerCase();
						}
					});

					progress.report({ increment: 100 - Math.min(100, completed * perItemInc), message: "Finalizing…" });
					return results;
				}
			);

			// If a newer run has started, don't update UI with stale data
			if (myRunId !== currentRunId) {
				return;
			}

			const state = {
				filePath: currentFilePath,
				results: results,
				matchingGroup,
				matchingProject,
				referenceFilePath: effectiveReferenceFilePath,
			};

			projectDiffView.refresh(state);
			diffState.setCurrentState(state);
		} catch (error) {
			// Handle any errors
			console.error(error);
			// Avoid surfacing errors from stale runs
			if (myRunId === currentRunId) {
				vscode.window.showErrorMessage(
					"An error occurred while processing the diff."
				);
			}
			projectDiffView.refresh({
				filePath: null,
				results: [],
				matchingGroup: null,
				referenceFilePath: null,
			});
		}
	}

	// Watch toggle commands
	const enableWatchCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.enableWatch",
		async () => {
			watchEnabled = true;
			await vscode.commands.executeCommand(
				"setContext",
				"multiProjectsDiff.watchEnabled",
				true
			);
			vscode.window.setStatusBarMessage("Multi Projects Diff: Watch ON", 2000);

			const eligiblePath = getEligibleActiveFilePath();
			if (eligiblePath) {
				await vscode.commands.executeCommand(
					"multiProjectsDiff.setActiveAsReference"
				);
			}
		}
	);
	context.subscriptions.push(enableWatchCmd);

	const disableWatchCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.disableWatch",
		async () => {
			watchEnabled = false;
			await vscode.commands.executeCommand(
				"setContext",
				"multiProjectsDiff.watchEnabled",
				false
			);
			vscode.window.setStatusBarMessage("Multi Projects Diff: Watch OFF", 2000);
		}
	);
	context.subscriptions.push(disableWatchCmd);

	// React to active editor changes when watching is enabled
	const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
		if (!watchEnabled || !treeView.visible) return;
		const eligiblePath = getEligibleActiveFilePath();
		if (!eligiblePath) return;
		vscode.commands.executeCommand("multiProjectsDiff.setActiveAsReference");
	});
	context.subscriptions.push(activeEditorListener);

	// Refresh when the view becomes visible (if watching)
	const visibilityListener = treeView.onDidChangeVisibility((e) => {
		if (watchEnabled && e.visible) {
			vscode.commands.executeCommand("multiProjectsDiff.setActiveAsReference");
		}
	});
	context.subscriptions.push(visibilityListener);

	// Command: Refresh Diff (only refreshes against current reference)
	const refreshDiffCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.refreshDiff",
		async () => {
			const state = diffState.getCurrentState();
			await runDiff(
				state.matchingGroup || undefined,
				state.referenceFilePath || undefined
			);
		}
	);
	context.subscriptions.push(refreshDiffCmd);

	// Command: Set Active File as Reference
	const setActiveAsReferenceCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.setActiveAsReference",
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage("No active editor found.");
				return;
			}
			const eligiblePath = getEligibleActiveFilePath();
			if (!eligiblePath) {
				vscode.window.showWarningMessage(
					"Active tab is not a single file. Open a file tab to set as reference."
				);
				return;
			}
			await runDiff(undefined, eligiblePath);
		}
	);
	context.subscriptions.push(setActiveAsReferenceCmd);

	// Command: Set Reference File
	const setReferenceFileCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.setReferenceFile",
		async (item: DiffItem) => {
			if (!item.diff.fileExists) {
				vscode.window.showErrorMessage(
					`Cannot set missing file as reference: ${item.diff.projectName}`
				);
				return;
			}

			const state = diffState.getCurrentState();
			await runDiff(
				state.matchingGroup || undefined,
				item.diff.compareFilePath
			);
		}
	);
	context.subscriptions.push(setReferenceFileCmd);

	// Command: Open Split-Screen Diff
	const openDiffCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.openDiff",
		async (diffResult: DiffResult) => {
			if (!diffResult?.fileExists) {
				vscode.window.showErrorMessage(
					`File does not exist in project ${diffResult?.projectName || ""}.`
				);
				return;
			}

			const state = diffState.getCurrentState();
			if (!state.referenceFilePath) {
				vscode.window.showErrorMessage("No reference file available.");
				return;
			}

			const leftUri = vscode.Uri.file(state.referenceFilePath);
			const rightUri = vscode.Uri.file(diffResult.compareFilePath);

			// Get the project name for the reference file
			const referenceProjectName = state.matchingProject?.name || "Reference";

			await vscode.commands.executeCommand(
				"vscode.diff",
				leftUri,
				rightUri,
				`Diff: ${referenceProjectName} ↔ ${
					diffResult.projectName
				} (${path.basename(leftUri.fsPath)})`
			);
		}
	);
	context.subscriptions.push(openDiffCmd);

	// Command: createAndCopyFile
	const createAndCopyCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.createAndCopyFile",
		async (item: DiffItem) => {
			const state = diffState.getCurrentState();
			const referenceFilePath = state.referenceFilePath;

			if (!referenceFilePath) {
				vscode.window.showErrorMessage(
					"No reference file available to copy content from."
				);
				return;
			}

			const sourcePath = referenceFilePath;
			const targetPath = item.diff.compareFilePath;

			if (!fs.existsSync(sourcePath)) {
				vscode.window.showErrorMessage("Reference file does not exist.");
				return;
			}

			try {
				const targetDir = path.dirname(targetPath);
				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true });
				}
				fs.copyFileSync(sourcePath, targetPath);
				vscode.window.showInformationMessage(
					`File created and content copied to: ${targetPath}`
				);
			} catch (err: any) {
				vscode.window.showErrorMessage(
					`Failed to create and copy file: ${err.message}`
				);
			}
		}
	);
	context.subscriptions.push(createAndCopyCmd);

	// Command: openFileLocally
	const openFileCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.openFile",
		async (item: DiffItem) => {
			const filePath = item.diff.compareFilePath;

			if (!fs.existsSync(filePath)) {
				vscode.window.showErrorMessage("File does not exist.");
				return;
			}

			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}
	);
	context.subscriptions.push(openFileCmd);

	// Command: openFileWorkspace
	const openFolderCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.openFolder",
		async (item: DiffItem) => {
			const folderPath = item.diff.compareWorkspaceFilePath;

			if (!fs.existsSync(folderPath)) {
				vscode.window.showErrorMessage("Folder does not exist.");
				return;
			}

			await vscode.commands.executeCommand(
				"vscode.openFolder",
				vscode.Uri.file(folderPath),
				true
			);
		}
	);
	context.subscriptions.push(openFolderCmd);

	// Command: pickGroup
	const pickGroupCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.pickGroup",
		async (item: TopDiffItem) => {
			const diffGroups: DiffGroup[] = workspaceConfig.get("diffGroups") || [];
			const state = diffState.getCurrentState();

			const chosenGroupName = await vscode.window.showQuickPick(
				diffGroups.map((ls) => ls.name),
				{ placeHolder: "Select a group to compare the current file against:" }
			);
			if (!chosenGroupName) {
				// user canceled
				projectDiffView.refresh({
					filePath: state.filePath,
					results: [],
					matchingGroup: null,
					referenceFilePath: state.referenceFilePath,
				});
				return;
			}
			const matchingGroup = diffGroups.find(
				(ls) => ls.name === chosenGroupName
			);
			if (!matchingGroup) {
				vscode.window.showErrorMessage(`Group "${chosenGroupName}" not found.`);
				projectDiffView.refresh({
					filePath: state.filePath,
					results: [],
					matchingGroup: null,
					referenceFilePath: state.referenceFilePath,
				});
				return;
			}
			runDiff(matchingGroup, state.referenceFilePath || undefined);
		}
	);
	context.subscriptions.push(pickGroupCmd);

	// Command: copyContent
	const copyContentCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.copyContent",
		async (item: DiffItem) => {
			const state = diffState.getCurrentState();
			const sourcePath = state.referenceFilePath;
			const targetPath = item.diff.compareFilePath;

			if (!sourcePath) {
				vscode.window.showErrorMessage(
					"No reference file available to copy content from."
				);
				return;
			}

			if (!fs.existsSync(sourcePath)) {
				vscode.window.showErrorMessage("Reference file does not exist.");
				return;
			}

			try {
				fs.copyFileSync(sourcePath, targetPath);
				vscode.window.showInformationMessage(
					`Content copied to: ${targetPath}`
				);
			} catch (err: any) {
				vscode.window.showErrorMessage(
					`Failed to copy content: ${err.message}`
				);
			}
		}
	);
	context.subscriptions.push(copyContentCmd);

	// Command: openTerminal
	const openTerminalCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.openTerminal",
		async (item: DiffItem) => {
			const terminal = vscode.window.createTerminal();
			terminal.sendText(`cd ${item.diff.compareWorkspaceFilePath}`);
			terminal.show();
		}
	);
	context.subscriptions.push(openTerminalCmd);
}

export function deactivate() {
	// Cleanup, if needed
}
