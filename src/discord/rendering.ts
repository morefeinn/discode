let sharpModule: Promise<any> | null = null;

async function loadSharp(): Promise<any> {
    sharpModule ||= import('sharp');

    return sharpModule;
}

export async function renderSvgToPng(svg: string): Promise<Buffer> {
    const sharp = (await loadSharp()).default;

    return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function renderSvgToRaw(svg: string, width: number, height: number): Promise<Buffer> {
    const sharp = (await loadSharp()).default;

    return sharp(Buffer.from(svg)).raw().ensureAlpha().resize(width, height).toBuffer();
}
