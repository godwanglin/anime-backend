const IMAGE_HOSTS = new Set([
  "cdn-static.weebin.site",
  "cdn-static.weebinhub.com",
]);

export function toImagePath(value: string | null | undefined) {
  if (!value) return value;

  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  try {
    const url = new URL(trimmed);
    if (!IMAGE_HOSTS.has(url.hostname)) return trimmed;
    return `${url.pathname.replace(/^\/+/, "")}${url.search}${url.hash}`;
  } catch {
    return trimmed.replace(/^\/+/, "");
  }
}
