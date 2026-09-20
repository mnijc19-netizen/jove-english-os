import type { ExternalCatalogSource } from '../src/content/external-catalog'
export function refreshCourseDirectory(token: string | undefined, fetcher?: typeof fetch, sourceId?: ExternalCatalogSource): Promise<string>
export function refreshCourseDirectories(token: string | undefined, fetcher?: typeof fetch): Promise<string>
export function directoryJobDiagnostics(error: unknown): Array<{ sourceId?: ExternalCatalogSource; code: string; status?: number; backendCode?: string }>
