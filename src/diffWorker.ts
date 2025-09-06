import { parentPort } from "worker_threads";
import { promises as fsp } from "fs";
import * as path from "path";
import { diffLines } from "diff";
import { DiffResult } from "./types";

interface DiffParamsIn {
  currentFilePath: string;
  compareWorkspaceFilePath: string;
  compareRelativeFilePath: string;
  compareWorkspaceName: string;
  ignoreWhiteSpace: boolean;
  baseContent?: string; // optional preloaded content of currentFilePath to avoid repeated reads
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function compareFile(params: DiffParamsIn): Promise<DiffResult> {
  const {
    currentFilePath,
    compareWorkspaceFilePath,
    compareRelativeFilePath,
    compareWorkspaceName,
    ignoreWhiteSpace,
    baseContent,
  } = params;

  const resolvedCompareFilePath = path.join(
    compareWorkspaceFilePath,
    compareRelativeFilePath
  );

  const [baseExists, compareExists] = await Promise.all([
    // If base content provided, treat base as existing
    baseContent !== undefined ? Promise.resolve(true) : fileExists(currentFilePath),
    fileExists(resolvedCompareFilePath),
  ]);

  if (!baseExists) {
    return {
      projectName: compareWorkspaceName,
      diffLineCount: 0,
      diffDetail: { added: 0, removed: 0 },
      compareFilePath: resolvedCompareFilePath,
      fileExists: compareExists,
      compareWorkspaceFilePath,
    };
  }

  if (!compareExists) {
    return {
      projectName: compareWorkspaceName,
      diffLineCount: 0,
      diffDetail: { added: 0, removed: 0 },
      compareFilePath: resolvedCompareFilePath,
      fileExists: false,
      compareWorkspaceFilePath,
    };
  }

  const [baseText, compareText] = await Promise.all([
    baseContent !== undefined ? Promise.resolve(baseContent) : fsp.readFile(currentFilePath, "utf8"),
    fsp.readFile(resolvedCompareFilePath, "utf8"),
  ]);

  // Fast path: exact equality
  if (baseText === compareText) {
    return {
      projectName: compareWorkspaceName,
      diffLineCount: 0,
      diffDetail: { added: 0, removed: 0 },
      compareFilePath: resolvedCompareFilePath,
      fileExists: true,
      compareWorkspaceFilePath,
    };
  }

  const diffChunks = diffLines(baseText, compareText, {
    ignoreWhitespace: ignoreWhiteSpace,
  });
  let diffLineCount = 0;
  let addedCount = 0;
  let removedCount = 0;

  for (const chunk of diffChunks) {
    if ((chunk as any).added) {
      const c = (chunk as any).count ?? 0;
      diffLineCount += c;
      addedCount += c;
    } else if ((chunk as any).removed) {
      const c = (chunk as any).count ?? 0;
      diffLineCount += c;
      removedCount += c;
    }
  }

  return {
    projectName: compareWorkspaceName,
    diffLineCount,
    diffDetail: { added: addedCount, removed: removedCount },
    compareFilePath: resolvedCompareFilePath,
    fileExists: true,
    compareWorkspaceFilePath,
  };
}

if (!parentPort) {
  throw new Error("diffWorker must be run as a worker thread");
}

parentPort.on("message", async (msg: any) => {
  const { id, payload } = msg || {};
  try {
    const result = await compareFile(payload as DiffParamsIn);
    parentPort!.postMessage({ id, result });
  } catch (error: any) {
    parentPort!.postMessage({ id, error: { message: String(error?.message || error) } });
  }
});
