#!/bin/sh
set -eu

revision="${WAHA_BUILD_REVISION:-$(git rev-parse HEAD)}"
version="$(
  sed -n "s/^[[:space:]]*version: '\\([^']*\\)',[[:space:]]*$/\\1/p" \
    src/version.ts
)"

if [ -z "$version" ]; then
  echo "Unable to resolve the WAHA version from src/version.ts" >&2
  exit 1
fi

case "$revision" in
  *[!0-9a-f]*|'')
    echo "WAHA build revision must be a full lowercase hexadecimal Git SHA" >&2
    exit 1
    ;;
esac

if [ "${#revision}" -ne 40 ]; then
  echo "WAHA build revision must contain exactly 40 characters" >&2
  exit 1
fi

tag="gows-${version}-${revision}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$version"
    echo "revision=$revision"
    echo "tag=$tag"
  } >> "$GITHUB_OUTPUT"
fi

printf 'version=%s\nrevision=%s\ntag=%s\n' "$version" "$revision" "$tag"
