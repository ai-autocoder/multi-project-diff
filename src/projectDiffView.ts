import * as vscode from "vscode";
import * as path from "path";
import { DiffResult } from "./diffCalculator";
import { Project, MatchingGroup } from "./extension";

/**
 * A single entry in our "Multi Projects Diff" tree.
 */
export class DiffItem extends vscode.TreeItem {
	constructor(public diff: DiffResult) {
		// Label: [Project Name] ([Added]/[Removed])
		super(
			`${diff.projectName} (${diff.diffDetail.added.length}/${diff.diffDetail.removed.length})`,
			vscode.TreeItemCollapsibleState.None
		);

		// Tooltip to provide detailed information
		this.tooltip = diff.fileExists
			? `Lines added: ${diff.diffDetail.added.length}, removed: ${diff.diffDetail.removed.length}`
			: `File not found: ${diff.compareFilePath}`;

		// Description and contextValue for menu commands
		if (diff.fileExists) {
			this.description = ""; // No "File Missing" text
			this.contextValue = "multiProjectsDiff.fileExists";
		} else {
			this.description = "File Missing";
			this.contextValue = "multiProjectsDiff.fileMissing";
		}

		// Add command for opening the diff (when clicking the item itself)
		if (diff.fileExists) {
			this.command = {
				command: "multiProjectsDiff.openDiff",
				title: "Open Diff",
				arguments: [this.diff],
			};
		}

		this.iconPath = diff.fileExists
			? new vscode.ThemeIcon("files")
			: new vscode.ThemeIcon(
					"warning",
					new vscode.ThemeColor("problemsWarningIcon.foreground")
			  );
	}
}

/**
 * Special tree item at the top that shows the currently compared file and offers a "Refresh" button.
 */
export class TopDiffItem extends vscode.TreeItem {
	constructor(filePath: string = "", matchingProject?: Project) {
		// Show the filename as the label
		super(
			`${matchingProject?.name ?? ""} ${
				path.basename(filePath) ? "[ " + path.basename(filePath) + " ]" : ""
			}`
		);

		// Show the folder in description
		if (filePath) {
			this.description = path.dirname(filePath);
		} else {
			this.description = "No active editor found - Click to refresh";
		}

		// Provide a command for refresh
		// When the user clicks this top item, it triggers "refreshDiff"
		this.command = {
			command: "multiProjectsDiff.refreshDiff",
			title: "Refresh Diff",
		};

		// Use a refresh icon
		this.iconPath = new vscode.ThemeIcon("refresh");
		this.tooltip = "Click to refresh the diff";

		// No collapsible children
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
	}
}

export class TopGroupItem extends vscode.TreeItem {
	constructor(
		matchingGroup: MatchingGroup,
		filePath: string = "",
		matchingProject?: Project
	) {
		// Show the filename as the label
		super("Group: " + (matchingGroup?.name ?? "-"));

		if (filePath && !matchingProject?.name) {
			this.contextValue = "multiProjectsDiff.noValidGroup";
			this.description = "File is not in a diff group";
		}

		this.iconPath = new vscode.ThemeIcon("group-by-ref-type");
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
	}
}

/**
 * The TreeDataProvider that builds our items.
 */
export class ProjectDiffView
	implements vscode.TreeDataProvider<vscode.TreeItem>
{
	private _onDidChangeTreeData: vscode.EventEmitter<
		vscode.TreeItem | undefined | void
	> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	public readonly onDidChangeTreeData: vscode.Event<
		vscode.TreeItem | undefined | void
	> = this._onDidChangeTreeData.event;

	private currentFilePath: string | null = null;
	private currentResults: DiffResult[] = [];
	private matchingProject: Project | undefined;
	private matchingGroup: MatchingGroup;
	private isLoading: boolean = false;

	public setLoading(loading: boolean): void {
		this.isLoading = loading;
		this._onDidChangeTreeData.fire();
	}

	public refresh({
		filePath,
		results,
		matchingProject,
		matchingGroup,
	}: {
		filePath: string | null;
		results: DiffResult[];
		matchingProject?: Project;
		matchingGroup: MatchingGroup;
	}): void {
		this.currentFilePath = filePath;
		this.currentResults = results;
		if (matchingProject !== undefined) {
			this.matchingProject = matchingProject;
		}
		if (matchingGroup !== undefined) {
			this.matchingGroup = matchingGroup;
		}
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): vscode.TreeItem[] {
		if (this.isLoading) {
			return [new LoadingItem()];
		}

		const topGroupItem = new TopGroupItem(
			this.matchingGroup,
			this.currentFilePath ?? "",
			this.matchingProject
		);

		// Create a top item for the "Refresh" button
		const topItem = new TopDiffItem(
			this.currentFilePath ?? "",
			this.matchingProject
		);

		// If no current file open or no results, show refresh icon only
		if (!this.currentFilePath) {
			return [topGroupItem, topItem];
		}

		// Create DiffItem for each result
		const items = this.currentResults.map((res) => new DiffItem(res));
		return [topGroupItem, topItem, ...items];
	}
}

export class LoadingItem extends vscode.TreeItem {
	constructor() {
		super("Processing...");
		this.iconPath = new vscode.ThemeIcon("loading~spin");
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
	}
}
