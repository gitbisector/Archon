import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// Hoisted to module scope to prevent new array references on every render.
// Import this constant wherever ReactMarkdown is used so all components
// share a single stable reference (satisfies Rule of Three).
export const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
