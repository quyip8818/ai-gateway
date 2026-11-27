import { createHash } from "node:crypto";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { getVideoModelOperation } from "@/lib/configs/video-model-operations.ts";
import { request } from "./core.ts";

export type JimengModelType = "image" | "video";

export interface JimengModelConfig {
  id: string;
  type: JimengModelType;
  modelReqKey: string;
  defaultResolution: string;
  supportedResolutions: string[];
  supportedGenerateCounts?: number[];
  benefits?: Record<string, string>;
  defaultBenefit?: string;
  benefitCountByResolution?: Record<string, number>;
  supportsLongDuration?: boolean;
  defaultDuration?: number;
  supportedDurations?: number[];
  source?: "static" | "dynamic";
}

const DRAFT_VERSION = "3.3.20";
const WEB_VERSION = "7.5.0";
const MODEL_CACHE_TTL_MS = Number(process.env.JIMENG_MODEL_CACHE_TTL_MS || 5 * 60 * 1000);
const SEEDANCE_2_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const IMAGE_UPSCALE_MODEL_KEY = "image_upscale_paz";
const AURA_CROWD_TEST_MODEL_KEY = "dreamina_crowd_test";
export const SEEDREAM_55_MODEL_KEY = "high_aes_general_v55";

const STATIC_IMAGE_MODELS: JimengModelConfig[] = [
  {
    id: "seedream-5.0-pro",
    type: "image",
    modelReqKey: "high_aes_general_v50p_large",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k", "1.5k"],
    benefitCountByResolution: { "2k": 8 },
    source: "static",
  },
  {
    id: "seedream-5.0-lite",
    type: "image",
    modelReqKey: "high_aes_general_v50",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 3, "4k": 1 },
    source: "static",
  },
  {
    id: "seedream-4.7",
    type: "image",
    modelReqKey: "high_aes_general_v43",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "seedream-4.6",
    type: "image",
    modelReqKey: "high_aes_general_v42",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "seedream-4.5",
    type: "image",
    modelReqKey: "high_aes_general_v40l",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "seedream-4.1",
    type: "image",
    modelReqKey: "high_aes_general_v41",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "seedream-4.0",
    type: "image",
    modelReqKey: "high_aes_general_v40",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "seedream-3.1",
    type: "image",
    modelReqKey: "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
    defaultResolution: "1k",
    supportedResolutions: ["1k"],
    benefitCountByResolution: { "1k": 1 },
    source: "static",
  },
  {
    id: "seedream-3.0",
    type: "image",
    modelReqKey: "high_aes_general_v30l:general_v3.0_18b",
    defaultResolution: "1k",
    supportedResolutions: ["1k"],
    benefitCountByResolution: { "1k": 1 },
    source: "static",
  },
  {
    id: "seedream-2.0-pro",
    type: "image",
    modelReqKey: "high_aes_general_v20_L:general_v2.0_L",
    defaultResolution: "1k",
    supportedResolutions: ["1k"],
    benefitCountByResolution: { "1k": 1 },
    source: "static",
  },
];

const STATIC_VIDEO_MODELS: JimengModelConfig[] = [
  {
    id: "seedance-2.5",
    type: "video",
    modelReqKey: "dreamina_seedance_45_pro",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "seedance-2.0-mini",
    type: "video",
    modelReqKey: "dreamina_seedance_40_mini",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "seedance_20_mini_720p_output" },
    defaultBenefit: "seedance_20_mini_720p_output",
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
    source: "static",
  },
  {
    id: "seedance-2.0-fast",
    type: "video",
    modelReqKey: "dreamina_seedance_40",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "dreamina_seedance_20_fast" },
    defaultBenefit: "dreamina_seedance_20_fast",
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
    source: "static",
  },
  {
    id: "seedance-2.0",
    type: "video",
    modelReqKey: "dreamina_seedance_40_pro",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "dreamina_video_seedance_20_pro" },
    defaultBenefit: "dreamina_video_seedance_20_pro",
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
    source: "static",
  },
  {
    id: "seedance-2.0-fast-vip",
    type: "video",
    modelReqKey: "dreamina_seedance_40_vision",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "seedance_20_fast_720p_output" },
    defaultBenefit: "seedance_20_fast_720p_output",
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
    source: "static",
  },
  {
    id: "seedance-2.0-vip",
    type: "video",
    modelReqKey: "dreamina_seedance_40_pro_vision",
    defaultResolution: "720p",
    supportedResolutions: ["720p", "1080p", "4k"],
    benefits: {
      "720p": "seedance_20_pro_720p_output",
      "1080p": "seedance_20_pro_1080p_output",
      "4k": "seedance_20_pro_4k_output",
    },
    defaultBenefit: "seedance_20_pro_720p_output",
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
    source: "static",
  },
  {
    id: "seedance-1.5-pro",
    type: "video",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.5_pro",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "dreamina_video_seedance_15_pro" },
    defaultBenefit: "dreamina_video_seedance_15_pro",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "video-3.0-pro",
    type: "video",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.0_pro",
    defaultResolution: "1080p",
    supportedResolutions: ["1080p"],
    benefits: { "1080p": "basic_video_operation_vgfm_v_three_pro" },
    defaultBenefit: "basic_video_operation_vgfm_v_three_pro",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "video-3.0",
    type: "video",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.0",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "basic_video_operation_vgfm_v_three" },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "video-3.0-fast",
    type: "video",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.0_fast",
    defaultResolution: "720p",
    supportedResolutions: ["720p", "1080p"],
    benefits: {
      "720p": "basic_video_operation_vgfm_v_three",
      "1080p": "basic_video_operation_vgfm_v_three_1080",
    },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "video-s2.0",
    type: "video",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_lite",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "basic_video_operation_vgfm_v_three" },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: false,
    source: "static",
  },
  {
    id: "video-2.0-pro",
    type: "video",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm1.0",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "basic_video_operation_vgfm_v_three" },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: false,
    source: "static",
  },
];

const dynamicCache = new Map<
  string,
  {
    expiresAt: number;
    models: JimengModelConfig[];
  }
>();

function cloneModelConfig(model: JimengModelConfig): JimengModelConfig {
  return {
    ...model,
    supportedResolutions: [...model.supportedResolutions],
    supportedGenerateCounts: model.supportedGenerateCounts
      ? [...model.supportedGenerateCounts]
      : undefined,
    benefits: model.benefits ? { ...model.benefits } : undefined,
    benefitCountByResolution: model.benefitCountByResolution
      ? { ...model.benefitCountByResolution }
      : undefined,
  };
}

export const preferredImageModels = ["seedream-5.0-lite", "seedream-5.5"];
export const preferredVideoModels = ["seedance-2.0"];

const staticModels = [...STATIC_IMAGE_MODELS, ...STATIC_VIDEO_MODELS];

function modelId(type: JimengModelType, modelReqKey: string) {
  if (type === "image" && modelReqKey === SEEDREAM_55_MODEL_KEY) return "seedream-5.5";
  if (type === "image" && modelReqKey === AURA_CROWD_TEST_MODEL_KEY) return "aura";

  // Some catalog entries have no unique public name.
  const suffix = createHash("sha256").update(modelReqKey).digest("hex").slice(0, 16);
  return `${type}-${suffix}`;
}

function findObjectsWithModelReqKey(value: any, out: any[] = [], seen = new Set<any>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);

  if (typeof value.model_req_key === "string" || typeof value.modelReqKey === "string") {
    out.push(value);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => findObjectsWithModelReqKey(item, out, seen));
  } else {
    Object.values(value).forEach((item) => findObjectsWithModelReqKey(item, out, seen));
  }
  return out;
}

function collectResolutionStrings(value: any, out: string[] = [], seen = new Set<any>()) {
  if (!value) return out;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (/^(480p|720p|1080p|1k|1\.5k|2k|4k)$/.test(normalized) && !out.includes(normalized)) {
      out.push(normalized);
    }
    return out;
  }
  if (typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectResolutionStrings(item, out, seen));
  } else {
    Object.values(value).forEach((item) => collectResolutionStrings(item, out, seen));
  }
  return out;
}

function collectPreferredResolutions(value: any, path: string[] = [], out: string[] = []) {
  if (!value || typeof value !== "object") return out;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key.toLowerCase()];
    const pathText = nextPath.join(".");
    const isResolutionField = /resolution|definition|quality/.test(key.toLowerCase());
    const isPriceOnlyField = /price|benefit|commerce|cost/.test(pathText);

    if (isResolutionField && !isPriceOnlyField) {
      collectResolutionStrings(child, out);
      if (child && typeof child === "object" && !Array.isArray(child)) {
        collectResolutionStrings(Object.keys(child), out);
      }
    }

    if (child && typeof child === "object") {
      collectPreferredResolutions(child, nextPath, out);
    }
  }

  return [...new Set(out)];
}

function sortImageResolutions(resolutions: string[]) {
  const priority = ["4k", "2k", "1.5k", "1k"];
  return priority.filter((resolution) => resolutions.includes(resolution));
}

function sortVideoResolutions(resolutions: string[]) {
  const priority = ["4k", "1080p", "720p", "480p"];
  return priority.filter((resolution) => resolutions.includes(resolution));
}

function inferImageResolutions(modelReqKey: string, staticConfig?: JimengModelConfig) {
  if (staticConfig) return staticConfig.supportedResolutions;
  if (/v5|v4|general_v4|general_v5/.test(modelReqKey)) return ["4k", "2k"];
  return ["1k"];
}

function inferVideoResolutions(staticConfig?: JimengModelConfig, candidate?: any) {
  const preferred = collectPreferredResolutions(candidate);
  const sorted = sortVideoResolutions(preferred);
  if (sorted.length > 0) return sorted;
  if (staticConfig) return staticConfig.supportedResolutions;
  return ["720p"];
}

function collectBenefitTypes(value: any, out: string[] = [], seen = new Set<any>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);

  if (typeof value.benefit_type === "string" && !out.includes(value.benefit_type)) {
    out.push(value.benefit_type);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectBenefitTypes(item, out, seen));
  } else {
    Object.values(value).forEach((item) => collectBenefitTypes(item, out, seen));
  }
  return out;
}

function collectVideoBenefits(candidate: any, resolutions: string[], staticConfig?: JimengModelConfig) {
  const benefits: Record<string, string> = { ...staticConfig?.benefits };
  const benefitTypes = collectBenefitTypes(candidate);

  for (const benefitType of benefitTypes) {
    for (const resolution of resolutions) {
      if (benefitType.toLowerCase().includes(resolution.toLowerCase())) {
        benefits[resolution] = benefitType;
      }
    }
  }

  if (Object.keys(benefits).length === 0 && benefitTypes[0]) {
    benefits[resolutions[0] || "720p"] = benefitTypes[0];
  }

  return benefits;
}

function parseImageModel(candidate: any): JimengModelConfig | null {
  const modelReqKey = candidate.model_req_key || candidate.modelReqKey;
  if (typeof modelReqKey !== "string" || !modelReqKey.trim()) return null;
  if (modelReqKey === IMAGE_UPSCALE_MODEL_KEY) return null;

  const staticConfig = STATIC_IMAGE_MODELS.find((model) => model.modelReqKey === modelReqKey);
  const preferredResolutions = sortImageResolutions(collectPreferredResolutions(candidate));
  const supportedResolutions =
    preferredResolutions.length > 0
      ? preferredResolutions
      : inferImageResolutions(modelReqKey, staticConfig);
  const countOptions = candidate.generate_count_options ?? candidate.generateCountOptions;
  const supportedGenerateCounts = Array.isArray(countOptions)
    ? [...new Set(countOptions.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 8))]
        .sort((a, b) => a - b)
    : [];

  return {
    ...staticConfig,
    id: staticConfig?.id ?? modelId("image", modelReqKey),
    type: "image",
    modelReqKey,
    defaultResolution:
      staticConfig && supportedResolutions.includes(staticConfig.defaultResolution)
        ? staticConfig.defaultResolution
        : supportedResolutions.includes("2k") ? "2k" : supportedResolutions[0],
    supportedResolutions,
    // Aura enforces the catalog options on submit. Other models, such as V8.2,
    // can accept counts beyond the choices shown in the web UI.
    supportedGenerateCounts: modelReqKey === AURA_CROWD_TEST_MODEL_KEY
      ? (supportedGenerateCounts.length ? supportedGenerateCounts : [2])
      : undefined,
    source: "dynamic",
  };
}

function parseVideoModel(candidate: any): JimengModelConfig | null {
  const modelReqKey = candidate.model_req_key || candidate.modelReqKey;
  if (typeof modelReqKey !== "string" || !modelReqKey.trim()) return null;

  const staticConfig = STATIC_VIDEO_MODELS.find((model) => model.modelReqKey === modelReqKey);
  const id = staticConfig?.id ?? modelId("video", modelReqKey);
  if (getVideoModelOperation(modelReqKey) !== "generate" ||
      getVideoModelOperation(id) !== "generate") return null;
  const supportedResolutions = inferVideoResolutions(staticConfig, candidate);
  const benefits = collectVideoBenefits(candidate, supportedResolutions, staticConfig);

  return {
    ...staticConfig,
    id,
    type: "video",
    modelReqKey,
    defaultResolution:
      staticConfig && supportedResolutions.includes(staticConfig.defaultResolution)
        ? staticConfig.defaultResolution
        : supportedResolutions.includes("720p") ? "720p" : supportedResolutions[0],
    supportedResolutions,
    benefits,
    defaultBenefit:
      benefits[supportedResolutions[0]] ||
      Object.values(benefits)[0] ||
      staticConfig?.defaultBenefit ||
      "basic_video_operation_vgfm_v_three",
    supportsLongDuration: staticConfig?.supportsLongDuration ?? true,
    source: "dynamic",
  };
}

function uniqueModels(models: JimengModelConfig[]) {
  const byKey = new Map<string, JimengModelConfig>();
  for (const model of models) {
    const key = `${model.type}:${model.modelReqKey}`;
    if (!byKey.has(key)) byKey.set(key, model);
  }
  return [...byKey.values()];
}

async function fetchImageModelConfigs(refreshToken: string, refresh = false) {
  const result = await request("post", "/mweb/v1/get_common_config", refreshToken, {
    params: {
      web_version: WEB_VERSION,
      da_version: DRAFT_VERSION,
      aigc_features: "app_lip_sync",
      needCache: !refresh,
      needRefresh: refresh,
    },
    data: {
      is_client_filter: false,
      need_beta_model: true,
    },
  });

  // The same endpoint also describes post-edit tools outside the generation list.
  const modelList = result?.model_list ?? result?.modelList;
  const candidates = Array.isArray(modelList) ? modelList : findObjectsWithModelReqKey(result);
  return uniqueModels(
    candidates
      .map(parseImageModel)
      .filter(Boolean) as JimengModelConfig[]
  );
}

async function fetchVideoModelConfigs(refreshToken: string, refresh = false) {
  const result = await request("post", "/mweb/v1/video_generate/get_common_config", refreshToken, {
    params: {
      web_version: WEB_VERSION,
      da_version: DRAFT_VERSION,
      aigc_features: "app_lip_sync",
      needRefresh: refresh,
    },
    data: {
      scene: "generate_video",
      params: {
        needCache: !refresh,
        needRefresh: refresh,
      },
    },
  });

  const modelList = result?.model_list ?? result?.modelList;
  return uniqueModels(
    (Array.isArray(modelList) ? modelList : [])
      .map(parseVideoModel)
      .filter(Boolean) as JimengModelConfig[]
  );
}

async function fetchDynamicModelConfigs(refreshToken: string, refresh = false) {
  const now = Date.now();
  const cacheKey = util.md5(refreshToken).slice(0, 12);
  const cached = dynamicCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > now) {
    return cached.models;
  }

  const results = await Promise.allSettled([
    fetchImageModelConfigs(refreshToken, refresh),
    fetchVideoModelConfigs(refreshToken, refresh),
  ]);
  const models = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn(
        `Failed to fetch ${index === 0 ? "image" : "video"} model config: ${result.reason?.message || result.reason}`
      );
    }
  });

  if (models.length === 0) {
    if (cached) return cached.models;
    throw new Error("No dynamic Jimeng model config returned");
  }

  dynamicCache.set(cacheKey, {
    expiresAt: now + MODEL_CACHE_TTL_MS,
    models,
  });
  return models;
}

export async function listModelConfigs(refreshToken: string, refresh = false) {
  let dynamicModels: JimengModelConfig[] = [];
  try {
    dynamicModels = await fetchDynamicModelConfigs(refreshToken, refresh);
  } catch (error) {
    logger.warn(`Using static Jimeng model config: ${error.message}`);
  }

  const dynamicTypes = new Set(dynamicModels.map((model) => model.type));
  const fallback = staticModels.filter((model) =>
    !dynamicTypes.has(model.type) &&
    (model.type !== "video" ||
      (getVideoModelOperation(model.id) === "generate" &&
        getVideoModelOperation(model.modelReqKey) === "generate"))
  );
  return [...dynamicModels, ...fallback].map(cloneModelConfig);
}

async function resolveModelConfig(modelReqKey: string, type: JimengModelType, refreshToken: string) {
  const models = await listModelConfigs(refreshToken);
  const model = models.find((candidate) => candidate.type === type && candidate.modelReqKey === modelReqKey);
  if (!model) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "当前账号不支持所选模型");
  }
  return model;
}

export const resolveImageModelConfig = (modelReqKey: string, refreshToken: string) =>
  resolveModelConfig(modelReqKey, "image", refreshToken);

export const resolveVideoModelConfig = (modelReqKey: string, refreshToken: string) =>
  resolveModelConfig(modelReqKey, "video", refreshToken);
