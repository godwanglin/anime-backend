function resolveStreamingHostUrl() {
  const configured = process.env.STREAMING_HOST_URL?.trim();
  if (!configured) return "http://localhost:3000";

  try {
    const withScheme = /^https?:\/\//i.test(configured)
      ? configured
      : `https://${configured}`;
    const url = new URL(withScheme);
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";

    const protocol = isLocalhost ? url.protocol : "https:";
    const host = url.host;
    const pathname =
      url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${protocol}//${host}${pathname}`;
  } catch {
    return configured.replace(/\/+$/, "");
  }
}

export const STREAMING_HOST_URL = resolveStreamingHostUrl();
