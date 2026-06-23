import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONTEXT_MANIFEST } from './manifest-defaults.js';
import type { ContextManifest, ZoneEntry, SectionEntry } from './manifest-types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('manifest-loader');

const MANIFEST_FILENAME = 'context-manifest.json';

export class ManifestLoader {
  private manifest: ContextManifest | null = null;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private get manifestPath(): string {
    return path.join(this.cwd, '.agent', MANIFEST_FILENAME);
  }

  load(): ContextManifest {
    if (this.manifest) return this.manifest;

    const filePath = this.manifestPath;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid manifest: not a JSON object');
      }

      if (parsed.version !== 1) {
        throw new Error(`Unsupported manifest version: ${parsed.version}. Expected: 1`);
      }

      if (!parsed.zones || typeof parsed.zones !== 'object') {
        throw new Error('Invalid manifest: missing "zones" object');
      }

      for (const [zoneKey, zoneDef] of Object.entries(parsed.zones)) {
        const zone = zoneDef as any;
        if (typeof zone.enabled !== 'boolean') {
          throw new Error(`Invalid zone "${zoneKey}": missing "enabled" boolean`);
        }
        if (!Array.isArray(zone.sections)) {
          throw new Error(`Invalid zone "${zoneKey}": missing "sections" array`);
        }
        for (const section of zone.sections) {
          if (!section.name || !section.source || section.priority == null || !section.type) {
            throw new Error(`Invalid section in zone "${zoneKey}": missing required fields (name, source, priority, type)`);
          }
        }
      }

      this.manifest = parsed as ContextManifest;
      logger.info('context-manifest.json loaded');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.manifest = this.generateDefaults();
      } else if (err instanceof SyntaxError) {
        logger.warn('context-manifest.json parse error, generating defaults', { error: err.message });
        this.manifest = this.generateDefaults();
      } else {
        throw err;
      }
    }

    return this.manifest;
  }

  reload(): ContextManifest {
    this.manifest = null;
    return this.load();
  }

  getZone(name: string): ZoneEntry | undefined {
    const m = this.load();
    return m.zones[name];
  }

  getEnabledZones(): Array<[string, ZoneEntry]> {
    const m = this.load();
    return Object.entries(m.zones)
      .filter(([, zone]) => zone.enabled)
      .sort(([, a], [, b]) => a.order - b.order);
  }

  getSections(zoneName: string): SectionEntry[] {
    const zone = this.getZone(zoneName);
    if (!zone) return [];
    return [...zone.sections].sort((a, b) => a.priority - b.priority);
  }

  getManifest(): ContextManifest {
    return this.load();
  }

  isZoneEnabled(zoneName: string): boolean {
    const zone = this.getZone(zoneName);
    return zone?.enabled ?? false;
  }

  private generateDefaults(): ContextManifest {
    const m = JSON.parse(JSON.stringify(DEFAULT_CONTEXT_MANIFEST)) as ContextManifest;

    try {
      fs.writeFileSync(this.manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf-8');
      logger.info('Generated default context-manifest.json');
    } catch (err) {
      logger.warn('Failed to write default context-manifest.json', { error: (err as Error).message });
    }

    return m;
  }
}
