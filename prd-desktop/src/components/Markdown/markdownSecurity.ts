import { defaultSchema } from 'rehype-sanitize';

// Untrusted documents may contain formatting HTML, never active/embedded content.
export const markdownSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: ['https', 'http', 'data'] },
};

export function safePrdUrlTransform(url: string, key: string): string {
  const raw = url.trim();
  if (/[\u0000-\u0020\u007f]/.test(raw)) return '';
  if (key === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (key === 'href' && (/^#[^\s]*$/.test(raw) || /^mailto:/i.test(raw))) return raw;
  // Relative paths resolve to the privileged app origin; blob/data links can navigate to HTML.
  return '';
}
