// AMLL imports Pixi for its PixiRenderer background, which am-hook does not use.
// These placeholders satisfy the imports so Pixi is not bundled.
class Unused { constructor() { throw new Error('PixiRenderer is not bundled in am-hook'); } }
export const Application = Unused, Texture = Unused, Container = Unused, Sprite = Unused;
export const BlurFilter = Unused, BulgePinchFilter = Unused, ColorMatrixFilter = Unused;
export const utils = {};
