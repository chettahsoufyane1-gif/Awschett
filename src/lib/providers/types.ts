/**
 * واجهة المزودات الموحدة — كل مزود يطبق هذا العقد، وأي خطأ يُرمى
 * كـ ProviderError ليُصنَّف لاحقًا في classifyProviderError.
 */
import type { MediaType } from "../models";

export type ProviderId = "kie" | "cometapi";

/** خطأ موحد من المزود — status: رقم HTTP أو 0 لأخطاء الشبكة/المهلة */
export class ProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ImageInput {
  kind: "image";
  prompt: string;
  aspect_ratio: string;
  resolution: string;
  background: string;
  output_format: string;
}

export interface VideoInput {
  kind: "video";
  prompt: string;
  image_url?: string;
  aspect_ratio: string;
  resolution: string;
  enable_audio: boolean;
  duration: number;
}

export type ProviderInput = ImageInput | VideoInput;

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (الفيديو وصور بعض المزودين): تعيد providerTaskId */
  createTask(key: string, providerModel: string, input: ProviderInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (تعيد الروابط فورًا) — نمرر providerModel لأن نقطة الصور تحتاجه */
  createImageSync?(key: string, providerModel: string, input: ImageInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}

export function inputTypeOf(input: ProviderInput): MediaType {
  return input.kind === "image" ? "image" : "video";
}

/** مهلة افتراضية لنداءات المزودين (30 ثانية تكفي لإنشاء المهام والاستعلام) */
export const PROVIDER_TIMEOUT_MS = 30_000;
