// 1K 分辨率尺寸 (3.x 模型)
const DIMENSIONS_1K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 2016, height: 846 },
  "16:9": { width: 1664, height: 936 },
  "3:2": { width: 1584, height: 1056 },
  "4:3": { width: 1472, height: 1104 },
  "1:1": { width: 1328, height: 1328 },
  "3:4": { width: 1104, height: 1472 },
  "2:3": { width: 1056, height: 1584 },
  "9:16": { width: 936, height: 1664 },
};

// 2K 分辨率尺寸 (4.x 模型)
const DIMENSIONS_2K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 3024, height: 1296 },
  "16:9": { width: 2560, height: 1440 },
  "3:2": { width: 2496, height: 1664 },
  "4:3": { width: 2304, height: 1728 },
  "1:1": { width: 2048, height: 2048 },
  "3:4": { width: 1728, height: 2304 },
  "2:3": { width: 1664, height: 2496 },
  "9:16": { width: 1440, height: 2560 },
};

const DIMENSIONS_1_5K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 2268, height: 972 },
  "16:9": { width: 1920, height: 1080 },
  "3:2": { width: 1872, height: 1248 },
  "4:3": { width: 1728, height: 1296 },
  "1:1": { width: 1536, height: 1536 },
  "3:4": { width: 1296, height: 1728 },
  "2:3": { width: 1248, height: 1872 },
  "9:16": { width: 1080, height: 1920 },
};

const DIMENSIONS_4K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 6197, height: 2656 },
  "16:9": { width: 5404, height: 3040 },
  "3:2": { width: 4992, height: 3328 },
  "4:3": { width: 4693, height: 3520 },
  "1:1": { width: 4096, height: 4096 },
  "3:4": { width: 3520, height: 4693 },
  "2:3": { width: 3328, height: 4992 },
  "9:16": { width: 3040, height: 5404 },
};

export const IMAGE_DIMENSIONS = {
    '1k': DIMENSIONS_1K,
    '1.5k': DIMENSIONS_1_5K,
    '2k': DIMENSIONS_2K,
    '4k': DIMENSIONS_4K,
};

const RESOLUTIONS = Object.keys(IMAGE_DIMENSIONS);

export interface ImageSize {
    ratio: string;
    resolution: string;
}

const openAISizes = new Map<string, ImageSize>([
    ['1024x1024', { ratio: '1:1', resolution: '1k' }],
    ['1536x1024', { ratio: '3:2', resolution: '1.5k' }],
    ['1024x1536', { ratio: '2:3', resolution: '1.5k' }],
]);
for (const [resolution, dimensions] of Object.entries(IMAGE_DIMENSIONS)) {
    for (const [ratio, { width, height }] of Object.entries(dimensions)) {
        openAISizes.set(width + 'x' + height, { ratio, resolution });
    }
}

export function openAIImageSize(size: string) {
    return openAISizes.get(size.trim().toLowerCase());
}

export function closestImageResolution(target: string, supported: string[], fallback: string) {
    const index = RESOLUTIONS.indexOf(target);
    const nearest = RESOLUTIONS.slice(index).find(resolution => supported.includes(resolution))
        ?? RESOLUTIONS.slice(0, index).reverse().find(resolution => supported.includes(resolution));
    return nearest ?? fallback;
}
