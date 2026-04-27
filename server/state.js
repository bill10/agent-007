// Shared mutable state — single owner for all Maps, Sets, and singletons.
// All other modules import from here. No circular deps.

import { homedir } from 'os';
import { join } from 'path';
import {
  createCodenamePool, createCocktailPool, createColorCycler,
} from '../lib/helpers.js';

// --- Constants ---
export const PORT = process.env.PORT || 7007;
export const RING_BUFFER_MAX = 5000;
export const GIT_AUTO_TIMEOUT = 5000;
export const GIT_USER_TIMEOUT = 30000;
export const CONFIG_DIR = join(homedir(), '.agent-007');
export const WORKTREE_DIR = join(CONFIG_DIR, 'worktrees');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// --- Mutable state ---
export const sessions = new Map();
export let sessionCounter = 0;
export function nextSessionId() { return `session-${++sessionCounter}`; }

export const orphans = new Map();
export const adoptingOrphans = new Set();

export let config = { version: 1, repos: [], orphans: [], activeSessions: [] };
export function setConfig(c) { config = c; }

export const knownConflictKeys = new Set();

// --- Pools ---
export const codenamePool = createCodenamePool();
export const cocktailPool = createCocktailPool();
export const colorCycler = createColorCycler();
