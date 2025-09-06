export interface DiffCounts {
  added: number;
  removed: number;
}

export interface DiffResult {
  projectName: string;
  diffLineCount: number;
  diffDetail: DiffCounts;
  compareFilePath: string;
  fileExists: boolean;
  compareWorkspaceFilePath: string;
}
