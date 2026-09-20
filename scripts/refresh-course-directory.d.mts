export function refreshCourseDirectory(token: string | undefined, fetcher?: typeof fetch, sourceId?: 'voa-level1' | 'voa-level2'): Promise<string>
export function refreshCourseDirectories(token: string | undefined, fetcher?: typeof fetch): Promise<string>
export function directoryJobDiagnostics(error: unknown): Array<{ sourceId?: 'voa-level1' | 'voa-level2'; code: string; status?: number; backendCode?: string }>
