/**
 * Gamma Tokenizer — js-tiktoken wrapper
 *
 * Lazy singleton tokenizer using cl100k_base encoding.
 * Pure JS implementation, no native dependencies.
 */

import { type Tiktoken, getEncoding } from "js-tiktoken";

// =============================================================================
// SINGLETON TOKENIZER
// =============================================================================

let tokenizer: Tiktoken | null = null;

/**
 * Get the singleton tokenizer instance (lazy initialization).
 */
function getTokenizer(): Tiktoken {
  if (!tokenizer) {
    // cl100k_base is used by GPT-4 and works well for Claude
    tokenizer = getEncoding("cl100k_base");
  }
  return tokenizer;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Count tokens in a text string.
 *
 * @param text - Text to tokenize
 * @returns Token count
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getTokenizer().encode(text).length;
}

/**
 * Estimate image tokens.
 * Claude uses ~765 tokens per image (base) plus detail-dependent tokens.
 *
 * @param _width - Image width (unused in simple estimate)
 * @param _height - Image height (unused in simple estimate)
 * @returns Estimated token count
 */
export function estimateImageTokens(_width?: number, _height?: number): number {
  // Simple estimate: ~765 base + ~85 per 512x512 tile
  // For now, use flat 850 tokens per image
  return 850;
}

/**
 * Free the tokenizer instance (for cleanup).
 */
export function freeTokenizer(): void {
  tokenizer = null;
}
