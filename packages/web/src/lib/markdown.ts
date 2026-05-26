import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// Stable reference — prevents a new array on every render.
export const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
