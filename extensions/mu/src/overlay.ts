/**
 * Re-export DimmedOverlay from shared-tui.
 *
 * jiti resolves entry-file (index.ts) imports from Pi's install
 * location, not the extension's. Sub-modules like this are resolved
 * natively by Node from the extension's node_modules.
 */
export { DimmedOverlay } from "shared-tui";
