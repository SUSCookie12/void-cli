import {
  listAddons,
  resolveMissingAddonMetadata,
  saveAddonMetadata,
  toggleAddon,
  type AddonInfo,
  type AddonMetadata,
} from './addonMeta.js';

export type ModInfo = AddonInfo;

export function listMods(serverName: string): ModInfo[] {
  return listAddons(serverName, 'mod');
}

export function toggleMod(serverName: string, fileName: string, enable: boolean): void {
  toggleAddon(serverName, 'mod', fileName, enable);
}

export function saveModMetadata(
  serverName: string,
  fileName: string,
  meta: Partial<AddonMetadata>,
  fullFilePath?: string,
): void {
  saveAddonMetadata(serverName, 'mod', fileName, meta, fullFilePath);
}

export function resolveMissingModMetadata(serverName: string): Promise<boolean> {
  return resolveMissingAddonMetadata(serverName, 'mod');
}
