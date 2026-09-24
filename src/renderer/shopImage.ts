// Product media IDs are immutable; share a bounded cache between card thumbnails and editors.
const images = new Map<string, Promise<string>>();
export function loadShopImage(id: string): Promise<string> {
  const existing = images.get(id);
  if (existing) return existing;
  const request = window.amaneStock.getShopImage(id).catch(error => { images.delete(id); throw error; });
  images.set(id, request);
  if (images.size > 64) images.delete(images.keys().next().value!);
  return request;
}
