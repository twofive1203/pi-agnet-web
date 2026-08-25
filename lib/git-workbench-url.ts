export function buildGitWorkbenchUrl(cwd: string): string {
  const params = new URLSearchParams({ cwd });
  return `/git?${params.toString()}`;
}
