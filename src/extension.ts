import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { DiffCalculator, DiffResult } from "./diffCalculator";
import { DiffItem, ProjectDiffView, TopDiffItem } from "./projectDiffView";

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

	setCurrentState(state: {
		filePath: string | null;
		results: DiffResult[];
		matchingGroup: MatchingGroup;
		matchingProject?: Project;
	}) {
		this.currentFilePath = state.filePath;
		this.currentResults = state.results;
		this.currentMatchingGroup = state.matchingGroup;
		this.currentMatchingProject = state.matchingProject;
	}

	getCurrentState() {
		return {
			filePath: this.currentFilePath,
			results: this.currentResults,
			matchingGroup: this.currentMatchingGroup,
			matchingProject: this.currentMatchingProject,
		};
	}

	clearState() {
		this.currentFilePath = null;
		this.currentResults = [];
		this.currentMatchingGroup = undefined;
		this.currentMatchingProject = undefined;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const projectDiffView = new ProjectDiffView();
	const workspaceConfig =
		vscode.workspace.getConfiguration("multiProjectsDiff");
	const diffState = new DiffState();

	// Create and register the TreeView
	const treeView = vscode.window.createTreeView("multiProjectsDiffView", {
		treeDataProvider: projectDiffView,
	});
	context.subscriptions.push(treeView);

	const diffCalculator = new DiffCalculator();

	// The main diff runner
	async function runDiff(chosenGroupName?: DiffGroup) {
		projectDiffView.setLoading(true);
		try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage("No active editor found.");
				projectDiffView.refresh({
					filePath: null,
					results: [],
					matchingGroup: null,
				});
				diffState.clearState();
				projectDiffView.setLoading(false);
				return;
			}

			const currentFilePath = editor.document.fileName;
			const doc = editor.document;
			const diffGroups: DiffGroup[] =
				workspaceConfig.get<DiffGroup[]>("diffGroups") || [];

			// Attempt to find which group the file belongs to
			let matchingGroup: DiffGroup | undefined;
			let matchingProject: Project | undefined;
			if (chosenGroupName) {
				matchingGroup = chosenGroupName;
			} else {
				const normFilePath = currentFilePath.toLowerCase().replace(/\\/g, "/");

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
				};
				projectDiffView.refresh(state);
				diffState.setCurrentState(state);
				projectDiffView.setLoading(false);
				return;
			}

			// We have a matching group
			// Derive a relative path for the file
			let relativePath: string;
			const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
			if (wsFolder) {
				relativePath = path.relative(wsFolder.uri.fsPath, currentFilePath);
			} else {
				// fallback: just use the basename
				relativePath = path.basename(currentFilePath);
			}

			// Do the comparisons
			const results: DiffResult[] = [];
			for (const workspaces of matchingGroup.workspaces) {
				const diffResult = diffCalculator.compareFile({
					currentFilePath,
					compareWorkspaceFilePath: workspaces.path,
					compareRelativeFilePath: relativePath,
					compareWorkspaceName: workspaces.name,
					ignoreWhiteSpace: matchingGroup.ignoreWhiteSpace,
				});
				results.push(diffResult);
			}

			// Sort results by ascending diff line count
			results.sort((a, b) => a.diffLineCount - b.diffLineCount);

			// File missing at the end
			results.sort((a, b) =>
				a.fileExists === b.fileExists ? 0 : a.fileExists ? -1 : 1
			);

			const isCaseSensitiveFileSystem =
				process.platform !== "win32" && process.platform !== "darwin";

			// Remove the current file from the results
			const currentResults = results.filter((r) => {
				if (isCaseSensitiveFileSystem) {
					return r.compareFilePath !== currentFilePath;
				} else {
					return (
						r.compareFilePath.toLowerCase() !== currentFilePath.toLowerCase()
					);
				}
			});

			const state = {
				filePath: currentFilePath,
				results: currentResults,
				matchingGroup,
				matchingProject,
			};

			projectDiffView.refresh(state);
			diffState.setCurrentState(state);
		} catch (error) {
			// Handle any errors
			console.error(error);
			vscode.window.showErrorMessage(
				"An error occurred while processing the diff."
			);
			projectDiffView.refresh({
				filePath: null,
				results: [],
				matchingGroup: null,
			});
		}
		projectDiffView.setLoading(false);
	}

	// Command: Refresh Diff
	const refreshDiffCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.refreshDiff",
		async () => {
			await runDiff();
		}
	);
	context.subscriptions.push(refreshDiffCmd);

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
			if (!state.filePath) {
				vscode.window.showErrorMessage("No active comparison available.");
				return;
			}

			const leftUri = vscode.Uri.file(state.filePath);
			const rightUri = vscode.Uri.file(diffResult.compareFilePath);

			await vscode.commands.executeCommand(
				"vscode.diff",
				leftUri,
				rightUri,
				`Diff: ${state.matchingProject?.name} ↔ ${
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
			const editor = diffState.getCurrentState().filePath;
			if (!editor) {
				vscode.window.showErrorMessage(
					"No active editor to copy content from."
				);
				return;
			}

			const sourcePath = diffState.getCurrentState().filePath;
			const targetPath = item.diff.compareFilePath;

			if (sourcePath && !fs.existsSync(sourcePath)) {
				vscode.window.showErrorMessage("Source file does not exist.");
				return;
			}

			try {
				const targetDir = path.dirname(targetPath);
				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true });
				}
				fs.copyFileSync(sourcePath as string, targetPath);
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
				});
				return;
			}
			runDiff(matchingGroup);
		}
	);
	context.subscriptions.push(pickGroupCmd);

	// Command: copyContent
	const copyContentCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.copyContent",
		async (item: DiffItem) => {
			const sourcePath = diffState.getCurrentState().filePath;
			const targetPath = item.diff.compareFilePath;

			if (sourcePath && !fs.existsSync(sourcePath)) {
				vscode.window.showErrorMessage("Source file does not exist.");
				return;
			}

			try {
				fs.copyFileSync(sourcePath as string, targetPath);
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
}

export function deactivate() {
	// Cleanup, if needed
}
