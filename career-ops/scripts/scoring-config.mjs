#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

const DEFAULT_SCORING_CONFIG = {
  legacy: {
    advance_threshold: 3.0,
    comp_floor_usd: 70000,
    dimensions: {
      north_star_alignment: 0.25,
      cv_match: 0.15,
      level: 0.15,
      estimated_comp: 0.10,
      growth_trajectory: 0.10,
      remote_quality: 0.05,
      company_reputation: 0.05,
      tech_stack_modernity: 0.05,
      speed_to_offer: 0.05,
      cultural_signals: 0.05,
    },
  },
  batch: {
    decision_threshold: 3.0,
    tracker_min_score: 3.0,
    followup_threshold: 3.0,
  },
};

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeConfig(raw = {}) {
  const legacyRaw = raw.legacy || {};
  const legacyDimensionsRaw = legacyRaw.dimensions || {};
  const batchRaw = raw.batch || {};

  return {
    legacy: {
      advance_threshold: toNumber(legacyRaw.advance_threshold, DEFAULT_SCORING_CONFIG.legacy.advance_threshold),
      comp_floor_usd: toNumber(legacyRaw.comp_floor_usd, DEFAULT_SCORING_CONFIG.legacy.comp_floor_usd),
      dimensions: {
        north_star_alignment: toNumber(
          legacyDimensionsRaw.north_star_alignment,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.north_star_alignment,
        ),
        cv_match: toNumber(legacyDimensionsRaw.cv_match, DEFAULT_SCORING_CONFIG.legacy.dimensions.cv_match),
        level: toNumber(legacyDimensionsRaw.level, DEFAULT_SCORING_CONFIG.legacy.dimensions.level),
        estimated_comp: toNumber(
          legacyDimensionsRaw.estimated_comp,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.estimated_comp,
        ),
        growth_trajectory: toNumber(
          legacyDimensionsRaw.growth_trajectory,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.growth_trajectory,
        ),
        remote_quality: toNumber(
          legacyDimensionsRaw.remote_quality,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.remote_quality,
        ),
        company_reputation: toNumber(
          legacyDimensionsRaw.company_reputation,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.company_reputation,
        ),
        tech_stack_modernity: toNumber(
          legacyDimensionsRaw.tech_stack_modernity,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.tech_stack_modernity,
        ),
        speed_to_offer: toNumber(
          legacyDimensionsRaw.speed_to_offer,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.speed_to_offer,
        ),
        cultural_signals: toNumber(
          legacyDimensionsRaw.cultural_signals,
          DEFAULT_SCORING_CONFIG.legacy.dimensions.cultural_signals,
        ),
      },
    },
    batch: {
      decision_threshold: toNumber(batchRaw.decision_threshold, DEFAULT_SCORING_CONFIG.batch.decision_threshold),
      tracker_min_score: toNumber(batchRaw.tracker_min_score, DEFAULT_SCORING_CONFIG.batch.tracker_min_score),
      followup_threshold: toNumber(batchRaw.followup_threshold, DEFAULT_SCORING_CONFIG.batch.followup_threshold),
    },
  };
}

export function loadScoringConfig(configPath = 'config/scoring.yml') {
  if (!existsSync(configPath)) {
    return DEFAULT_SCORING_CONFIG;
  }

  try {
    const loaded = yaml.load(readFileSync(configPath, 'utf8')) || {};
    return sanitizeConfig(loaded);
  } catch {
    return DEFAULT_SCORING_CONFIG;
  }
}

function toShellExports(config) {
  return [
    `SCORING_BATCH_DECISION_THRESHOLD=${config.batch.decision_threshold}`,
    `SCORING_BATCH_TRACKER_MIN_SCORE=${config.batch.tracker_min_score}`,
    `SCORING_BATCH_FOLLOWUP_THRESHOLD=${config.batch.followup_threshold}`,
    `SCORING_LEGACY_ADVANCE_THRESHOLD=${config.legacy.advance_threshold}`,
    `SCORING_LEGACY_COMP_FLOOR_USD=${config.legacy.comp_floor_usd}`,
  ].join('\n');
}

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const args = process.argv.slice(2);
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'json';
  const config = loadScoringConfig();

  if (format === 'shell') {
    process.stdout.write(`${toShellExports(config)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  }
}
