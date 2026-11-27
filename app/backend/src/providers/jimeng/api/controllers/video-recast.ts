import { randomUUID } from 'node:crypto';

import EX from '@/api/consts/exceptions.ts';
import { type VideoRecastModel } from '@/lib/configs/video-recast-models.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import { request } from './core.ts';
import { createScenarioVideoDraft, readScenarioVideoDraft } from './video-scenario.ts';
import { findVideoHistoryRecord } from "./video-history.ts";
import { videoSize } from './video-size.ts';

function invalidSource(preset: VideoRecastModel) {
    return new APIException(EX.API_REQUEST_PARAMS_INVALID,
        `需要同一个即梦账号下该模型已完成的复刻任务，源视频时长为 ${preset.sourceDurationMs / 1000} 秒且包含参考图`);
}

function readSource(record: Record<string, unknown> | undefined, preset: VideoRecastModel) {
    const workspaceId = record?.workspace_id;
    if (!record || Number(record.status) !== 50 || typeof workspaceId !== 'number' || !Number.isSafeInteger(workspaceId)) {
        throw invalidSource(preset);
    }

    const scenario = readScenarioVideoDraft(record.draft_content);
    if (scenario?.scene !== preset.mode || scenario.params?.model_req_key !== preset.upstreamModel
        || !Array.isArray(scenario.material_list)) throw invalidSource(preset);

    const videos = scenario.material_list.filter(item => item?.material_type === 'video');
    const images = scenario.material_list.filter(item => item?.material_type === 'image');
    const video = videos[0]?.video_info;
    if (videos.length !== 1 || video?.source_from !== 'upload'
        || typeof video.vid !== 'string' || !video.vid || video.duration !== preset.sourceDurationMs
        || !Number.isInteger(video.width) || !Number.isInteger(video.height)
        || video.width <= 0 || video.height <= 0
        || images.length < 1 || images.length > 30
        || scenario.material_list.length !== images.length + 1
        || images.some(item => item.image_info?.source_from !== 'upload'
            || typeof item.image_info.image_uri !== 'string' || !item.image_info.image_uri)) {
        throw invalidSource(preset);
    }

    return {
        workspaceId,
        video,
        images: images.map(item => item.image_info),
    };
}

export async function prepareVideoRecast(token: string, sourceId: string, prompt: string, preset: VideoRecastModel) {
    const history = await request("post", "/mweb/v1/get_history_by_ids", token, { data: { submit_ids: [sourceId] } }, { retry: false, logPayload: false });
    const record = findVideoHistoryRecord(history, sourceId);
    const source = readSource(record, preset);

    const config = await request('post', '/mweb/v1/video_generate/get_common_config', token,
        { data: { scene: preset.configScene } }, { logPayload: false });
    const models = config?.model_list;
    const model = Array.isArray(models) ? models.find(entry => entry?.model_req_key === preset.upstreamModel) : undefined;
    const prices = model?.commercial_config?.resolution_price_configs;
    const price = Array.isArray(prices) ? prices.find(entry =>
        typeof entry?.resolution === 'string' && entry.resolution.toLowerCase() === preset.resolution)?.price : undefined;
    if (!price || typeof price.benefit_type !== 'string' || !price.benefit_type
        || typeof price.resource_id !== 'string' || !price.resource_id) {
        throw new APIException(EX.API_REQUEST_FAILED, `即梦账号未返回 ${preset.upstreamModel} 的 ${preset.resolution} 复刻定价`);
    }

    const imageMaterials = source.images.map(image => ({
        type: '',
        id: randomUUID(),
        material_type: 'image',
        image_info: {
            type: 'image', id: randomUUID(), source_from: 'upload', platform_type: 1, name: '',
            image_uri: image.image_uri, uri: image.image_uri, width: image.width, height: image.height,
            format: image.format ?? '', title: image.title ?? '',
        },
    }));
    const video = source.video;
    const materials = [{
        type: '',
        id: randomUUID(),
        material_type: 'video',
        video_info: {
            type: 'video', id: randomUUID(), source_from: 'upload', name: '',
            vid: video.vid, fps: video.fps, width: video.width, height: video.height,
            duration: video.duration, cover_image_url: video.cover_image_url ?? '',
        },
    }, ...imageMaterials];
    const bindings = [
        { slot_id: 'source', role: 'source', material_idxs: [0] },
        { slot_id: 'reference', role: 'reference', material_idxs: imageMaterials.map((_, index) => index + 1) },
    ];
    const draft = createScenarioVideoDraft({
        scene: preset.mode,
        generateType: preset.generateType,
        materials,
        bindings,
        prompt,
        params: {
            duration_ms: video.duration,
            resolution: preset.resolution,
            model_req_key: preset.upstreamModel,
        },
    });
    return {
        size: videoSize(video.width, video.height, parseInt(preset.resolution, 10)),
        model: preset.upstreamModel,
        workspaceId: source.workspaceId,
        commerce: {
            amount: preset.commerceAmount,
            benefit_type: price.benefit_type,
            resource_id: price.resource_id,
            resource_id_type: price.resource_id_type,
            resource_sub_type: price.resource_sub_type,
        },
        metrics: {
            enterFrom: 'share',
            position: 'page_bottom_box',
            genMode: 'recreate',
            toolReportPage: 'recreate',
            toolReportFunctionName: 'video_clone',
            toolReportScene: preset.mode,
        },
        draft,
        hasInputVideo: true,
    };
}
