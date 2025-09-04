import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { diffLines } from "diff";

export interface DiffDetail {
	added: string[];
	removed: string[];
}

export interface DiffResult {
	projectName: string;
	diffLineCount: number;
	diffDetail: DiffDetail;
	compareFilePath: string;
	fileExists: boolean;
	compareWorkspaceFilePath: string;
}

export interface DiffParams {
	currentFilePath: string;
	compareWorkspaceFilePath: string; // e.g. workspaces.path
	compareRelativeFilePath: string; // e.g. relativePath
	compareWorkspaceName: string; // e.g. workspaces.name
	ignoreWhiteSpace: boolean;
}

/**
 * DiffCalculator performs line-by-line diffs of two files,
 * ignoring whitespace if requested.
 */
export class DiffCalculator {
	public async compareFile(params: DiffParams): Promise<DiffResult> {
		const {
			currentFilePath,
			compareWorkspaceFilePath,
			compareRelativeFilePath,
			compareWorkspaceName,
			ignoreWhiteSpace,
		} = params;

		// Resolve the compareFilePath in full, but keep compareWorkspaceFilePath separate
		const resolvedCompareFilePath = path.join(
			compareWorkspaceFilePath,
			compareRelativeFilePath
		);

		const baseExists = await fileExists(currentFilePath);
		const compareExists = await fileExists(resolvedCompareFilePath);

		if (!baseExists) {
			return {
				projectName: compareWorkspaceName,
				diffLineCount: 0,
				diffDetail: { added: [], removed: [] },
				compareFilePath: resolvedCompareFilePath,
				fileExists: compareExists,
				compareWorkspaceFilePath,
			};
		}

		if (!compareExists) {
			return {
				projectName: compareWorkspaceName,
				diffLineCount: 0,
				diffDetail: { added: [], removed: [] },
				compareFilePath: resolvedCompareFilePath,
				fileExists: false,
				compareWorkspaceFilePath,
			};
		}

		// Read file contents
		const [baseContent, compareContent] = await Promise.all([
			fsp.readFile(currentFilePath, "utf8"),
			fsp.readFile(resolvedCompareFilePath, "utf8"),
		]);

		// Perform the diff
		const diffChunks = diffLines(baseContent, compareContent, {
			ignoreWhitespace: ignoreWhiteSpace,
		});
		let diffLineCount = 0;
		const addedLines: string[] = [];
		const removedLines: string[] = [];

		for (const chunk of diffChunks) {
			if (chunk.added) {
				diffLineCount += chunk.count ?? 0;
				addedLines.push(...chunk.value.split("\n").filter(Boolean));
			} else if (chunk.removed) {
				diffLineCount += chunk.count ?? 0;
				removedLines.push(...chunk.value.split("\n").filter(Boolean));
			}
		}

		async function fileExists(p: string): Promise<boolean> {
			try {
				await fsp.access(p);
				return true;
			} catch {
				return false;
			}
		}

		return {
			projectName: compareWorkspaceName,
			diffLineCount,
			diffDetail: { added: addedLines, removed: removedLines },
			compareFilePath: resolvedCompareFilePath,
			fileExists: true,
			compareWorkspaceFilePath,
		};
	}
}
