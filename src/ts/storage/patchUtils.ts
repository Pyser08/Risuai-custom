/**
 * Utility functions for JSON patch operations.
 * Used by RisuSavePatcher for generating normalized hashes.
 */

/**
 * Recursively normalizes a JSON object by sorting all keys alphabetically.
 * This ensures that structurally identical objects produce the same hash
 * regardless of key insertion order.
 */
export function normalizeJSON(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(normalizeJSON);

    const sorted: Record<string, any> = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = normalizeJSON(obj[key]);
    }
    return sorted;
}

/**
 * Calculates a SHA-256 hash of the given data after normalizing it.
 * Uses Web Crypto API for browser compatibility.
 */
export async function calculateHash(data: any): Promise<string> {
    const normalized = JSON.stringify(normalizeJSON(data));
    const encoded = new TextEncoder().encode(normalized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
