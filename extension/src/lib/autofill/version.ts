declare const __JC_BUILD__: string | undefined;

/** Identifies this build's form filler, so a filler left in a page by an earlier build is replaced, not reused. */
export const FILLER_VERSION: string = typeof __JC_BUILD__ === 'string' ? __JC_BUILD__ : 'dev';
