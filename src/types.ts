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

