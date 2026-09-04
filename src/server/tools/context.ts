import { ProfileStore } from "../../profile/store.js";
import { AdapterRegistry } from "../../adapters/registry.js";
import { PreviewManager } from "../preview.js";

export interface ToolContext {
  profileStore: ProfileStore;
  adapterRegistry: AdapterRegistry;
  previewManager: PreviewManager;
}
