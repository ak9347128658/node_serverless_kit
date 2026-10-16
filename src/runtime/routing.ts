/**
 * Tiny route matcher, used where the provider has no API gateway in front of
 * the function (GCP, IBM, DigitalOcean, Cloudflare, ...) and by the local dev
 * server.
 *
 * Patterns use `{name}` for one segment and `{name+}` for a greedy tail, the
 * same syntax as AWS API Gateway, Azure Functions and the YAML config.
 */

export function splitPath(path: string): string[] {
  return path
    .split("?")[0]
    .split("/")
    .filter((s) => s.length > 0);
}

function isParam(seg: string): boolean {
  return seg.startsWith("{") && seg.endsWith("}");
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (isParam(seg)) {
      const name = seg.slice(1, -1);
      if (name.endsWith("+")) {
        if (i !== pattern.length - 1 || i >= parts.length) return null;
        params[name.slice(0, -1)] = parts.slice(i).map(decode).join("/");
        return params;
      }
      if (i >= parts.length) return null;
      params[name] = decode(parts[i]);
    } else if (i >= parts.length || seg !== parts[i]) {
      return null;
    }
  }
  return parts.length === pattern.length ? params : null;
}

/**
 * Return path params if `path` matches `pattern`, else `null`.
 *
 * With `tolerant` (the default) two platform quirks are accepted as well:
 *
 * - the platform *prepended* a fixed prefix (Azure `/api/users/7`): the whole
 *   pattern must then match the tail of the path;
 * - the platform *stripped* the pattern's leading static segments (GCP serves
 *   `/users/{id}` at `https://.../fn-name/7`): the remaining pattern must then
 *   match the whole path.
 */
export function matchPath(pattern: string, path: string, tolerant = true): Record<string, string> | null {
  const pat = splitPath(pattern);
  const parts = splitPath(path);
  const exact = matchSegments(pat, parts);
  if (exact !== null || !tolerant) return exact;
  if (pat.some((seg) => !isParam(seg))) {
    for (let drop = 1; drop < parts.length; drop++) {
      const got = matchSegments(pat, parts.slice(drop));
      if (got !== null) return got;
    }
  }
  let leadingStatic = 0;
  for (const seg of pat) {
    if (isParam(seg)) break;
    leadingStatic++;
  }
  if (leadingStatic) {
    const rest = pat.slice(leadingStatic);
    if (rest.length || !parts.length) return matchSegments(rest, parts);
  }
  return null;
}

export function methodMatches(allowed: string, method: string): boolean {
  const a = allowed.toUpperCase();
  const m = method.toUpperCase();
  return a === "ANY" || a === "*" || a === m || (a === "GET" && m === "HEAD");
}
