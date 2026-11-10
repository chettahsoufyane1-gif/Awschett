/**
 * سجل الموديلات — الموديلان المدمجان ثابتان، مع قبول الصيغ البديلة بالنقاط
 * (مثل gpt-image-2.6/...) وتوحيدها إلى الاسم الكنوني.
 * الأسماء الفعلية المُرسلة لكل مزود قابلة للتجاوز عبر متغيرات البيئة.
 */
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

function buildImageModel(): ModelDef {
  const canonical = "gpt-image-2-6/flare-text-to-image";
  const dotted = canonical.replace(/(\d)-(\d)/g, "$1.$2"); // gpt-image-2.6/flare-text-to-image
  return {
    canonical,
    aliases: [canonical, dotted],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
      // حسب توثيق CometAPI الفعلي: موديلات GPT Image بصيغة gpt-image-X.Y-flare
      cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare",
    },
  };
}

function buildVideoModel(): ModelDef {
  const canonical = "grok-imagine-video-1-5-preview";
  const dotted = canonical.replace(/(\d)-(\d)/g, "$1.$2"); // grok-imagine-video-1.5-preview
  return {
    canonical,
    aliases: [canonical, dotted],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
      // حسب توثيق CometAPI الفعلي لنقطة /grok/v1/videos/generations
      cometapi: process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5",
    },
  };
}

const MODELS: ModelDef[] = [buildImageModel(), buildVideoModel()];

/** يوحّد اسم الموديل المدخل (شرطات/نقاط، حالة الأحرف) ويعيده أو null إن كان مجهولًا */
export function resolveModel(name?: string): ModelDef | null {
  if (!name) return MODELS[0]; // الافتراضي: موديل الصور
  const norm = name.trim().toLowerCase().replace(/(\d)-(\d)/g, "$1.$2");
  for (const m of MODELS) {
    for (const alias of m.aliases) {
      if (alias.toLowerCase() === norm) return m;
    }
  }
  return null;
}

export function getModels(): ModelDef[] {
  return MODELS;
}
