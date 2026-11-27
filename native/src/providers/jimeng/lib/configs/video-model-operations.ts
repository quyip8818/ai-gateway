import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { VIDEO_RECAST_MODELS } from './video-recast-models.ts';

type VideoOperation = 'generate' | 'recast' | 'upscale';

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadVideoModelOperations(file?: string) {
    const models = new Map<string, VideoOperation>([
        ['dreamina_wan_30_recast', 'recast'],
        ['video_upscale_paz', 'upscale'],
    ]);
    for (const [id, profile] of VIDEO_RECAST_MODELS) {
        models.set(id, 'recast');
        models.set(profile.upstreamModel, 'recast');
    }
    if (!file) return models;

    const document: unknown = parse(readFileSync(file, 'utf8'));
    if (!isObject(document) || document.version !== 1 || !isObject(document.models)) {
        throw new Error('视频模型操作配置需要 version: 1 和 models 对象');
    }
    for (const [id, rule] of Object.entries(document.models)) {
        if (!id || id.trim() !== id || !isObject(rule) || Object.keys(rule).length !== 1) {
            throw new Error(`无效的视频模型操作配置: ${id}`);
        }
        const { operation } = rule;
        if (operation !== 'generate' && operation !== 'recast' && operation !== 'upscale') {
            throw new Error(`视频模型操作无效: ${id}`);
        }
        const existing = models.get(id);
        if (existing && existing !== operation) {
            throw new Error(`不能覆盖已确认的视频模型操作: ${id}`);
        }
        models.set(id, operation);
    }
    return models;
}

const byIdentifier = loadVideoModelOperations(process.env.JIMENG_VIDEO_MODEL_OPERATIONS_FILE);

export function getVideoModelOperation(identifier: string): VideoOperation {
    return byIdentifier.get(identifier) ?? 'generate';
}
