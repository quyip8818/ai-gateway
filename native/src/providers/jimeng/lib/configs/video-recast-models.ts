export interface VideoRecastModel {
    upstreamModel: string;
    configScene: string;
    mode: string;
    resolution: string;
    sourceDurationMs: number;
    commerceAmount: number;
    generateType: number;
}

export const DEFAULT_VIDEO_RECAST_MODEL = 'jimeng-video-dreamina-seedance-45-pro-recast';

export const VIDEO_RECAST_MODELS = new Map<string, VideoRecastModel>([
    [DEFAULT_VIDEO_RECAST_MODEL, {
        upstreamModel: 'dreamina_seedance_45_pro_recast',
        configScene: 'marketing_viral_recreate',
        mode: 'object_swap',
        resolution: '480p',
        sourceDurationMs: 5000,
        commerceAmount: 10,
        generateType: 110,
    }],
]);
