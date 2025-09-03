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

	// Create and register the TreeView
	const treeView = vscode.window.createTreeView("multiProjectsDiffView", {
		treeDataProvider: projectDiffView,
	});
	context.subscriptions.push(treeView);

	const diffCalculator = new DiffCalculator();

// The main diff runner - now accepts optional reference file path
async function runDiff(chosenGroupName?: DiffGroup, referenceFilePath?: string) {
	projectDiffView.setLoading(true);
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
			projectDiffView.setLoading(false);
			return;
		}

		const currentFilePath = editor.document.fileName;
		const diffGroups: DiffGroup[] =
			workspaceConfig.get<DiffGroup[]>("diffGroups") || [];

		// Use provided reference file path or current active file
		const effectiveReferenceFilePath = referenceFilePath || currentFilePath;
		
		// Attempt to find which group the reference file belongs to
		let matchingGroup: DiffGroup | undefined;
		let matchingProject: Project | undefined;
		
		if (chosenGroupName) {
			matchingGroup = chosenGroupName;
			// Still need to find the matching project for the reference file
			const normFilePath = effectiveReferenceFilePath.toLowerCase().replace(/\\/g, "/");
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
			const normFilePath = effectiveReferenceFilePath.toLowerCase().replace(/\\/g, "/");

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
			projectDiffView.setLoading(false);
			return;
		}

		// We have a matching group
		// Derive a relative path for the reference file
		const relativePath: string = path.relative(
			matchingProject?.path || "",
			effectiveReferenceFilePath
		);

		// Do the comparisons
		const results: DiffResult[] = [];
		for (const workspaces of matchingGroup.workspaces) {
			const diffResult = diffCalculator.compareFile({
				currentFilePath: effectiveReferenceFilePath,
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

		// Remove the reference file from the results
		const currentResults = results.filter((r) => {
			if (isCaseSensitiveFileSystem) {
				return r.compareFilePath !== effectiveReferenceFilePath;
			} else {
				return (
					r.compareFilePath.toLowerCase() !== effectiveReferenceFilePath.toLowerCase()
				);
			}
		});

		const state = {
			filePath: currentFilePath,
			results: currentResults,
			matchingGroup,
			matchingProject,
			referenceFilePath: effectiveReferenceFilePath,
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
			referenceFilePath: null,
		});
	}
	projectDiffView.setLoading(false);
	}

	// Command: Refresh Diff (only refreshes against current reference)
	const refreshDiffCmd = vscode.commands.registerCommand(
		"multiProjectsDiff.refreshDiff",
		async () => {
			const state = diffState.getCurrentState();
			await runDiff(state.matchingGroup || undefined, state.referenceFilePath || undefined);
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
			await runDiff(undefined, editor.document.fileName);
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
			await runDiff(state.matchingGroup || undefined, item.diff.compareFilePath);
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
				vscode.window.showErrorMessage("No reference file available to copy content from.");
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