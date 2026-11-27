import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { request, uploadFile } from "./core.ts";
import { checkGenerationCredits } from "./generation-credits.ts";
import logger from "@/lib/logger.ts";
import type { JimengModelConfig } from "./models.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-video-seedance-2.0";
const DRAFT_VERSION = "3.3.20";
const WEB_VERSION = "7.5.0";
const DEFAULT_VIDEO_DURATIONS = [5, 10];
function getVideoCommerceInfoFromConfig(modelConfig: JimengModelConfig, resolution: string) {
  const benefitType =
    modelConfig.benefits?.[resolution] ||
    modelConfig.defaultBenefit ||
    "basic_video_operation_vgfm_v_three";
  return {
    benefit_type: benefitType,
    resource_id: "generate_video",
    resource_id_type: "str",
    resource_sub_type: "aigc",
  };
}

export function getSupportedVideoDurations(modelConfig: JimengModelConfig) {
  const configuredDurations = (modelConfig.supportedDurations || []).filter(
    (duration) => Number.isInteger(duration) && duration > 0
  );
  if (configuredDurations.length > 0) {
    return [...new Set(configuredDurations)].sort((a, b) => a - b);
  }
  return modelConfig.supportsLongDuration ? DEFAULT_VIDEO_DURATIONS : [5];
}

export function getDefaultVideoDuration(modelConfig: JimengModelConfig) {
  const supportedDurations = getSupportedVideoDurations(modelConfig);
  if (modelConfig.defaultDuration && supportedDurations.includes(modelConfig.defaultDuration)) {
    return modelConfig.defaultDuration;
  }
  return supportedDurations.includes(10) ? 10 : supportedDurations[0];
}

interface VideoGenerationOptions {
  ratio: string;
  resolution: string;
  duration: number;
  referencePath?: string;
}

export async function submitVideoGeneration(
  modelConfig: JimengModelConfig,
  prompt: string,
  { ratio, resolution, duration, referencePath }: VideoGenerationOptions,
  refreshToken: string,
  submitId: string,
): Promise<string> {
  const { id: modelId, modelReqKey: model } = modelConfig;
  const durationMs = duration * 1000;
  logger.info(`提交视频模型 ${modelId}，分辨率 ${resolution}，画幅 ${ratio}，时长 ${duration} 秒`);

  await checkGenerationCredits(refreshToken);

  let firstFrame;
  if (referencePath) {
    try {
      const { image_uri: uri } = await uploadFile(refreshToken, referencePath);
      if (!uri) throw new Error("即梦未返回参考图 URI");
      firstFrame = {
        format: "",
        height: 0,
        id: util.uuid(),
        image_uri: uri,
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri,
        width: 0,
      };
    } catch (error) {
      logger.error(`参考图上传失败: ${error.message}`);
      throw new APIException(EX.API_REQUEST_FAILED, "参考图上传失败");
    }
  }

  const componentId = util.uuid();
  const metricsExtra = JSON.stringify({
    enterFrom: "click",
    isDefaultSeed: 1,
    promptSource: "custom",
    isRegenerate: false,
    originSubmitId: util.uuid(),
  });
  const videoCommerceInfo = getVideoCommerceInfoFromConfig(modelConfig, resolution);
  logger.info(
    `视频模型配置: source=${modelConfig.source || "static"}, benefit_type=${videoCommerceInfo.benefit_type}, 可用时长=${getSupportedVideoDurations(modelConfig).join(",")}秒`
  );
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        aigc_features: "app_lip_sync",
        web_version: WEB_VERSION,
        da_version: DRAFT_VERSION,
        web_component_open_flag: 1,
      },
      data: {
        extend: {
          root_model: model,
          m_video_commerce_info: videoCommerceInfo,
          m_video_commerce_info_list: [videoCommerceInfo],
        },
        submit_id: submitId,
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: "3.0.5",
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "video_base_component",
              id: componentId,
              min_version: "1.0.0",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now(),
                created_did: "",
              },
              generate_type: "gen_video",
              aigc_mode: "workbench",
              abilities: {
                type: "",
                id: util.uuid(),
                gen_video: {
                  id: util.uuid(),
                  type: "",
                  text_to_video_params: {
                    type: "",
                    id: util.uuid(),
                    model_req_key: model,
                    priority: 0,
                    seed: Math.floor(Math.random() * 100000000) + 2500000000,
                    video_aspect_ratio: ratio,
                    video_gen_inputs: [
                      {
                        duration_ms: durationMs,
                        first_frame_image: firstFrame,
                        fps: 24,
                        id: util.uuid(),
                        min_version: "3.0.5",
                        prompt,
                        resolution,
                        type: "",
                        video_mode: firstFrame ? 0 : 2,
                      },
                    ],
                  },
                  video_task_extra: metricsExtra,
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: Number(DEFAULT_ASSISTANT_ID),
        },
      },
    },
    { retry: false, logPayload: false },
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "记录ID不存在");
  return String(historyId);
}
