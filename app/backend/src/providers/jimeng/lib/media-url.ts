export function parseHttpMediaUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch {
    // Malformed media URL.
  }
}

// Video CDN links can be extensionless. Reject links that explicitly identify an image.
export function isVideoMediaUrl(value: unknown): value is string {
  const url = parseHttpMediaUrl(value);
  return !!url && !/\.(?:avif|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(url.pathname)
    && !/^image[/_]/i.test(url.searchParams.get("mime_type") ?? "");
}
