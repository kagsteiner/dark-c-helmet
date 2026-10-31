#!/bin/sh
# Builds the engine and the app and copies the result to the web server.
#
# Usage:  DEPLOY_TARGET=user@host:/var/www/dark-c-helmet sh webapp/deploy/deploy.sh
#
# The server must send the two cross-origin isolation headers (see nginx.conf here),
# otherwise the engine falls back to a single thread.
set -e
: "${DEPLOY_TARGET:?set DEPLOY_TARGET, e.g. user@host:/var/www/dark-c-helmet}"
cd "$(dirname "$0")/.."
sh engine/build.sh
npm run build
rsync -av --delete dist/ "$DEPLOY_TARGET/"
echo "Deployed to $DEPLOY_TARGET"
