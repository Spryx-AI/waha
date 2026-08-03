import { getBuild } from '@waha/version';

const BUILD_ENVIRONMENT_KEYS = [
  'WAHA_BUILD_REVISION',
  'WAHA_BUILD_VERSION',
  'WAHA_IMAGE_REFERENCE',
  'WAHA_IMAGE_DIGEST',
  'WAHA_IMAGE_SOURCE',
];

describe('getBuild', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    for (const key of BUILD_ENVIRONMENT_KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  it('returns immutable image metadata from the environment', () => {
    process.env.WAHA_BUILD_REVISION =
      '79233e09e34831b0ce23223d89b36e49b3024fd9';
    process.env.WAHA_BUILD_VERSION = '2026.7.2';
    process.env.WAHA_IMAGE_REFERENCE = 'registry.example/waha@sha256:123';
    process.env.WAHA_IMAGE_DIGEST = 'sha256:123';
    process.env.WAHA_IMAGE_SOURCE = 'https://github.com/Spryx-AI/waha';

    expect(getBuild()).toEqual({
      revision: '79233e09e34831b0ce23223d89b36e49b3024fd9',
      version: '2026.7.2',
      image: 'registry.example/waha@sha256:123',
      digest: 'sha256:123',
      source: 'https://github.com/Spryx-AI/waha',
    });
  });

  it('returns null for deployment metadata that was not injected', () => {
    for (const key of BUILD_ENVIRONMENT_KEYS) {
      delete process.env[key];
    }

    expect(getBuild()).toEqual({
      revision: null,
      version: null,
      image: null,
      digest: null,
      source: null,
    });
  });
});
