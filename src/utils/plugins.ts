import {
  listAddons,
  resolveMissingAddonMetadata,
  saveAddonMetadata,
  toggleAddon,
  type AddonInfo,
  type AddonMetadata,
} from './addonMeta.js';

export type PluginInfo = AddonInfo;

export function listPlugins(serverName: string): PluginInfo[] {
  return listAddons(serverName, 'plugin');
}

export function togglePlugin(serverName: string, fileName: string, enable: boolean): void {
  toggleAddon(serverName, 'plugin', fileName, enable);
}

export function savePluginMetadata(
  serverName: string,
  fileName: string,
  meta: Partial<AddonMetadata>,
  fullFilePath?: string,
): void {
  saveAddonMetadata(serverName, 'plugin', fileName, meta, fullFilePath);
}

export function resolveMissingPluginMetadata(serverName: string): Promise<boolean> {
  return resolveMissingAddonMetadata(serverName, 'plugin');
}
