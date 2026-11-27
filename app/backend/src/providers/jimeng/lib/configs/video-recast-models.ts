export interface VideoRecastModel {
    id: string;
    upstreamModel: string;
    configScene: string;
    mode: string;
    resolution: string;
    sourceDurationMs: number;
    commerceAmount: number;
    generateType: number;
}

export const videoRecastModel: VideoRecastModel = {
    id: 'seedance-2.5-recast',
    upstreamModel: 'dreamina_seedance_45_pro_recast',
    configScene: 'marketing_viral_recreate',
    mode: 'object_swap',
    resolution: '480p',
    sourceDurationMs: 5000,
    commerceAmount: 10,
    generateType: 110,
};
