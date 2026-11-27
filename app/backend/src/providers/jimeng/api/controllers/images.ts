import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { request, uploadFile } from "./core.ts";
import { checkGenerationCredits } from "./generation-credits.ts";
import logger from "@/lib/logger.ts";
import { JimengModelConfig, resolveImageModelConfig } from "./models.ts";
import { IMAGE_DIMENSIONS, closestImageResolution, type ImageSize } from "./image-size.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-image-5.0-lite";
const DRAFT_VERSION = "3.3.20";
const SEEDREAM_55_MODEL_KEY = "high_aes_general_v55";
// The serialized draft has its own version. Jimeng reads the image count
// from `abilities.gen_option` inside the draft.
const DRAFT_CONTENT_VERSION = "3.0.2";
const WEB_VERSION = "7.5.0";
const MIN_VERSION = "3.0.2";

const MODEL_MAP = {
  "jimeng-image-5.0-pro": "high_aes_general_v50p_large",
  "jimeng-image-5.0-lite": "high_aes_general_v50",
  "jimeng-image-4.7": "high_aes_general_v43",
  "jimeng-image-4.6": "high_aes_general_v42",
  "jimeng-image-4.5": "high_aes_general_v40l",
  "jimeng-image-4.1": "high_aes_general_v41",
  "jimeng-image-4.0": "high_aes_general_v40",
  "jimeng-image-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-image-3.0": "high_aes_general_v30l:general_v3.0_18b",
  "jimeng-image-2.0-pro": "high_aes_general_v20_L:general_v2.0_L",
};

function isHighResImageModel(modelName: string, modelConfig?: JimengModelConfig) {
  if (modelConfig) return modelConfig.supportedResolutions.includes("2k");
  return [
    "jimeng-image-5.0-lite",
    "jimeng-image-4.7",
    "jimeng-image-4.6",
    "jimeng-image-4.5",
    "jimeng-image-4.1",
    "jimeng-image-4.0",
  ].includes(modelName);
}

function getImageResolutionLevels(modelName: string) {
  if (modelName === "jimeng-image-2.0-pro") return ["1k"];
  if (modelName === "jimeng-image-5.0-pro") return ["4k", "2k", "1.5k"];
  if (isHighResImageModel(modelName)) return ["4k", "2k"];
  return ["1k"];
}

function getImageResolutionFallbacks(
  modelName: string,
  requestedResolution?: string,
  modelConfig?: JimengModelConfig
) {
  const defaultResolution =
    modelConfig?.defaultResolution || (isHighResImageModel(modelName) ? "2k" : "1k");
  const supportedResolutions =
    modelConfig?.supportedResolutions?.length
      ? modelConfig.supportedResolutions
      : getImageResolutionLevels(modelName);
  const startResolution = supportedResolutions.includes(requestedResolution || "")
    ? requestedResolution
    : defaultResolution;
  const startIndex = Math.max(
    0,
    supportedResolutions.indexOf(startResolution || defaultResolution)
  );
  return supportedResolutions.slice(startIndex);
}

// 即梦支持的图片比例映射
// image_ratio 值: 0=21:9, 1=16:9, 2=3:2, 3=4:3, 8=1:1, 4=3:4, 5=2:3, 6=9:16
const ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "1:1",
  "3:4",
  "2:3",
  "9:16",
];

// 比例对应的 image_ratio 值
const RATIO_VALUES: Record<string, number> = {
  "21:9": 0,
  "16:9": 1,
  "3:2": 2,
  "4:3": 3,
  "1:1": 8,
  "3:4": 4,
  "2:3": 5,
  "9:16": 6,
};

/**
 * 从提示词中检测图片比例
 * 支持格式: 16:9, 16：9, 比例16:9, 横屏, 竖屏 等
 * 返回比例字符串，如 "16:9"
 */
function detectAspectRatioKey(prompt: string): string | null {
  // 正则匹配比例格式 (支持中英文冒号)
  const ratioRegex = /(\d+)\s*[:：]\s*(\d+)/g;
  const matches = [...prompt.matchAll(ratioRegex)];

  for (const match of matches) {
    const key = `${match[1]}:${match[2]}`;
    if (ASPECT_RATIOS.includes(key)) {
      logger.info(`📐 [比例检测] 从提示词检测到比例: ${key}`);
      return key;
    }
  }

  // 支持中文关键词
  if (/横屏|横版|宽屏/.test(prompt)) {
    logger.info(`📐 [比例检测] 检测到横屏关键词 → 16:9`);
    return "16:9";
  }
  if (/竖屏|竖版|手机/.test(prompt)) {
    logger.info(`📐 [比例检测] 检测到竖屏关键词 → 9:16`);
    return "9:16";
  }
  if (/方形|正方/.test(prompt)) {
    logger.info(`📐 [比例检测] 检测到方形关键词 → 1:1`);
    return "1:1";
  }

  return null;
}

export function getModel(model: string) {
  return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
}

interface ImageGenerationOptions {
  ratio?: string;
  resolution?: string;
  size?: ImageSize;
  sampleStrength?: number;
  negativePrompt?: string;
  filePath?: string;
  filePaths?: string[];
  n?: number;
}

export async function generateImages(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "2k",
    size,
    sampleStrength = 0.5,
    negativePrompt = "",
    filePath,
    filePaths = [],
    n = 1,
  }: ImageGenerationOptions,
  refreshToken: string
) {
  const referenceImagePaths = [filePath, ...filePaths].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  const hasReferenceImages = referenceImagePaths.length > 0;
  const uploadIDs: string[] = [];

  // 如果有参考图，逐张上传并保留顺序，供上游的多图参考字段使用。
  if (hasReferenceImages) {
    logger.info(`🖼️ [参考图] 检测到 ${referenceImagePaths.length} 张参考图 → 混合模式`);
    for (const [index, referenceImagePath] of referenceImagePaths.entries()) {
      const fileDesc = referenceImagePath.startsWith("data:")
        ? `base64图片(${referenceImagePath.length}字符)`
        : referenceImagePath.substring(0, 80);
      try {
        const uploadResult = await uploadFile(refreshToken, referenceImagePath);
        uploadIDs.push(uploadResult.image_uri);
        logger.info(`✅ [参考图] 第 ${index + 1} 张上传成功: ${fileDesc}`);
      } catch (error) {
        logger.error(`❌ [参考图] 第 ${index + 1} 张上传失败: ${error.message}`);
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `第 ${index + 1} 张参考图上传失败: ${error.message}`
        );
      }
    }
  }

  // 使用用户选择的模型（混合模式不再强制3.0）
  const modelName = _model;
  const modelConfig = await resolveImageModelConfig(modelName, refreshToken);
  const model = modelConfig.modelReqKey || getModel(modelName);

  // 解析分辨率和比例
  let resolutionType = resolution.toLowerCase(); // 用户指定优先

  if (!modelConfig.supportedResolutions.includes(resolutionType)) {
    resolutionType = modelConfig.defaultResolution;
    if (resolution !== resolutionType) {
      logger.warn(`⚠️ [分辨率] ${modelName} 不支持 ${resolution}，已自动调整为 ${resolutionType}`);
    }
  }

  const dimensionMap = IMAGE_DIMENSIONS[resolutionType] ?? IMAGE_DIMENSIONS['1k'];
  const detectedRatio = detectAspectRatioKey(prompt);
  const requestedRatio = Object.hasOwn(RATIO_VALUES, ratio) ? ratio : '1:1';
  const validRatio = size?.ratio || (requestedRatio === '1:1' ? detectedRatio || requestedRatio : requestedRatio);

  const imageRatio = RATIO_VALUES[validRatio];
  const dimensions = dimensionMap[validRatio];
  const finalWidth = dimensions.width;
  const finalHeight = dimensions.height;

  logger.info(`\n🎨 ════════════════════ 图像生成任务 ════════════════════`);
  logger.info(`   📦 模型: ${modelName}`);
  logger.info(`   🔗 映射: ${model}`);
  logger.info(`   📏 尺寸: ${finalWidth}x${finalHeight} (${validRatio})`);
  logger.info(`   🔍 分辨率: ${resolutionType.toUpperCase()} | 精细度: ${sampleStrength}`);
  logger.info(`   🎯 模式: ${hasReferenceImages ? `混合(${uploadIDs.length} 张参考图)` : "文生图"}`);
  logger.info(`   🖼️ 请求张数: ${n}`);
  logger.info(`═══════════════════════════════════════════════════════════\n`);

  await checkGenerationCredits(refreshToken);

  const componentId = util.uuid();

  // 构建 abilities 对象
  let abilities: Record<string, any>;

  if (uploadIDs.length > 0) {
    // 混合模式 abilities
    abilities = {
      type: "",
      id: util.uuid(),
      blend: {
        type: "",
        id: util.uuid(),
        min_features: [],
        core_param: {
          type: "",
          id: util.uuid(),
          model,
          prompt: prompt + "##",
          sample_strength: sampleStrength,
          image_ratio: imageRatio,
          large_image_info: {
            type: "",
            id: util.uuid(),
            height: finalHeight,
            width: finalWidth,
            resolution_type: resolutionType,
          },
        },
        ability_list: [
          {
            type: "",
            id: util.uuid(),
            name: "byte_edit",
            image_uri_list: uploadIDs,
            image_list: uploadIDs.map((uploadID) => ({
                type: "image",
                id: util.uuid(),
                source_from: "upload",
                platform_type: 1,
                name: "",
                image_uri: uploadID,
                width: 0,
                height: 0,
                format: "",
                uri: uploadID,
            })),
            strength: 0.5,
          },
        ],
        history_option: {
          type: "",
          id: util.uuid(),
        },
        prompt_placeholder_info_list: [
          {
            type: "",
            id: util.uuid(),
            ability_index: 0,
          },
        ],
        postedit_param: {
          type: "",
          id: util.uuid(),
          generate_type: 0,
        },
      },
      gen_option: {
        type: "",
        id: util.uuid(),
        gen_count: n,
        generate_all: false,
      },
    };
  } else {
    // 普通生成模式 abilities
    abilities = {
      type: "",
      id: util.uuid(),
      generate: {
        type: "",
        id: util.uuid(),
        core_param: {
          type: "",
          id: util.uuid(),
          model,
          prompt,
          negative_prompt: negativePrompt,
          seed: Math.floor(Math.random() * 100000000) + 2500000000,
          sample_strength: sampleStrength,
          image_ratio: imageRatio,
          large_image_info: {
            type: "",
            id: util.uuid(),
            height: finalHeight,
            width: finalWidth,
            resolution_type: resolutionType,
          },
          generate_type: 0,
        },
        history_option: {
          type: "",
          id: util.uuid(),
        },
      },
      gen_option: {
        type: "",
        id: util.uuid(),
        gen_count: n,
        generate_all: false,
      },
    };
  }

  const submitId = util.uuid();

  // 构建请求数据
  const requestData = {
    extend: {
      root_model: model,
    },
    submit_id: submitId,
    metrics_extra: hasReferenceImages
      ? undefined
      : JSON.stringify({
          promptSource: "custom",
          generateCount: n,
          enterFrom: "click",
          sceneOptions: JSON.stringify([
            {
              type: "image",
              scene: "ImageBasicGenerate",
              modelReqKey: model,
              resolutionType: resolutionType,
              abilityList: [],
              benefitCount: n,
              reportParams: {
                enterSource: "generate",
                vipSource: "generate",
                extraVipFunctionKey: `${model}-${resolutionType}`,
                useVipFunctionDetailsReporterHoc: true,
              },
            },
          ]),
          isBoxSelect: false,
          isCutout: false,
          generateId: submitId,
          isRegenerate: false,
        }),
    draft_content: JSON.stringify({
      type: "draft",
      id: util.uuid(),
      min_version: MIN_VERSION,
      min_features: [],
      is_from_tsn: true,
      version: DRAFT_CONTENT_VERSION,
      main_component_id: componentId,
      component_list: [
        {
          type: "image_base_component",
          id: componentId,
          min_version: MIN_VERSION,
          metadata: {
            type: "",
            id: util.uuid(),
            created_platform: 3,
            created_platform_version: "",
            created_time_in_ms: String(Date.now()),
            created_did: "",
          },
          generate_type: hasReferenceImages ? "blend" : "generate",
          aigc_mode: "workbench",
          gen_type: 1,
          abilities,
        },
      ],
    }),
    http_common_info: {
      aid: Number(DEFAULT_ASSISTANT_ID),
    },
  };

  // 输出完整请求数据用于调试
  logger.info(`📤 [请求数据] ${JSON.stringify(requestData)}`);

  const submission = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        // Match the web client's draft submission query for Seedream 5.5 at 2K.
        ...(model === SEEDREAM_55_MODEL_KEY && resolutionType === "2k"
          ? { da_version: "3.1.3", commerce_with_input_video: "1" }
          : { da_version: DRAFT_VERSION, web_component_open_flag: 1 }),
        web_version: WEB_VERSION,
      },
      data: requestData,
    }
  );
  const historyId = submission?.aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  // 状态码说明：
  // 20 = 初始提交/队列中
  // 42 = 处理中（jimeng-4.5 新状态）
  // 45 = 处理中（jimeng-4.5 中间状态）
  // 50 = 完成/有结果（jimeng-4.5）
  // 21 = 生成成功（旧版本）
  // 30 = 生成失败
  const PROCESSING_STATES = [20, 42, 45];
  const FAIL_STATE = 30;

  let status = 20,
    failCode,
    item_list = [];
  let retryCount = 0;
  const MAX_POLL_RETRIES = 120; // 最多轮询120次

  while (
    PROCESSING_STATES.includes(status) &&
    (!item_list || item_list.length === 0) &&
    retryCount < MAX_POLL_RETRIES
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    retryCount++;
    const result = await request(
      "post",
      "/mweb/v1/get_history_by_ids",
      refreshToken,
      {
        data: {
          history_ids: [historyId],
          image_info: {
            width: 2048,
            height: 2048,
            format: "webp",
            image_scene_list: [
              {
                scene: "smart_crop",
                width: 360,
                height: 360,
                uniq_key: "smart_crop-w:360-h:360",
                format: "webp",
              },
              {
                scene: "smart_crop",
                width: 480,
                height: 480,
                uniq_key: "smart_crop-w:480-h:480",
                format: "webp",
              },
              {
                scene: "smart_crop",
                width: 720,
                height: 720,
                uniq_key: "smart_crop-w:720-h:720",
                format: "webp",
              },
              {
                scene: "smart_crop",
                width: 720,
                height: 480,
                uniq_key: "smart_crop-w:720-h:480",
                format: "webp",
              },
              {
                scene: "smart_crop",
                width: 360,
                height: 240,
                uniq_key: "smart_crop-w:360-h:240",
                format: "webp",
              },
              {
                scene: "smart_crop",
                width: 240,
                height: 320,
                uniq_key: "smart_crop-w:240-h:320",
                format: "webp",
              },
              {
                scene: "smart_crop",
                width: 480,
                height: 640,
                uniq_key: "smart_crop-w:480-h:640",
                format: "webp",
              },
              {
                scene: "normal",
                width: 2400,
                height: 2400,
                uniq_key: "2400",
                format: "webp",
              },
              {
                scene: "normal",
                width: 1080,
                height: 1080,
                uniq_key: "1080",
                format: "webp",
              },
              {
                scene: "normal",
                width: 720,
                height: 720,
                uniq_key: "720",
                format: "webp",
              },
              {
                scene: "normal",
                width: 480,
                height: 480,
                uniq_key: "480",
                format: "webp",
              },
              {
                scene: "normal",
                width: 360,
                height: 360,
                uniq_key: "360",
                format: "webp",
              },
            ],
          },
          http_common_info: {
            aid: Number(DEFAULT_ASSISTANT_ID),
          },
        },
      }
    );
    const record = result?.[historyId];
    if (!record)
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");
    status = record.status;
    failCode = record.fail_code;
    item_list = Array.isArray(record.item_list) ? record.item_list : [];
    // 每5次轮询输出一次状态，避免日志过多
    if (retryCount % 5 === 0 || item_list?.length > 0) {
      logger.info(`⏳ [轮询] 第${retryCount}次 | 状态码: ${status} | 结果数: ${item_list?.length || 0}`);
    }
  }

  if (retryCount >= MAX_POLL_RETRIES) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "图像生成超时");
  }

  if (status === FAIL_STATE) {
    if (failCode === "2038") throw new APIException(EX.API_CONTENT_FILTERED);
    else throw new APIException(EX.API_IMAGE_GENERATION_FAILED);
  }
  if (item_list.length > n) {
    logger.info(`[生成张数] model=${modelName} historyId=${historyId} requested=${n} upstream=${item_list.length} returned=${n}`);
  }
  const urls = item_list.slice(0, n)
    .map((item) => item?.image?.large_images?.[0]?.image_url || item?.common_attr?.cover_url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  return { urls, submitId };
}

/**
 * 带自动降级重试的图像生成
 * 如果积分不足，自动降低分辨率重试
 */
export async function generateImagesWithRetry(
  _model: string,
  prompt: string,
  options: ImageGenerationOptions,
  refreshToken: string
) {
  const modelConfig = await resolveImageModelConfig(_model, refreshToken);
  const count = options.n ?? 1;
  const allowedCounts = modelConfig.supportedGenerateCounts;
  if (allowedCounts?.length && !allowedCounts.includes(count)) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `${modelConfig.id} 不支持 n=${count}，请使用 n=${allowedCounts.join("、")}`
    );
  }
  const resolutionLevels = options.size
    ? [closestImageResolution(options.size.resolution, modelConfig.supportedResolutions, modelConfig.defaultResolution)]
    : getImageResolutionFallbacks(_model, options.resolution, modelConfig);
  let currentResIndex = 0;

  while (currentResIndex < resolutionLevels.length) {
    try {
      const currentOptions = {
        ...options,
        resolution: resolutionLevels[currentResIndex],
      };
      logger.info(`尝试生成图像，分辨率: ${currentOptions.resolution}`);
      return await generateImages(_model, prompt, currentOptions, refreshToken);
    } catch (error) {
      // 检查是否为积分不足错误 (fail_code 2039/1006 或包含积分不足关键词)
      const isInsufficientCredits =
        error.code === EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0] ||
        (error.message &&
          (error.message.includes("积分不足") ||
            error.message.includes("2039") ||
            error.message.includes("1006")));

      if (
        isInsufficientCredits &&
        currentResIndex < resolutionLevels.length - 1
      ) {
        currentResIndex++;
        logger.warn(
          `积分不足，自动降级到 ${resolutionLevels[currentResIndex]} 分辨率重试...`
        );
        continue;
      }

      // 已是最低分辨率仍然失败
      if (isInsufficientCredits) {
        throw new APIException(
          EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
          "积分不足，已自动降至最低画质仍然不足，请前往即梦官网 https://jimeng.jianying.com 充值积分"
        );
      }

      // 其他错误直接抛出
      throw error;
    }
  }

  throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "图像生成失败");
}

export default {
  generateImages,
  generateImagesWithRetry,
};
