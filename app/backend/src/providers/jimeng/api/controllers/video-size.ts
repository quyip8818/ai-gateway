const aspectRatios = [[16, 9], [9, 16], [1, 1], [4, 3], [3, 4], [21, 9]];

export function videoSize(width: number, height: number, shortEdge: number): string {
    const scale = shortEdge / Math.min(width, height);
    const evenPixels = (dimension: number) => 2 * Math.round(dimension * scale / 2);
    return `${evenPixels(width)}x${evenPixels(height)}`;
}

export function videoSizeSpec(size: string) {
    const match = /^([1-9]\d{0,3})x([1-9]\d{0,3})$/.exec(size);
    if (!match) return undefined;
    const shortEdge = Math.min(Number(match[1]), Number(match[2]));
    if (shortEdge % 2 !== 0) return undefined;
    const aspect = aspectRatios.find(([width, height]) => videoSize(width, height, shortEdge) === size);
    if (aspect) return { ratio: aspect.join(':'), resolution: shortEdge === 2160 ? '4k' : `${shortEdge}p` };
}
