// eslint-disable-next-line @typescript-eslint/no-var-requires
import { getEngineName } from '@waha/config';

import {
  getBrowserExecutablePath,
  isChromeExecutablePath,
} from './core/abc/session.browser';
import { WAHAEngine } from './structures/enums.dto';
import {
  WAHABuildEnvironment,
  WAHAEnvironment,
} from './structures/environment.dto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');

export enum WAHAVersion {
  PLUS = 'PLUS',
  CORE = 'CORE',
}

export function getWAHAVersion(): WAHAVersion {
  // force core version if env variables set
  const waha_version = process.env.WAHA_VERSION;
  if (waha_version && waha_version === WAHAVersion.CORE) {
    return WAHAVersion.CORE;
  }

  // Check the plus directory exists
  const plusExists = fs.existsSync(`${__dirname}/plus`);
  if (plusExists) {
    return WAHAVersion.PLUS;
  }

  return WAHAVersion.CORE;
}

export function getWorker() {
  return { id: process.env.WAHA_WORKER_ID || null };
}

export function getBuild(): WAHABuildEnvironment {
  return {
    revision: process.env.WAHA_BUILD_REVISION || null,
    version: process.env.WAHA_BUILD_VERSION || null,
    image: process.env.WAHA_IMAGE_REFERENCE || null,
    digest: process.env.WAHA_IMAGE_DIGEST || null,
    source: process.env.WAHA_IMAGE_SOURCE || null,
  };
}

function getBrowser() {
  return getEngineName() === WAHAEngine.WEBJS ||
    getEngineName() === WAHAEngine.WPP
    ? getBrowserExecutablePath()
    : null;
}

function getPlatform() {
  return `${process.platform}/${process.arch}`;
}

export const VERSION: WAHAEnvironment = {
  version: '2026.7.2',
  engine: getEngineName(),
  tier: getWAHAVersion(),
  browser: getBrowser(),
  platform: getPlatform(),
  worker: getWorker(),
  build: getBuild(),
};

export const IsChrome = VERSION.browser
  ? isChromeExecutablePath(VERSION.browser)
  : false;

export { getEngineName };
