/**
 * worldMap.ts
 * Reads Minecraft vanilla .mca (Anvil) region files, renders them as PNG tiles,
 * and manages per-server file watchers for near-real-time updates.
 *
 * No plugins or mods required — works with all vanilla/Paper servers.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { getServerDir } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Block → RGB color palette
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_COLORS: Record<string, [number, number, number]> = {
  // Terrain
  'minecraft:grass_block':       [106, 127,  75],
  'minecraft:dirt':              [134,  96,  67],
  'minecraft:coarse_dirt':       [120,  85,  60],
  'minecraft:rooted_dirt':       [134,  96,  67],
  'minecraft:podzol':            [103,  75,  44],
  'minecraft:mycelium':          [111,  96, 103],
  'minecraft:stone':             [125, 125, 125],
  'minecraft:granite':           [154, 100,  80],
  'minecraft:polished_granite':  [168, 115,  92],
  'minecraft:diorite':           [188, 188, 188],
  'minecraft:andesite':          [136, 136, 140],
  'minecraft:deepslate':         [ 70,  70,  70],
  'minecraft:tuff':              [105, 107,  97],
  'minecraft:calcite':           [190, 180, 180],
  'minecraft:bedrock':           [ 84,  84,  84],
  'minecraft:gravel':            [136, 126, 126],
  'minecraft:cobblestone':       [120, 120, 120],
  'minecraft:mossy_cobblestone': [100, 120,  90],
  // Water & liquids
  'minecraft:water':             [ 64, 164, 223],
  'minecraft:lava':              [207,  73,   2],
  // Sand & desert
  'minecraft:sand':              [219, 207, 163],
  'minecraft:red_sand':          [190, 102,  13],
  'minecraft:sandstone':         [213, 201, 140],
  'minecraft:red_sandstone':     [185,  97,  12],
  // Snow & ice
  'minecraft:snow':              [240, 240, 255],
  'minecraft:snow_block':        [240, 240, 255],
  'minecraft:powder_snow':       [230, 235, 250],
  'minecraft:ice':               [174, 215, 240],
  'minecraft:packed_ice':        [157, 210, 236],
  'minecraft:blue_ice':          [115, 198, 234],
  // Logs & wood
  'minecraft:oak_log':           [107,  79,  37],
  'minecraft:birch_log':         [210, 215, 190],
  'minecraft:spruce_log':        [ 76,  54,  27],
  'minecraft:jungle_log':        [ 83,  64,  21],
  'minecraft:acacia_log':        [165,  91,  37],
  'minecraft:dark_oak_log':      [ 60,  40,  15],
  'minecraft:mangrove_log':      [ 85,  42,  27],
  'minecraft:cherry_log':        [198, 142, 145],
  // Leaves
  'minecraft:oak_leaves':        [ 59, 100,  49],
  'minecraft:birch_leaves':      [128, 167,  85],
  'minecraft:spruce_leaves':     [ 97, 127,  57],
  'minecraft:jungle_leaves':     [ 72, 138,  49],
  'minecraft:acacia_leaves':     [ 90, 119,  45],
  'minecraft:dark_oak_leaves':   [ 48,  84,  30],
  'minecraft:mangrove_leaves':   [ 55, 100,  55],
  'minecraft:cherry_leaves':     [230, 180, 190],
  'minecraft:azalea_leaves':     [ 80, 110,  40],
  'minecraft:flowering_azalea_leaves':[ 150, 100, 150],
  // Ocean & underwater
  'minecraft:clay':              [162, 166, 182],
  'minecraft:seagrass':          [ 64, 160, 100],
  'minecraft:tall_seagrass':     [ 64, 160, 100],
  'minecraft:kelp':              [ 64, 160, 100],
  'minecraft:kelp_plant':        [ 64, 160, 100],
  'minecraft:sea_lantern':       [155, 240, 220],
  'minecraft:prismarine':        [ 99, 167, 152],
  'minecraft:lily_pad':          [ 30, 100,  40],
  'minecraft:coral_block':       [200, 100, 150],
  // Plants & grass
  'minecraft:grass':             [147, 185,  93],
  'minecraft:tall_grass':        [147, 185,  93],
  'minecraft:fern':              [100, 160,  80],
  'minecraft:large_fern':        [100, 160,  80],
  'minecraft:dandelion':         [255, 235,  59],
  'minecraft:poppy':             [220,  50,  50],
  'minecraft:mushroom_stem':     [210, 195, 180],
  'minecraft:red_mushroom_block': [200,  50,  50],
  'minecraft:brown_mushroom_block': [150, 107,  68],
  'minecraft:lush_caves':         [ 50, 100,  50],
  'minecraft:moss_block':         [ 80, 110,  40],
  'minecraft:big_dripleaf':       [100, 150,  60],
  'minecraft:small_dripleaf':     [100, 140,  60],
  // Nether
  'minecraft:netherrack':        [110,  30,  20],
  'minecraft:nether_bricks':     [ 50,  20,  20],
  'minecraft:nether_bricks_fence':[ 50,  20,  20],
  'minecraft:nether_gold_ore':   [160, 120,  40],
  'minecraft:nether_quartz_ore': [140, 100,  90],
  'minecraft:crimson_nylium':    [160,  40,  40],
  'minecraft:warped_nylium':     [ 30, 130, 120],
  'minecraft:soul_sand':         [ 80,  60,  50],
  'minecraft:soul_soil':         [ 70,  50,  40],
  'minecraft:magma_block':       [180,  70,  10],
  'minecraft:basalt':            [ 70,  70,  70],
  'minecraft:polished_basalt':   [ 60,  60,  60],
  'minecraft:blackstone':        [ 40,  35,  40],
  'minecraft:crimson_planks':    [150,  50,  70],
  'minecraft:warped_planks':     [ 50, 140, 140],
  'minecraft:warped_stem':       [ 50, 140, 140],
  'minecraft:warped_hyphae':     [ 50, 140, 140],
  'minecraft:crimson_stem':      [150,  50,  50],
  'minecraft:nether_wart_block': [130,   5,   5],
  'minecraft:warped_wart_block': [ 25, 140, 130],
  'minecraft:shroomlight':       [250, 190, 110],
  'minecraft:glowstone':         [230, 200, 140],
  'minecraft:crying_obsidian':   [ 50,  15,  90],
  // End
  'minecraft:end_stone':         [220, 220, 160],
  'minecraft:end_stone_bricks':  [205, 208, 152],
  'minecraft:purpur_block':      [170, 120, 170],
  'minecraft:obsidian':          [ 20,  18,  30],
  // Ores & Deepslate
  'minecraft:coal_ore':          [100, 100, 100],
  'minecraft:deepslate_coal_ore':[  70,  70,  70],
  'minecraft:iron_ore':          [136, 116,  92],
  'minecraft:deepslate_iron_ore':[ 100,  90,  80],
  'minecraft:copper_ore':        [120,  85,  60],
  'minecraft:deepslate_copper_ore':[100,  70,  50],
  'minecraft:gold_ore':          [185, 176,  39],
  'minecraft:deepslate_gold_ore':[150, 140,  30],
  'minecraft:redstone_ore':      [148,  54,  54],
  'minecraft:deepslate_redstone_ore':[120,  40,  40],
  'minecraft:lapis_ore':         [ 72,  96, 155],
  'minecraft:deepslate_lapis_ore':[ 50,  70, 120],
  'minecraft:diamond_ore':       [ 89, 208, 217],
  'minecraft:deepslate_diamond_ore':[ 60, 160, 170],
  'minecraft:emerald_ore':       [ 89, 190,  75],
  // Structures
  'minecraft:oak_planks':        [162, 130,  78],
  'minecraft:spruce_planks':     [110,  84,  48],
  'minecraft:birch_planks':      [214, 201, 141],
  'minecraft:dark_oak_planks':   [ 66,  43,  20],
  'minecraft:cherry_planks':     [230, 180, 180],
  'minecraft:bamboo_planks':     [200, 180,  80],
  'minecraft:mangrove_planks':   [115,  35,  35],
  'minecraft:stone_bricks':      [122, 122, 122],
  'minecraft:bricks':            [150,  97,  83],
  'minecraft:terracotta':        [151,  93,  67],
};

const AIR_BLOCKS = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'
]);

function resolveColor(name: string): [number, number, number] | null {
  if (AIR_BLOCKS.has(name)) return null;
  if (BLOCK_COLORS[name]) return BLOCK_COLORS[name];
  // Fuzzy fallbacks
  if (name.includes('leaves'))       return [ 59, 100,  49];
  if (name.includes('log') || (name.includes('stripped_') && name.includes('wood'))) return [107,  79,  37];
  if (name.includes('planks'))       return [180, 145,  90];
  if (name.includes('water'))        return [ 64, 164, 223];
  if (name.includes('lava'))         return [207,  73,   2];
  if (name.includes('sand'))         return [219, 207, 163];
  if (name.includes('snow') || name.includes('ice')) return [240, 240, 255];
  if (name.includes('ore'))          return [100, 100, 100];
  if (name.includes('nether'))       return [112,   2,   0];
  if (name.includes('terracotta'))   return [152,  94,  67];
  if (name.includes('concrete'))     return [180, 180, 180];
  if (name.includes('glass'))        return [180, 220, 240];
  if (name.includes('wool'))         return [230, 230, 230];
  if (name.includes('coral'))        return [200, 100, 150];
  if (name.includes('stone'))        return [125, 125, 125];
  if (name.includes('brick'))        return [150,  90,  70];
  if (name.includes('mushroom'))     return [150, 107,  68];
  return [63, 63, 63];
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal self-contained NBT reader (no external dep)
// ─────────────────────────────────────────────────────────────────────────────
class NBTReader {
  private buf: Buffer;
  private pos = 0;

  constructor(buf: Buffer) { this.buf = buf; }

  readUByte()  { return this.buf.readUInt8(this.pos++); }
  readByte()   { return this.buf.readInt8(this.pos++); }
  readShort()  { const v = this.buf.readInt16BE(this.pos);  this.pos += 2; return v; }
  readUShort() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  readInt()    { const v = this.buf.readInt32BE(this.pos);  this.pos += 4; return v; }
  readFloat()  { const v = this.buf.readFloatBE(this.pos);  this.pos += 4; return v; }
  readDouble() { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }

  readLong(): bigint {
    const hi = BigInt(this.buf.readInt32BE(this.pos));
    const lo = BigInt(this.buf.readUInt32BE(this.pos + 4));
    this.pos += 8;
    return (hi << 32n) | lo;
  }

  readString(): string {
    const len = this.readUShort();
    const str = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return str;
  }

  readPayload(type: number): any {
    switch (type) {
      case 0:  return null;
      case 1:  return this.readByte();
      case 2:  return this.readShort();
      case 3:  return this.readInt();
      case 4:  return this.readLong();
      case 5:  return this.readFloat();
      case 6:  return this.readDouble();
      case 7: {
        const len = this.readInt();
        const arr = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return arr;
      }
      case 8:  return this.readString();
      case 9: {
        const elType = this.readUByte();
        const len = this.readInt();
        const arr: any[] = [];
        for (let i = 0; i < len; i++) arr.push(this.readPayload(elType));
        return arr;
      }
      case 10: {
        const obj: Record<string, any> = {};
        for (;;) {
          const tagType = this.readUByte();
          if (tagType === 0) break;
          const name = this.readString();
          obj[name] = this.readPayload(tagType);
        }
        return obj;
      }
      case 11: {
        const len = this.readInt();
        const arr: number[] = [];
        for (let i = 0; i < len; i++) arr.push(this.readInt());
        return arr;
      }
      case 12: {
        const len = this.readInt();
        const arr: bigint[] = [];
        for (let i = 0; i < len; i++) arr.push(this.readLong());
        return arr;
      }
      default: throw new Error(`[WorldMap] Unknown NBT tag type: ${type}`);
    }
  }

  parse(): Record<string, any> {
    const rootType = this.readUByte();
    this.readString(); // root name (usually empty)
    return this.readPayload(rootType);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract top-block colors for a single chunk's NBT data
// Returns an array of 256 RGB colors (indexed [z*16+x])
// ─────────────────────────────────────────────────────────────────────────────
// Extract top-block colors and heights for a single chunk's NBT data
// Returns an array of 256 [R,G,B,Y] (indexed [z*16+x])
// ─────────────────────────────────────────────────────────────────────────────
function extractChunkColors(chunk: Record<string, any>, dim: string, maxY?: number): ([number, number, number, number] | null)[] {
  const data: ([number, number, number, number] | null)[] = new Array(256).fill(null);

  const isNew = !!chunk['sections'];
  const sections: any[] = isNew ? (chunk['sections'] ?? []) : (chunk['Level']?.['Sections'] ?? []);
  const heightmapRoot: any = isNew ? chunk['Heightmaps'] : chunk['Level']?.['Heightmaps'];

  if (!sections?.length) return data;

  const sectionMap = new Map<number, any>();
  for (const s of sections) {
    const y = s['Y'] ?? s['y'];
    if (y !== undefined) sectionMap.set(Number(y), s);
  }

  const sortedY = Array.from(sectionMap.keys()).sort((a,b) => b - a);
  const minY = isNew ? -64 : 0;

  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const i = z * 16 + x;
      let blockName: string | null = null;
      let startY = 320; 

      // Dimension-specific start heights (Slicing)
      if (dim === 'nether') startY = 125; // Skip roof
      if (dim === 'end')    startY = 80;  // Skip upper pillars for islands
      if (maxY !== undefined) startY = Math.min(startY, maxY);

      // Try for heightmap in Overworld first
      if (dim === 'overworld' && heightmapRoot && maxY === undefined) {
        const hmLongs: bigint[] = heightmapRoot['MOTION_BLOCKING'] || heightmapRoot['WORLD_SURFACE'];
        if (hmLongs?.length) {
          const BITS = 9;
          const VPL  = Math.floor(64 / BITS);
          const MASK = (1n << BigInt(BITS)) - 1n;
          const lIdx = Math.floor(i / VPL);
          const bOff = BigInt((i % VPL) * BITS);
          if (lIdx < hmLongs.length) {
            startY = Number((hmLongs[lIdx] >> bOff) & MASK) + minY - 1;
          }
        }
      }

      // Vertical Scan
      let hitY = -64;
      for (let yVal = startY; yVal >= -64; yVal--) {
        const secY = Math.floor(yVal / 16);
        const section = sectionMap.get(secY);
        if (!section) continue;

        const bs = isNew ? section['block_states'] : { palette: section['Palette'], data: section['BlockStates'] };
        const palette: any[] = bs?.palette ?? bs?.Palette ?? [];
        if (!palette.length) continue;

        const bstates: bigint[] = bs?.data ?? bs?.BlockStates ?? [];
        let pIdx = 0;

        if (bstates.length > 0) {
          const bIdx = (yVal % 16 + 16) % 16 * 256 + z * 16 + x;
          const bpb  = Math.max(4, Math.ceil(Math.log2(palette.length)));
          const vpl  = Math.floor(64 / bpb);
          const mask = (1n << BigInt(bpb)) - 1n;
          const lI   = Math.floor(bIdx / vpl);
          const bO   = BigInt((bIdx % vpl) * bpb);
          if (lI < bstates.length) pIdx = Number((bstates[lI] >> bO) & mask);
        }

        const name = palette[pIdx]?.Name || palette[pIdx]?.name || '';
        if (name && !AIR_BLOCKS.has(name) && !name.includes('bedrock')) {
          blockName = name;
          hitY = yVal;
          break; 
        }
      }

      if (blockName) {
        const color = resolveColor(blockName);
        if (color) data[i] = [color[0], color[1], color[2], hitY];
      }
    }
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse a .mca region file → 512×512 raw RGBA Buffer
// ─────────────────────────────────────────────────────────────────────────────
function parseRegionToPixels(mcaPath: string, dim: string, maxY?: number, intensity?: number): Buffer | null {
  let file: Buffer;
  try { file = fs.readFileSync(mcaPath); }
  catch { return null; }
  if (file.length < 8192) return null;

  const pixels  = Buffer.alloc(512 * 512 * 4);
  const heights = new Int16Array(512 * 512).fill(-99);

  // Background
  for (let i = 0; i < 512 * 512; i++) {
    pixels[i * 4] = 10; pixels[i * 4 + 1] = 10; pixels[i * 4 + 2] = 15; pixels[i * 4 + 3] = 255;
  }

  for (let cz = 0; cz < 32; cz++) {
    for (let cx = 0; cx < 32; cx++) {
      const hdrOff = 4 * (cx + cz * 32);
      const locWord = file.readUInt32BE(hdrOff);
      const secOff  = (locWord >>> 8) * 4096;
      if (secOff === 0) continue;

      try {
        const dataLen    = file.readUInt32BE(secOff);
        const compType   = file[secOff + 4];
        const compressed = file.subarray(secOff + 5, secOff + 4 + dataLen);

        let nbtBuf: Buffer;
        if      (compType === 2) nbtBuf = zlib.inflateSync(compressed);
        else if (compType === 1) nbtBuf = zlib.gunzipSync(compressed);
        else                     nbtBuf = compressed;

        const nbt    = new NBTReader(nbtBuf).parse();
        const results = extractChunkColors(nbt, dim, maxY);

        for (let bz = 0; bz < 16; bz++) {
          for (let bx = 0; bx < 16; bx++) {
            const res = results[bz * 16 + bx];
            if (!res) continue;
            const px = cx * 16 + bx, pz = cz * 16 + bz;
            const idx = (pz * 512 + px);
            heights[idx] = res[3];
            pixels[idx*4] = res[0]; pixels[idx*4+1] = res[1]; pixels[idx*4+2] = res[2];
          }
        }
      } catch { /* skip */ }
    }
  }

  // Pass 2: Variable-Intensity Directional Hillshading + Water Depth
  const intensityFactor = intensity !== undefined ? (intensity / 100) : 0.12;

  for (let pz = 0; pz < 512; pz++) {
    for (let px = 0; px < 512; px++) {
      const idx = pz * 512 + px;
      if (heights[idx] === -99) continue;

      let slope = 0;
      if (px > 0) slope += (heights[idx] - heights[idx - 1]);
      if (pz > 0) slope += (heights[idx] - heights[(pz - 1) * 512 + px]);

      const factor = 1 + (slope * intensityFactor);
      
      // Water Depth Shading (Optional - detect water colors)
      let r = pixels[idx * 4], g = pixels[idx * 4 + 1], b = pixels[idx * 4 + 2];
      const isWater = r === 64 && g === 64 && b === 255; // resolving standard water
      if (isWater) {
        // Darker blue for deeper water (depth = surface_y - sea_level_62)
        const depth = Math.max(0, 62 - heights[idx]);
        const dF = 1 - (depth * 0.05);
        r *= dF; g *= dF; b *= dF;
      }

      pixels[idx * 4]     = Math.min(255, Math.max(0, r * factor));
      pixels[idx * 4 + 1] = Math.min(255, Math.max(0, g * factor));
      pixels[idx * 4 + 2] = Math.min(255, Math.max(0, b * factor));
    }
  }

  return pixels;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile cache & watcher state
// ─────────────────────────────────────────────────────────────────────────────
const tileCache    = new Map<string, Buffer>();      // key → PNG buffer
const watchers     = new Map<string, fs.FSWatcher[]>(); // serverName → watchers
const renderQueue  = new Set<string>();              // "server:dim:filename"
let   isRendering  = false;
import { EventEmitter } from 'node:events';

export const mapEvents = new EventEmitter();

const DIM_PATHS: Record<string, string[]> = {
  overworld: [
    path.join('world', 'region'),
    path.join('world', 'dimensions', 'minecraft', 'overworld', 'region'),
    'region'
  ],
  nether: [
    path.join('world', 'DIM-1', 'region'),
    path.join('world_nether', 'DIM-1', 'region'),
    path.join('world', 'dimensions', 'minecraft', 'the_nether', 'region')
  ],
  end: [
    path.join('world', 'DIM1', 'region'),
    path.join('world_the_end', 'DIM1', 'region'),
    path.join('world', 'dimensions', 'minecraft', 'the_end', 'region')
  ],
};

function getActiveDimDir(serverDir: string, dim: string): string | null {
  const paths = DIM_PATHS[dim] || [];
  for (const p of paths) {
    const full = path.join(serverDir, p);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

async function processQueue(): Promise<void> {
  if (isRendering || renderQueue.size === 0) return;
  isRendering = true;

  const [key] = renderQueue;
  renderQueue.delete(key);

  const [serverName, dim, filename, maxYStr, intensityStr] = key.split(':');
  const serverDir = getServerDir(serverName);
  const regionDir = getActiveDimDir(serverDir, dim);

  if (regionDir) {
    const mcaPath = path.join(regionDir, filename);
    if (fs.existsSync(mcaPath)) {
      try {
        const maxY = (maxYStr && maxYStr !== 'auto') ? parseInt(maxYStr) : undefined;
        const intensity = (intensityStr && intensityStr.startsWith('i')) ? parseInt(intensityStr.slice(1)) : undefined;
        
        // Copy to avoid locking contention with the Minecraft process
        const tmp = path.join(os.tmpdir(), `void_map_${serverName}_${dim}_${maxY || 'auto'}_${intensity || 'def'}_${filename}`);
        fs.copyFileSync(mcaPath, tmp);

        const pixelData = parseRegionToPixels(tmp, dim, maxY, intensity);
        fs.unlinkSync(tmp);

        if (pixelData) {
          const sharp = (await import('sharp')).default;
          const png   = await sharp(pixelData, { raw: { width: 512, height: 512, channels: 4 } })
            .png({ compressionLevel: 6 })
            .toBuffer();
          
          tileCache.set(key, png);
          console.log(`[WorldMap] Rendered tile ${key} (${(png.length / 1024).toFixed(1)} KB)`);
          
          const match = filename.match(/r\.(-?\d+)\.(-?\d+)\.mca/);
          if (match) {
            mapEvents.emit('tile_rendered', key, png);
          }
        }
      } catch (err) {
        console.error('[WorldMap] Render error for', key, err);
      }
    }
  }

  isRendering = false;
  if (renderQueue.size > 0) setImmediate(processQueue);
}

function queueRegion(serverName: string, dim: string, filename: string, maxY?: number, intensity?: number): void {
  const key = `${serverName}:${dim}:${filename}${maxY !== undefined ? ':' + maxY : ':auto'}${intensity !== undefined ? ':i' + intensity : ''}`;
  if (renderQueue.has(key)) return;
  renderQueue.add(key);
  processQueue().catch(console.error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function startMapWatcher(serverName: string): void {
  if (watchers.has(serverName)) return;
  const serverDir = getServerDir(serverName);
  const watcherList: fs.FSWatcher[] = [];

  for (const dim of Object.keys(DIM_PATHS)) {
    const regionDir = getActiveDimDir(serverDir, dim);
    if (!regionDir) continue;

    // Initial render pass (auto height)
    fs.readdirSync(regionDir).filter(f => f.endsWith('.mca')).forEach(f => queueRegion(serverName, dim, f));

    // Watch for future changes
    const w = fs.watch(regionDir, (_event, filename) => {
      if (filename?.endsWith('.mca')) queueRegion(serverName, dim, filename);
    });
    watcherList.push(w);
    console.log(`[WorldMap] Watching ${dim} for ${serverName}`);
  }

  watchers.set(serverName, watcherList);
}

export function stopMapWatcher(serverName: string): void {
  const ws = watchers.get(serverName);
  if (ws) {
    ws.forEach(w => w.close());
    watchers.delete(serverName);
  }
  for (const k of [...tileCache.keys()]) {
    if (k.startsWith(`${serverName}:`)) tileCache.delete(k);
  }
}

export function getMapMetadata(serverName: string) {
  const serverDir = getServerDir(serverName);
  const dims: Record<string, { regions: { rx: number; rz: number; hash: string }[] }> = {};

  for (const dim of Object.keys(DIM_PATHS)) {
    const regionDir = getActiveDimDir(serverDir, dim);
    if (!regionDir) continue;
    const regions = fs.readdirSync(regionDir)
      .filter(f => f.endsWith('.mca'))
      .map(f => {
        const parts = f.replace('.mca', '').split('.');
        const stats = fs.statSync(path.join(regionDir, f));
        return { 
          rx: parseInt(parts[1]), 
          rz: parseInt(parts[2]),
          hash: stats.mtimeMs.toString() 
        };
      })
      .filter(r => !isNaN(r.rx) && !isNaN(r.rz));
    if (regions.length) dims[dim] = { regions };
  }

  return { dims };
}

export async function getMapTile(serverName: string, dim: string, rx: number, rz: number, maxY?: number, intensity?: number): Promise<Buffer | null> {
  const filename = `r.${rx}.${rz}.mca`;
  const cacheKey = `${serverName}:${dim}:${filename}${maxY !== undefined ? ':' + maxY : ''}${intensity !== undefined ? ':i' + intensity : ''}`;
  
  if (tileCache.has(cacheKey)) return tileCache.get(cacheKey)!;

  // If not cached, queue and wait
  queueRegion(serverName, dim, filename, maxY, intensity);

  return new Promise((resolve) => {
    const onRendered = (key: string, buffer: Buffer) => {
      if (key === cacheKey) {
        mapEvents.off('tile_rendered', onRendered);
        resolve(buffer);
      }
    };
    mapEvents.on('tile_rendered', onRendered);

    setTimeout(() => {
       mapEvents.off('tile_rendered', onRendered);
       resolve(null);
    }, 15000); // 15s timeout for heavy renders
  });
}

export function refreshAllTiles(serverName: string): void {
  stopMapWatcher(serverName);
  startMapWatcher(serverName);
}
