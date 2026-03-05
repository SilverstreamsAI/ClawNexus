// Auto-name generation — creates human-readable names from instance metadata

/**
 * Normalize a string into a valid auto_name:
 * lowercase, strip non-alphanumeric (except hyphens), collapse hyphens, trim, truncate 32 chars.
 * Falls back to "instance" if result is empty.
 */
export function normalize(name: string): string {
  let result = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // replace invalid chars with hyphen
    .replace(/-+/g, "-")          // collapse consecutive hyphens
    .replace(/^-|-$/g, "");       // trim leading/trailing hyphens

  if (result.length > 32) {
    result = result.slice(0, 32).replace(/-$/, "");
  }

  return result || "instance";
}

/**
 * Generate an auto_name from instance metadata.
 * Priority: lanHost (strip .local) > displayName > address
 */
export function generateAutoName(
  lanHost: string,
  displayName: string,
  address: string,
): string {
  // Try lan_host first (strip .local suffix for cleaner names)
  if (lanHost && lanHost !== "127.0.0.1" && lanHost !== address) {
    const stripped = lanHost.replace(/\.local$/i, "");
    const name = normalize(stripped);
    if (name !== "instance") return name;
  }

  // Try display_name
  if (displayName) {
    const name = normalize(displayName);
    if (name !== "instance") return name;
  }

  // Fall back to address
  return normalize(address);
}

/**
 * Ensure uniqueness by appending `-2`, `-3`, etc. if the base name already exists.
 */
export function ensureUnique(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) return baseName;

  for (let i = 2; i <= 999; i++) {
    const candidate = `${baseName}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }

  // Extremely unlikely fallback
  return `${baseName}-${Date.now()}`;
}
