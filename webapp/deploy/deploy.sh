#!/bin/sh
# Builds the engine and the app and copies the result to the web server.
#
# Usage:  DEPLOY_TARGET=user@host:/var/www/dark-c-helmet sh webapp/deploy/deploy.sh
#         (this project: DEPLOY_TARGET=vps:nodejs/chess, served at https://srv706843.hstgr.cloud/chess/)
#
# The server must send the two cross-origin isolation headers (see nginx.conf here),
# otherwise the engine falls back to a single thread.
set -e
: "${DEPLOY_TARGET:?set DEPLOY_TARGET, e.g. user@host:/var/www/dark-c-helmet}"
cd "$(dirname "$0")/.."
sh engine/build.sh
npm run build
# Readable for the web server, whatever the permissions on this machine (rsync -a keeps
# them; the macOS rsync has no --chmod).
chmod -R u=rwX,go=rX dist
# book/ holds the master opening book (tools/publish-book.ts): never touched by a deploy.
rsync -av --delete --exclude /book/ dist/ "$DEPLOY_TARGET/"
echo "Deployed to $DEPLOY_TARGET"
