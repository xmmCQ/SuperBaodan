export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_JSON_BYTES = 16 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const IMAGE_LIMIT_HINT = '最多4张图片，单张不超过5 MiB，合计不超过10 MiB（PNG/JPEG/WebP/GIF）';
const fail = (message, statusCode = 413) => Object.assign(new Error(message), { statusCode, status: statusCode });
export function imageBytes(image) {
  const value = image?.data;
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail('图片编码无效', 400);
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}
export function validateImageSizes(items) {
  if (!Array.isArray(items) || items.length > MAX_IMAGES) throw fail(IMAGE_LIMIT_HINT);
  let total = 0;
  for (const item of items) {
    if (!IMAGE_TYPES.includes(item.mimeType)) throw fail('仅支持PNG、JPEG、WebP和GIF图片', 400);
    if (!Number.isInteger(item.size) || item.size <= 0 || item.size > MAX_IMAGE_BYTES) throw fail(IMAGE_LIMIT_HINT);
    total += item.size;
  }
  if (total > MAX_TOTAL_IMAGE_BYTES) throw fail(IMAGE_LIMIT_HINT);
}
export function validatePromptImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw fail(IMAGE_LIMIT_HINT);
  validateImageSizes(images.map(image => {
    if (typeof image?.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw fail(IMAGE_LIMIT_HINT);
    return { mimeType: image.mimeType, size: imageBytes(image) };
  }));
}
export function validatePromptPayload(payload) {
  validatePromptImages(payload.images);
  if (new TextEncoder().encode(payload.message || '').length > 1024 * 1024) throw fail('提问文字不能超过1 MiB');
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_PROMPT_JSON_BYTES) throw fail('图片和文字请求总大小不能超过16 MiB');
}
