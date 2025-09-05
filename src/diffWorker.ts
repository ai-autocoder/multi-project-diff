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
  } = params;

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

  const [baseContent, compareContent] = await Promise.all([
    fsp.readFile(currentFilePath, "utf8"),
    fsp.readFile(resolvedCompareFilePath, "utf8"),
  ]);

  const diffChunks = diffLines(baseContent, compareContent, {
    ignoreWhitespace: ignoreWhiteSpace,
  });
  let diffLineCount = 0;
  const addedLines: string[] = [];
  const removedLines: string[] = [];

  for (const chunk of diffChunks) {
    if ((chunk as any).added) {
      diffLineCount += (chunk as any).count ?? 0;
      addedLines.push(...(chunk as any).value.split("\n").filter(Boolean));
    } else if ((chunk as any).removed) {
      diffLineCount += (chunk as any).count ?? 0;
      removedLines.push(...(chunk as any).value.split("\n").filter(Boolean));
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
