/**
 * RisuSavePatcher - Efficient patch-based save system for Node.js server mode.
 * 
 * Instead of sending the entire database (~100MB) on each save,
 * this class generates JSON patches (~10KB) of only the changed data
 * and sends them to the server for in-memory application.
 * 
 * Uses fast-json-patch for diff generation and custom hash functions
 * for data integrity verification.
 */

import { compare, type Operation } from 'fast-json-patch';
import type { Database } from './database.svelte';
import type { toSaveType } from './risuSave';
import { normalizeJSON, calculateHash } from './patchUtils';

declare function safeStructuredClone<T>(data: T): T;

export interface PatchResult {
    /** The JSON patch operations to send */
    patch: Operation[];
    /** The expected hash after applying the patch */
    expectedHash: string;
    /** The block name that was patched */
    blockName: string;
}

export class RisuSavePatcher {
    /** Previous state snapshots for each block, keyed by block name */
    private previousStates: Map<string, any> = new Map();
    /** Cached hashes for each block */
    private hashes: Map<string, string> = new Map();
    /** Whether the patcher has been initialized with a full state */
    private initialized: boolean = false;

    /**
     * Initialize the patcher with the full database state.
     * Returns a map of blockName -> data for initial seeding to the server.
     * The caller should write these as JSON files so that /api/patch can find them.
     */
    async init(data: Database): Promise<Map<string, any>> {
        const seedData = new Map<string, any>();

        // Store root state (everything except characters, botPresets, modules)
        const rootObj: Record<string, any> = {};
        for (const key of Object.keys(data)) {
            if (key !== 'characters' && key !== 'botPresets' && key !== 'modules') {
                rootObj[key] = data[key];
            }
        }
        this.previousStates.set('root', safeStructuredClone(rootObj));
        this.hashes.set('root', await calculateHash(rootObj));
        seedData.set('root', rootObj);

        // Store preset state
        this.previousStates.set('preset', safeStructuredClone(data.botPresets));
        this.hashes.set('preset', await calculateHash(data.botPresets));
        seedData.set('preset', data.botPresets);

        // Store modules state
        this.previousStates.set('modules', safeStructuredClone(data.modules));
        this.hashes.set('modules', await calculateHash(data.modules));
        seedData.set('modules', data.modules);

        // Store character states
        for (const character of data.characters) {
            this.previousStates.set(character.chaId, safeStructuredClone(character));
            this.hashes.set(character.chaId, await calculateHash(character));
            seedData.set(character.chaId, character);
        }

        this.initialized = true;
        return seedData;
    }

    /**
     * Generate patches for the changed blocks. Uses changeTracker to only
     * process modified data, minimizing computation.
     * 
     * @returns Array of patch results, or null if a full save is needed
     */
    async generatePatches(data: Database, toSave: toSaveType): Promise<PatchResult[] | null> {
        if (!this.initialized) {
            return null;
        }

        const results: PatchResult[] = [];

        try {
            // Process root (non-character, non-preset, non-module fields)
            const rootObj: Record<string, any> = {};
            for (const key of Object.keys(data)) {
                if (key !== 'characters' && key !== 'botPresets' && key !== 'modules') {
                    rootObj[key] = data[key];
                }
            }
            const rootPatch = await this.generateBlockPatch('root', rootObj);
            if (rootPatch && rootPatch.patch.length > 0) {
                results.push(rootPatch);
            }

            // Process changed characters
            const processedCharIds = new Set<string>();
            for (const chaId of toSave.character) {
                const character = data.characters.find(c => c.chaId === chaId);
                if (character) {
                    const charPatch = await this.generateBlockPatch(chaId, character);
                    if (charPatch && charPatch.patch.length > 0) {
                        results.push(charPatch);
                    }
                    processedCharIds.add(chaId);
                }
            }

            // Process new characters (not in previousStates)
            for (const character of data.characters) {
                if (!processedCharIds.has(character.chaId) && !this.previousStates.has(character.chaId)) {
                    // New character - needs full save for this block, return null
                    return null;
                }
            }

            // Check for deleted characters
            for (const [key] of this.previousStates) {
                if (key === 'root' || key === 'preset' || key === 'modules') continue;
                if (!data.characters.find(c => c.chaId === key)) {
                    // Character deleted - needs full save
                    return null;
                }
            }

            // Process presets if changed
            if (toSave.botPreset) {
                const presetPatch = await this.generateBlockPatch('preset', data.botPresets);
                if (presetPatch && presetPatch.patch.length > 0) {
                    results.push(presetPatch);
                }
            }

            // Process modules if changed
            if (toSave.modules) {
                const modulesPatch = await this.generateBlockPatch('modules', data.modules);
                if (modulesPatch && modulesPatch.patch.length > 0) {
                    results.push(modulesPatch);
                }
            }
        } catch (error) {
            console.error('[RisuSavePatcher] Error generating patches:', error);
            return null;
        }

        return results;
    }

    /**
     * Generate a patch for a single block by comparing with previous state.
     */
    private async generateBlockPatch(blockName: string, currentData: any): Promise<PatchResult | null> {
        const previousData = this.previousStates.get(blockName);
        if (!previousData) {
            // No previous state - need full save for this block
            return null;
        }

        const patch = compare(previousData, currentData);
        if (patch.length === 0) {
            return { patch: [], expectedHash: this.hashes.get(blockName)!, blockName };
        }

        const newHash = await calculateHash(currentData);

        // Update cached state
        this.previousStates.set(blockName, safeStructuredClone(currentData));
        this.hashes.set(blockName, newHash);

        return {
            patch,
            expectedHash: newHash,
            blockName
        };
    }

    /**
     * Reset a specific block's cached state (e.g., after a failed patch).
     */
    invalidateBlock(blockName: string): void {
        this.previousStates.delete(blockName);
        this.hashes.delete(blockName);
    }

    /**
     * Reset all cached state, forcing a full re-initialization.
     */
    reset(): void {
        this.previousStates.clear();
        this.hashes.clear();
        this.initialized = false;
    }

    /**
     * Get the current hash for a block.
     */
    getBlockHash(blockName: string): string | undefined {
        return this.hashes.get(blockName);
    }

    get isInitialized(): boolean {
        return this.initialized;
    }
}
