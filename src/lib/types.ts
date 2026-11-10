/** أنواع مشتركة بين الواجهة وواجهات API (بدون أي استيراد من طبقة السيرفر) */

export interface KeyDto {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: "active" | "exhausted" | "disabled" | string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  type: "image" | "video" | "merge" | string;
  model: string;
  status: "pending" | "processing" | "completed" | "failed" | string;
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: number;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatsDto {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export interface HealthDto {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}
