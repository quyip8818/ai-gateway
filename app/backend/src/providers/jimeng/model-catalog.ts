import { createHash } from "node:crypto";

export type JimengModelType = "image" | "video";
export const AURA_CROWD_TEST_MODEL_KEY = "dreamina_crowd_test";
export const SEEDREAM_55_MODEL_KEY = "high_aes_general_v55";

export const unsupportedJimengImageModelKeys = [
  'image_upscale_paz',
  'jm_image_model_oa_it',
  'jm_image_model_lib_f',
  'jm_image_model_lib_s',
  'jm_image_model_gg_bp',
  'jm_image_model_gg_bp_21',
  'jm_image_model_yc_mj82',
];

// Public IDs are tied to the upstream request keys, which are independent of display labels.
const dynamicModelIds = {
  image: new Map([
    [SEEDREAM_55_MODEL_KEY, "seedream-5.5"],
    [AURA_CROWD_TEST_MODEL_KEY, "aura"],
    ["jm_image_model_anycook", "anycook-1.0"],
    ["jimeng_smart_image_v1", "imagemax-1.0"],
    ["high_aes_general_v50_ultra", "seedream-5.0-aurora"],
    ["high_aes_general_v50_flash", "seedream-5.0-flash"],
    ["high_aes_general_v50_surge", "seedream-5.0-surge"],
  ]),
  video: new Map([
    ["dreamina_seedance_45_flash", "seedance-2.5-flash"],
    ["dreamina_happyhorse_v1_0", "happyhorse-1.0"],
    ["dreamina_vidu_q3", "vidu-q3"],
    ["dreamina_seedance_45_pro_draft", "seedance-2.5-draft"],
    ["dreamina_wan_30_prime", "wan-3.0-prime"],
    ["dreamina_vidu_q2", "vidu-q2"],
    ["dreamina_wan_30", "wan-3.0"],
    ["dreamina_happyhorse_v1_1", "happyhorse-1.1"],
    ["dreamina_yling_video_4", "yingling-4.0"],
  ]),
};

export function modelId(type: JimengModelType, modelReqKey: string) {
  const knownId = dynamicModelIds[type].get(modelReqKey);
  if (knownId) return knownId;

  // Some catalog entries have no unique public name.
  const suffix = createHash("sha256").update(modelReqKey).digest("hex").slice(0, 16);
  return `${type}-${suffix}`;
}

function catalogText(candidate: Record<string, unknown>, fields: string[], modelReqKey: string) {
  for (const field of fields) {
    const value = candidate[field];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text && text !== modelReqKey) return text;
  }
}

export function catalogPresentation(candidate: Record<string, unknown>, modelReqKey: string) {
  return {
    name: catalogText(candidate, ["display_name", "displayName", "model_name", "modelName", "name"], modelReqKey),
    description: catalogText(candidate, ["model_tip", "modelTip", "description"], modelReqKey),
  };
}
